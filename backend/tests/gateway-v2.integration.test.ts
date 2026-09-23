// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Gateway sender contract v2 — test tích hợp THẬT: HTTP thật (Fastify listen + fetch),
 * PostgreSQL QA riêng, Redis QA riêng. Phiên Zalo là FAKE (không tài khoản/QR/tin Zalo thật).
 *
 * Chạy: GATEWAY_V2_QA=1 DATABASE_URL=<QA> REDIS_URL=<QA redis> npx vitest run tests/gateway-v2.integration.test.ts
 * Không có GATEWAY_V2_QA=1 → bỏ qua (bộ test unit thường không cần DB).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const QA = process.env.GATEWAY_V2_QA === '1';
process.env.GATEWAY_SENDER_ENC_KEY ||= randomBytes(32).toString('hex');
process.env.ZALO_SESSION_ENC_KEY ||= randomBytes(32).toString('hex');

type LoginEvent = import('../src/modules/gateway-v2/gateway-v2-types.js').LoginEvent;
type Provider = import('../src/modules/gateway-v2/zalo-session-provider.js').ZaloSessionProvider;
const QR_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Fake zca-js pool: mỗi nick một "phiên" riêng; ghi lại mọi lời gọi để chứng minh cách ly/không gửi trùng. */
class FakeZalo implements Provider {
  st = new Map<string, 'connected' | 'connecting' | 'qr_pending' | 'disconnected'>();
  session = new Map<string, string>(); // nickId → "cookie" riêng của nick (giả)
  hooks = new Map<string, (e: LoginEvent) => void>();
  sendCalls: { nickId: string; uid: string; text: string; at: number }[] = [];
  calls: string[] = [];
  terminated: { nickId: string; at: number }[] = [];
  mode = new Map<string, 'ok' | 'hang' | 'no-id' | 'throw' | 'slow'>();
  rateLimited = new Set<string>();
  private seq = 0;
  prisma: any; encode: any;

  startQrLogin(nickId: string, onEvent: (e: LoginEvent) => void) {
    this.calls.push(`startQrLogin:${nickId}`);
    this.hooks.set(nickId, onEvent); this.st.set(nickId, 'qr_pending');
    setImmediate(() => onEvent({ type: 'qr', image: QR_PNG }));
  }
  cancelLogin(nickId: string) { this.calls.push(`cancelLogin:${nickId}`); this.hooks.delete(nickId); if (this.st.get(nickId) === 'qr_pending') this.st.set(nickId, 'disconnected'); }
  status(nickId: string) { return this.st.get(nickId) ?? 'disconnected'; }
  async hasSavedSession(nickId: string) { return this.session.has(nickId); }
  async checkSendAllowed(nickId: string) { return !this.rateLimited.has(nickId); }
  async sendText(nickId: string, uid: string, text: string) {
    const { ProviderNotConnectedError } = await import('../src/modules/gateway-v2/zalo-session-provider.js');
    if (this.st.get(nickId) !== 'connected') throw new ProviderNotConnectedError();
    this.sendCalls.push({ nickId, uid, text, at: Date.now() });
    const m = this.mode.get(nickId) ?? 'ok'; const id = `zmsg-${++this.seq}`;
    if (m === 'throw') throw new Error('socket hang up');
    if (m === 'no-id') return { msgId: null };
    if (m === 'hang') { await new Promise((r) => setTimeout(r, 700)); return { msgId: id }; }
    if (m === 'slow') await new Promise((r) => setTimeout(r, 250));
    return { msgId: id };
  }
  async terminate(nickId: string) { this.calls.push(`terminate:${nickId}`); this.terminated.push({ nickId, at: Date.now() }); this.st.set(nickId, 'disconnected'); this.session.delete(nickId); this.hooks.delete(nickId); }
  restoreSaved(nickId: string) { this.calls.push(`restoreSaved:${nickId}`); if (this.session.has(nickId)) this.st.set(nickId, 'connected'); }

  // ── điều khiển test (mô phỏng người quét QR / Zalo) ──
  scan(nickId: string) { this.hooks.get(nickId)?.({ type: 'scanned', displayName: 'QA' }); }
  async connect(nickId: string, uid: string, name: string, phone: string) {
    // Mô phỏng pool: ghi uid/tên/phiên (mã hoá) vào đúng nick, rồi báo connected.
    await this.prisma.zaloAccount.update({ where: { id: nickId }, data: { zaloUid: uid, displayName: name, phone, status: 'connected', sessionData: this.encode({ cookie: [`c-${nickId}`], imei: `imei-${nickId}`, userAgent: 'qa' }) } });
    this.st.set(nickId, 'connected'); this.session.set(nickId, `cookie-${nickId}`);
    const h = this.hooks.get(nickId); this.hooks.delete(nickId); h?.({ type: 'connected', zaloUid: uid });
  }
  expire(nickId: string) { const h = this.hooks.get(nickId); this.hooks.delete(nickId); this.st.set(nickId, 'disconnected'); h?.({ type: 'expired' }); }
  fail(nickId: string) { const h = this.hooks.get(nickId); this.hooks.delete(nickId); this.st.set(nickId, 'disconnected'); h?.({ type: 'failed', code: 'LOGIN_ERROR' }); }
  /** Mô phỏng khởi động lại tiến trình: mọi phiên rơi, rồi từng nick tự nối lại bằng phiên CỦA NÓ. */
  restart() { this.hooks.clear(); for (const k of this.st.keys()) this.st.set(k, this.session.has(k) ? 'connected' : 'disconnected'); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean> | boolean, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(25); } throw new Error('timeout waiting'); }

describe.skipIf(!QA)('Gateway sender v2 (HTTP thật + Postgres/Redis QA, Zalo giả)', () => {
  let prisma: any; let app: any; let base = ''; let signV2: any; let service: any;
  const fake = new FakeZalo();
  const store = { down: false };
  const orgs: string[] = [];
  type Client = { clientId: string; key: string; orgId: string; accounts: string[] };
  const A: Client = { clientId: `qa-a-${randomUUID().slice(0, 6)}`, key: '', orgId: '', accounts: [] };
  const B: Client = { clientId: `qa-b-${randomUUID().slice(0, 6)}`, key: '', orgId: '', accounts: [] };
  const nickOf = async (acc: string) => (await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: acc } })).zaloAccountId as string;

  async function call(c: Client, method: 'GET' | 'POST', path: string, accountId: string, body?: unknown, tweak: { raw?: string; ts?: number; nonce?: string; key?: string; tamper?: boolean } = {}) {
    const raw = tweak.raw ?? (method === 'GET' ? '' : JSON.stringify(body ?? {}));
    const ts = String(tweak.ts ?? Date.now()); const nonce = tweak.nonce ?? randomUUID();
    const sig = signV2(tweak.key ?? c.key, method, path, ts, nonce, raw);
    const res = await fetch(base + path, { method, body: method === 'GET' ? undefined : (tweak.tamper ? raw.replace('Nhắc', 'Nhac') : raw), headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      'x-gateway-client-id': c.clientId, 'x-gateway-timestamp': ts, 'x-gateway-nonce': nonce, 'x-gateway-account-id': accountId, 'x-gateway-signature': sig,
    } });
    return { status: res.status, body: await res.json().catch(() => ({})) as any, nonce, ts };
  }
  const send = (c: Client, acc: string, o: { id?: string; phone?: string; content?: string; ref?: string } = {}) => {
    const id = o.id ?? randomUUID();
    return call(c, 'POST', '/internal/v1/messages/send-known-contact', acc, { deliveryAttemptId: id, idempotencyKey: id, channelAccountId: acc, phoneE164: o.phone ?? '+84901000001', externalReferenceId: o.ref ?? 'appointment:QA-1', content: o.content ?? 'Nhắc lịch khám QA' });
  };
  /** Đăng nhập QR đầy đủ (giả) cho một account → CONNECTED. */
  async function loginConnected(c: Client, acc: string, uid: string, phone: string) {
    const s = await call(c, 'POST', `/internal/v1/accounts/${acc}/login/start`, acc);
    expect(s.status).toBe(200);
    const att = await prisma.gatewayLoginAttempt.findUnique({ where: { id: s.body.loginId } });
    const nick = att.provisionalZaloAccountId ?? (await nickOf(acc));
    await fake.connect(nick, uid, `Nick ${uid}`, phone);
    await until(async () => (await call(c, 'GET', `/internal/v1/accounts/${acc}/login/${s.body.loginId}`, acc)).body.status === 'CONNECTED');
    return nick;
  }
  async function seedRecipient(orgId: string, nickId: string, phone: string, kind: 'friend' | 'conversation' | 'pending') {
    const contact = (await prisma.contact.findFirst({ where: { orgId, phone } })) ?? await prisma.contact.create({ data: { orgId, phone, fullName: 'Khách QA' } });
    await prisma.friend.create({ data: { orgId, contactId: contact.id, zaloAccountId: nickId, zaloUidInNick: `uid-${phone}-${nickId.slice(0, 6)}`,
      friendshipStatus: kind === 'friend' ? 'accepted' : kind === 'pending' ? 'pending_sent' : 'none', hasConversation: kind === 'conversation' } });
  }

  beforeAll(async () => {
    ({ prisma } = await import('../src/shared/database/prisma-client.js'));
    ({ signV2 } = await import('../src/modules/gateway-v2/gateway-v2-auth.js'));
    const { redisNonceStore } = await import('../src/modules/gateway-v2/gateway-v2-auth.js');
    const { encodeZaloSession } = await import('../src/shared/zalo-session-codec.js');
    const { registerClient, registerAccount } = await import('../src/modules/gateway-v2/gateway-v2-registry.js');
    const { GatewayV2Service } = await import('../src/modules/gateway-v2/gateway-v2-service.js');
    const { gatewaySenderRoutes } = await import('../src/modules/api/gateway-sender-routes.js');
    const Fastify = (await import('fastify')).default;
    fake.prisma = prisma; fake.encode = encodeZaloSession;
    for (const c of [A, B]) {
      const org = await prisma.organization.create({ data: { name: `QA Gateway ${c.clientId}` } }); orgs.push(org.id); c.orgId = org.id;
      const owner = await prisma.user.create({ data: { orgId: org.id, passwordHash: 'x', fullName: 'Gateway service', role: 'owner', email: `${c.clientId}@qa.invalid` } });
      c.key = (await registerClient({ clientId: c.clientId, orgId: org.id, ownerUserId: owner.id })).signingKey;
      for (let i = 0; i < 2; i++) { const id = randomUUID(); await registerAccount(c.clientId, id); c.accounts.push(id); }
    }
    service = new GatewayV2Service(fake, { sendTimeoutMs: 300, qrWaitMs: 2000 });
    app = Fastify({ logger: false });
    await app.register(gatewaySenderRoutes, { service, nonceStore: { claim: (c: string, n: string) => (store.down ? Promise.reject(new Error('down')) : redisNonceStore.claim(c, n)) } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await app?.close();
    const clients = await prisma.gatewaySenderClient.findMany({ where: { clientId: { in: [A.clientId, B.clientId] } } });
    const refs = clients.map((c: any) => c.id);
    await prisma.gatewayDeliveryAttempt.deleteMany({ where: { clientRef: { in: refs } } });
    await prisma.gatewayChannelAccount.deleteMany({ where: { clientRef: { in: refs } } });
    await prisma.gatewaySenderClient.deleteMany({ where: { id: { in: refs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    const { closeRedis } = await import('../src/shared/redis-client.js'); await closeRedis();
    await prisma.$disconnect();
  });
  beforeEach(() => { store.down = false; });

  // ─────────────── A. Authentication ───────────────
  describe('A. xác thực', () => {
    it('chữ ký đúng → vào được; sai chữ ký / body bị sửa / timestamp cũ / nonce lặp → 401', async () => {
      const acc = A.accounts[0];
      expect((await call(A, 'POST', `/internal/v1/accounts/${acc}/pause`, acc)).status).toBe(200);
      expect((await call(A, 'POST', `/internal/v1/accounts/${acc}/pause`, acc, {}, { key: randomBytes(32).toString('base64url') })).status).toBe(401);
      expect((await call(A, 'POST', '/internal/v1/messages/send-known-contact', acc, { content: 'Nhắc' }, { tamper: true })).status).toBe(401);
      expect((await call(A, 'POST', `/internal/v1/accounts/${acc}/pause`, acc, {}, { ts: Date.now() - 301_000 })).status).toBe(401);
      const nonce = randomUUID();
      expect((await call(A, 'POST', `/internal/v1/accounts/${acc}/pause`, acc, {}, { nonce })).status).toBe(200);
      expect((await call(A, 'POST', `/internal/v1/accounts/${acc}/pause`, acc, {}, { nonce })).status).toBe(401);
    });
    it('chữ ký trên raw body: JSON cùng nghĩa nhưng khác chuỗi (khoảng trắng) mà ký chuỗi khác → 401', async () => {
      const acc = A.accounts[0]; const raw = '{"phoneE164":"+84901000001"}';
      const ok = await call(A, 'POST', `/internal/v1/accounts/${acc}/recipient-eligibility`, acc, undefined, { raw });
      expect(ok.status).toBe(200);
      const ts = String(Date.now()); const nonce = randomUUID();
      const sig = signV2(A.key, 'POST', `/internal/v1/accounts/${acc}/recipient-eligibility`, ts, nonce, raw);
      const res = await fetch(`${base}/internal/v1/accounts/${acc}/recipient-eligibility`, { method: 'POST', body: '{ "phoneE164": "+84901000001" }', headers: { 'content-type': 'application/json', 'x-gateway-client-id': A.clientId, 'x-gateway-timestamp': ts, 'x-gateway-nonce': nonce, 'x-gateway-account-id': acc, 'x-gateway-signature': sig } });
      expect(res.status).toBe(401);
    });
    it('replay store lỗi → 503 REPLAY_STORE_UNAVAILABLE (fail closed)', async () => {
      store.down = true;
      const r = await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/pause`, A.accounts[0]);
      expect(r.status).toBe(503); expect(r.body.code).toBe('REPLAY_STORE_UNAVAILABLE');
    });
    it('header account khác path → 401; client A chạm account của B và id ngẫu nhiên → cùng 404', async () => {
      expect((await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/pause`, A.accounts[1])).status).toBe(401);
      const foreign = await call(A, 'POST', `/internal/v1/accounts/${B.accounts[0]}/pause`, B.accounts[0]);
      const rnd = randomUUID(); const random = await call(A, 'POST', `/internal/v1/accounts/${rnd}/pause`, rnd);
      expect(foreign.status).toBe(404); expect(random.status).toBe(404); expect(foreign.body).toEqual(random.body);
      for (const path of ['login/start', 'resume', 'disconnect', 'recipient-eligibility']) {
        const f = await call(A, 'POST', `/internal/v1/accounts/${B.accounts[1]}/${path}`, B.accounts[1], { phoneE164: '+84901000001' });
        expect(f.status).toBe(404); expect(f.body).toEqual(random.body);
      }
      const sendForeign = await send(A, B.accounts[0]);
      expect(sendForeign.status).toBe(404); expect(sendForeign.body).toEqual(random.body);
      expect((await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: B.accounts[0] } })).paused).toBe(false);
      await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/resume`, A.accounts[0]); // dọn trạng thái pause từ test trước (sẽ 409 vì chưa connect)
      await prisma.gatewayChannelAccount.update({ where: { channelAccountId: A.accounts[0] }, data: { paused: false } });
    });
    it('một channelAccountId không đăng ký được cho client thứ hai', async () => {
      const { registerAccount } = await import('../src/modules/gateway-v2/gateway-v2-registry.js');
      await expect(registerAccount(B.clientId, A.accounts[0])).rejects.toThrow();
    });
    it('Gateway tự đăng ký account qua API có ký: idempotent, đồng thời, id của client khác = 404 như id lạ', async () => {
      const id = randomUUID();
      const r1 = await call(A, 'POST', `/internal/v1/accounts/${id}/register`, id);
      expect(r1.status).toBe(200); expect(r1.body).toEqual({ channelAccountId: id, status: 'PENDING_LOGIN', capabilities: { contractVersion: 2, qrLogin: true, recipientPreflight: true, idempotentSend: true, remoteControl: true } });
      expect((await call(A, 'POST', `/internal/v1/accounts/${id}/register`, id)).body).toEqual(r1.body);
      const id2 = randomUUID();
      const many = await Promise.all(Array.from({ length: 5 }, () => call(A, 'POST', `/internal/v1/accounts/${id2}/register`, id2)));
      expect(many.every((r) => r.status === 200)).toBe(true);
      expect(await prisma.gatewayChannelAccount.count({ where: { channelAccountId: id2 } })).toBe(1);
      const stolen = await call(B, 'POST', `/internal/v1/accounts/${id}/register`, id);
      const bad = await call(B, 'POST', '/internal/v1/accounts/not-a-uuid/register', randomUUID());
      const rnd = randomUUID(); await prisma.gatewayChannelAccount.create({ data: { clientRef: (await prisma.gatewaySenderClient.findUnique({ where: { clientId: A.clientId } })).id, channelAccountId: rnd, status: 'REVOKED', revokedAt: new Date() } });
      const revoked = await call(A, 'POST', `/internal/v1/accounts/${rnd}/register`, rnd);
      expect(stolen.status).toBe(404); expect(revoked.status).toBe(404); expect(bad.status).toBe(401);
      expect(stolen.body).toEqual(revoked.body);
      expect((await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: id } })).clientRef).toBe((await prisma.gatewaySenderClient.findUnique({ where: { clientId: A.clientId } })).id);
      await prisma.gatewayChannelAccount.deleteMany({ where: { channelAccountId: { in: [id, id2, rnd] } } });
    });
  });

  // ─────────────── C. QR ───────────────
  describe('C. QR theo account', () => {
    it('start → PENDING → SCANNED → CONNECTED; không trả cookie/phiên; số đã che', async () => {
      const acc = A.accounts[0];
      const s = await call(A, 'POST', `/internal/v1/accounts/${acc}/login/start`, acc);
      expect(s.status).toBe(200); expect(Object.keys(s.body).sort()).toEqual(['expiresAt', 'loginId', 'qrImage']);
      expect(s.body.qrImage).toMatch(/^data:image\/png;base64,/);
      expect(new Date(s.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(180_000);
      const path = `/internal/v1/accounts/${acc}/login/${s.body.loginId}`;
      expect((await call(A, 'GET', path, acc)).body).toEqual({ status: 'PENDING' });
      const att = await prisma.gatewayLoginAttempt.findUnique({ where: { id: s.body.loginId } });
      fake.scan(att.provisionalZaloAccountId);
      await until(async () => (await call(A, 'GET', path, acc)).body.status === 'SCANNED');
      await fake.connect(att.provisionalZaloAccountId, 'zuid-a0', 'Nick A0', '0901111222');
      await until(async () => (await call(A, 'GET', path, acc)).body.status === 'CONNECTED');
      const done = await call(A, 'GET', path, acc);
      expect(done.body).toEqual({ status: 'CONNECTED', displayName: 'Nick A0', phoneMasked: '090****222' });
      expect(JSON.stringify(done.body) + JSON.stringify(s.body)).not.toMatch(/cookie|imei|userAgent|0901111222|session/i);
      const nick = await prisma.zaloAccount.findUnique({ where: { id: att.provisionalZaloAccountId } });
      expect(JSON.stringify(nick.sessionData)).not.toMatch(/cookie|imei/); // phiên lưu dạng mã hoá
      expect(nick.sessionData.__enc).toBe('aesgcm:v1');
    });
    it('QR mới vô hiệu QR cũ; QR hết hạn / thất bại không để lại nick rác', async () => {
      const acc = A.accounts[1];
      const first = await call(A, 'POST', `/internal/v1/accounts/${acc}/login/start`, acc);
      const firstAtt = await prisma.gatewayLoginAttempt.findUnique({ where: { id: first.body.loginId } });
      const second = await call(A, 'POST', `/internal/v1/accounts/${acc}/login/start`, acc);
      expect((await call(A, 'GET', `/internal/v1/accounts/${acc}/login/${first.body.loginId}`, acc)).body.status).toBe('EXPIRED');
      expect(await prisma.zaloAccount.findUnique({ where: { id: firstAtt.provisionalZaloAccountId } })).toBeNull();
      const secondAtt = await prisma.gatewayLoginAttempt.findUnique({ where: { id: second.body.loginId } });
      fake.expire(secondAtt.provisionalZaloAccountId);
      await until(async () => (await call(A, 'GET', `/internal/v1/accounts/${acc}/login/${second.body.loginId}`, acc)).body.status === 'EXPIRED');
      expect(await prisma.zaloAccount.findUnique({ where: { id: secondAtt.provisionalZaloAccountId } })).toBeNull();
      const third = await call(A, 'POST', `/internal/v1/accounts/${acc}/login/start`, acc);
      const thirdAtt = await prisma.gatewayLoginAttempt.findUnique({ where: { id: third.body.loginId } });
      fake.fail(thirdAtt.provisionalZaloAccountId);
      await until(async () => (await call(A, 'GET', `/internal/v1/accounts/${acc}/login/${third.body.loginId}`, acc)).body.status === 'FAILED');
      expect(await prisma.zaloAccount.findUnique({ where: { id: thirdAtt.provisionalZaloAccountId } })).toBeNull();
      expect((await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: acc } })).zaloAccountId).toBeNull();
    });
    it('QR quá hạn theo thời gian → EXPIRED khi hỏi trạng thái', async () => {
      const acc = A.accounts[1];
      const s = await call(A, 'POST', `/internal/v1/accounts/${acc}/login/start`, acc);
      await prisma.gatewayLoginAttempt.update({ where: { id: s.body.loginId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call(A, 'GET', `/internal/v1/accounts/${acc}/login/${s.body.loginId}`, acc)).body.status).toBe('EXPIRED');
    });
    it('loginId của account khác (cùng client hoặc client khác) → 404', async () => {
      const s = await call(A, 'POST', `/internal/v1/accounts/${A.accounts[1]}/login/start`, A.accounts[1]);
      expect((await call(A, 'GET', `/internal/v1/accounts/${A.accounts[0]}/login/${s.body.loginId}`, A.accounts[0])).status).toBe(404);
      expect((await call(B, 'GET', `/internal/v1/accounts/${B.accounts[0]}/login/${s.body.loginId}`, B.accounts[0])).status).toBe(404);
      const att = await prisma.gatewayLoginAttempt.findUnique({ where: { id: s.body.loginId } });
      fake.expire(att.provisionalZaloAccountId);
    });
  });

  // ─────────────── B. Multi-account isolation ───────────────
  describe('B. cách ly nhiều account / nhiều client', () => {
    it('2 client × 2 account kết nối, mỗi account một nick + phiên riêng', async () => {
      await loginConnected(A, A.accounts[1], 'zuid-a1', '0902222333');
      await loginConnected(B, B.accounts[0], 'zuid-b0', '0903333444');
      await loginConnected(B, B.accounts[1], 'zuid-b1', '0904444555');
      const maps = await prisma.gatewayChannelAccount.findMany({ where: { channelAccountId: { in: [...A.accounts, ...B.accounts] } } });
      const nicks = maps.map((m: any) => m.zaloAccountId);
      expect(new Set(nicks).size).toBe(4); expect(nicks.every(Boolean)).toBe(true);
      expect(new Set(nicks.map((n: string) => fake.session.get(n))).size).toBe(4);
      for (const c of [A, B]) for (const acc of c.accounts) {
        const nick = await prisma.zaloAccount.findUnique({ where: { id: await nickOf(acc) } });
        expect(nick.orgId).toBe(c.orgId);
      }
      for (const [c, i, phone] of [[A, 0, '+84901000001'], [A, 1, '+84901000001'], [B, 0, '+84901000001'], [B, 1, '+84901000001']] as const) {
        await seedRecipient(c.orgId, await nickOf(c.accounts[i]), phone, 'friend');
      }
    });
    it('gửi qua account nào thì đúng nick đó gọi Zalo', async () => {
      fake.sendCalls = [];
      for (const [c, acc] of [[A, A.accounts[0]], [A, A.accounts[1]], [B, B.accounts[0]], [B, B.accounts[1]]] as const) {
        const r = await send(c, acc); expect(r.status).toBe(200); expect(r.body.delivery).toBe('SENT');
      }
      expect(fake.sendCalls.map((s) => s.nickId)).toEqual([await nickOf(A.accounts[0]), await nickOf(A.accounts[1]), await nickOf(B.accounts[0]), await nickOf(B.accounts[1])]);
    });
    it('pause A0 không ảnh hưởng A1/B; resume trả lại', async () => {
      expect((await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/pause`, A.accounts[0])).status).toBe(200);
      expect((await send(A, A.accounts[0])).body).toEqual({ delivery: 'NOT_SENT', code: 'ACCOUNT_PAUSED' });
      expect((await send(A, A.accounts[1])).body.delivery).toBe('SENT');
      expect((await send(B, B.accounts[0])).body.delivery).toBe('SENT');
      expect(fake.st.get(await nickOf(A.accounts[0]))).toBe('connected'); // pause không xoá phiên
      expect((await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/resume`, A.accounts[0])).status).toBe(200);
      expect((await send(A, A.accounts[0])).body.delivery).toBe('SENT');
    });
    it('login lại A1 (cùng tài khoản Zalo) không thay phiên của B; tài khoản Zalo khác bị từ chối', async () => {
      const b0Session = fake.session.get(await nickOf(B.accounts[0]));
      const nickA1 = await nickOf(A.accounts[1]);
      const s = await call(A, 'POST', `/internal/v1/accounts/${A.accounts[1]}/login/start`, A.accounts[1]);
      await fake.connect(nickA1, 'zuid-a1', 'Nick A1', '0902222333');
      await until(async () => (await call(A, 'GET', `/internal/v1/accounts/${A.accounts[1]}/login/${s.body.loginId}`, A.accounts[1])).body.status === 'CONNECTED');
      expect(await nickOf(A.accounts[1])).toBe(nickA1); // reconnect dùng CÙNG mapping/nick
      expect(fake.session.get(await nickOf(B.accounts[0]))).toBe(b0Session);
      const s2 = await call(A, 'POST', `/internal/v1/accounts/${A.accounts[1]}/login/start`, A.accounts[1]);
      await fake.connect(nickA1, 'zuid-KHAC', 'Người khác', '0909999999');
      await until(async () => (await call(A, 'GET', `/internal/v1/accounts/${A.accounts[1]}/login/${s2.body.loginId}`, A.accounts[1])).body.status === 'FAILED');
      expect((await prisma.zaloAccount.findUnique({ where: { id: nickA1 } })).zaloUid).toBe('zuid-a1');
      await loginConnected(A, A.accounts[1], 'zuid-a1', '0902222333');
    });
    it('disconnect B1 chỉ dừng/xoá phiên B1', async () => {
      const nickB1 = await nickOf(B.accounts[1]);
      const mark = fake.terminated.length;
      expect((await call(B, 'POST', `/internal/v1/accounts/${B.accounts[1]}/disconnect`, B.accounts[1])).status).toBe(200);
      expect(fake.terminated.slice(mark).map((t) => t.nickId)).toEqual([nickB1]);
      expect(fake.session.has(nickB1)).toBe(false);
      expect((await send(B, B.accounts[1])).body).toEqual({ delivery: 'NOT_SENT', code: 'ACCOUNT_UNAVAILABLE' });
      expect((await send(B, B.accounts[0])).body.delivery).toBe('SENT');
      expect((await send(A, A.accounts[0])).body.delivery).toBe('SENT');
      const map = await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: B.accounts[1] } });
      expect(map.status).toBe('DISCONNECTED'); expect(map.sessionVersion).toBeGreaterThanOrEqual(2);
    });
    it('restart: mỗi account khôi phục đúng phiên của nó; QR đang mở → EXPIRED', async () => {
      const before = await Promise.all([...A.accounts, B.accounts[0]].map(nickOf));
      const s = await call(B, 'POST', `/internal/v1/accounts/${B.accounts[1]}/login/start`, B.accounts[1]);
      fake.restart();
      const { GatewayV2Service } = await import('../src/modules/gateway-v2/gateway-v2-service.js');
      expect(await new GatewayV2Service(fake).recoverOnBoot()).toBeGreaterThanOrEqual(1);
      expect((await prisma.gatewayLoginAttempt.findUnique({ where: { id: s.body.loginId } })).status).toBe('EXPIRED');
      expect(await Promise.all([...A.accounts, B.accounts[0]].map(nickOf))).toEqual(before);
      fake.sendCalls = [];
      expect((await send(A, A.accounts[1])).body.delivery).toBe('SENT');
      expect(fake.sendCalls[0].nickId).toBe(before[1]);
    });
  });

  // ─────────────── D. Preflight ───────────────
  describe('D. preflight người nhận (chỉ đọc)', () => {
    it('bạn bè / đã có hội thoại / không tìm thấy / lời mời chưa chấp nhận / account không sẵn sàng; không ghi gì', async () => {
      const acc = A.accounts[0]; const nick = await nickOf(acc);
      await seedRecipient(A.orgId, nick, '+84901000002', 'conversation');
      await seedRecipient(A.orgId, nick, '+84901000003', 'pending');
      const counts = async () => [await prisma.contact.count(), await prisma.friend.count(), await prisma.conversation.count()];
      const before = await counts(); const calls = fake.sendCalls.length; const log = fake.calls.length;
      const q = (p: string) => call(A, 'POST', `/internal/v1/accounts/${acc}/recipient-eligibility`, acc, { phoneE164: p });
      expect((await q('+84901000001')).body.result).toBe('ELIGIBLE_EXISTING_FRIEND');
      expect((await q('+84901000002')).body.result).toBe('ELIGIBLE_EXISTING_CONVERSATION');
      expect((await q('+84901000003')).body.result).toBe('NOT_FOUND');
      expect((await q('+84909999999')).body.result).toBe('NOT_FOUND');
      expect((await call(B, 'POST', `/internal/v1/accounts/${B.accounts[1]}/recipient-eligibility`, B.accounts[1], { phoneE164: '+84901000001' })).body.result).toBe('ACCOUNT_UNAVAILABLE');
      expect(await counts()).toEqual(before);
      expect(fake.sendCalls.length).toBe(calls); expect(fake.calls.length).toBe(log);
      // Không được thấy khách của account khác dù cùng số.
      await seedRecipient(A.orgId, await nickOf(A.accounts[1]), '+84901000004', 'friend');
      expect((await q('+84901000004')).body.result).toBe('NOT_FOUND');
    });
    it('gửi tới người không phải bạn/hội thoại của đúng nick → NOT_SENT RECIPIENT_NOT_FOUND, không gọi Zalo', async () => {
      const n = fake.sendCalls.length;
      expect((await send(A, A.accounts[0], { phone: '+84901000003' })).body).toEqual({ delivery: 'NOT_SENT', code: 'RECIPIENT_NOT_FOUND' });
      expect((await send(A, A.accounts[0], { phone: '+84901000004' })).body).toEqual({ delivery: 'NOT_SENT', code: 'RECIPIENT_NOT_FOUND' });
      expect(fake.sendCalls.length).toBe(n);
    });
  });

  // ─────────────── E. Idempotency ───────────────
  describe('E. idempotency', () => {
    it('10 request đồng thời cùng deliveryAttemptId → đúng 1 lần gọi Zalo', async () => {
      fake.mode.set(await nickOf(A.accounts[0]), 'slow');
      const id = randomUUID(); const n = fake.sendCalls.length;
      const rs = await Promise.all(Array.from({ length: 10 }, () => send(A, A.accounts[0], { id })));
      fake.mode.delete(await nickOf(A.accounts[0]));
      expect(fake.sendCalls.length - n).toBe(1);
      const sent = rs.filter((r) => r.body.delivery === 'SENT');
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(rs.every((r) => r.body.delivery === 'SENT' || r.body.delivery === 'UNKNOWN')).toBe(true);
      const again = await send(A, A.accounts[0], { id });
      expect(again.body).toEqual({ delivery: 'SENT', providerMessageId: sent[0].body.providerMessageId });
      expect(fake.sendCalls.length - n).toBe(1);
    });
    it('cùng ID nhưng nội dung khác → 409 IDEMPOTENCY_CONFLICT, không gửi', async () => {
      const id = randomUUID(); await send(A, A.accounts[0], { id }); const n = fake.sendCalls.length;
      const r = await send(A, A.accounts[0], { id, content: 'Nội dung khác' });
      expect(r.status).toBe(409); expect(r.body.code).toBe('IDEMPOTENCY_CONFLICT'); expect(fake.sendCalls.length).toBe(n);
    });
    it('crash sau SENDING (chưa có kết quả) → UNKNOWN, không gửi lại mù', async () => {
      const id = randomUUID(); const acc = await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: A.accounts[0] } });
      const { sha256Hex } = await import('../src/modules/gateway-v2/gateway-v2-auth.js');
      const hash = sha256Hex(JSON.stringify([A.accounts[0], '84901000001', 'Nhắc lịch khám QA', 'appointment:QA-1']));
      await prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: acc.id, deliveryAttemptId: id, requestHash: hash, state: 'SENDING', sendingAt: new Date(), sendCalls: 1 } });
      const n = fake.sendCalls.length;
      expect((await send(A, A.accounts[0], { id })).body).toEqual({ delivery: 'UNKNOWN', code: 'PREVIOUS_OUTCOME_UNKNOWN' });
      expect(fake.sendCalls.length).toBe(n);
    });
    it('timeout → UNKNOWN; Zalo xác nhận muộn kèm msgId → lần hỏi lại trả SENT, không gửi thêm', async () => {
      const nick = await nickOf(A.accounts[0]); fake.mode.set(nick, 'hang');
      const id = randomUUID(); const n = fake.sendCalls.length;
      expect((await send(A, A.accounts[0], { id })).body).toEqual({ delivery: 'UNKNOWN', code: 'ZALO_TIMEOUT' });
      fake.mode.delete(nick);
      await until(async () => (await prisma.gatewayDeliveryAttempt.findFirst({ where: { deliveryAttemptId: id } })).state === 'SENT');
      expect((await send(A, A.accounts[0], { id })).body.delivery).toBe('SENT');
      expect(fake.sendCalls.length - n).toBe(1);
    });
    it('2xx thiếu message ID → UNKNOWN; lỗi SDK sau khi gọi → UNKNOWN', async () => {
      const nick = await nickOf(A.accounts[0]);
      fake.mode.set(nick, 'no-id'); expect((await send(A, A.accounts[0])).body).toEqual({ delivery: 'UNKNOWN', code: 'SENT_WITHOUT_MESSAGE_ID' });
      fake.mode.set(nick, 'throw'); expect((await send(A, A.accounts[0])).body).toEqual({ delivery: 'UNKNOWN', code: 'ZALO_SEND_ERROR' });
      fake.mode.delete(nick);
    });
    it('account không sẵn sàng / giới hạn tốc độ trước khi gửi → NOT_SENT; lần sau cùng ID được gửi (chưa từng gửi)', async () => {
      const nick = await nickOf(A.accounts[0]); const id = randomUUID(); const n = fake.sendCalls.length;
      fake.rateLimited.add(nick);
      expect((await send(A, A.accounts[0], { id })).body).toEqual({ delivery: 'NOT_SENT', code: 'RATE_LIMITED' });
      fake.rateLimited.delete(nick); fake.st.set(nick, 'disconnected');
      expect((await send(A, A.accounts[0], { id })).body).toEqual({ delivery: 'NOT_SENT', code: 'ACCOUNT_UNAVAILABLE' });
      fake.st.set(nick, 'connected');
      expect((await send(A, A.accounts[0], { id })).body.delivery).toBe('SENT');
      expect(fake.sendCalls.length - n).toBe(1);
    });
    it('hết phiên (không còn session) → NOT_SENT RELOGIN_REQUIRED', async () => {
      const nick = await nickOf(A.accounts[1]); const saved = fake.session.get(nick)!;
      fake.st.set(nick, 'disconnected'); fake.session.delete(nick);
      expect((await send(A, A.accounts[1])).body).toEqual({ delivery: 'NOT_SENT', code: 'RELOGIN_REQUIRED' });
      fake.session.set(nick, saved); fake.st.set(nick, 'connected');
    });
    it('body không hợp lệ → 400 NOT_SENT INVALID_REQUEST; header account khác body → 401', async () => {
      const id = randomUUID();
      const bad = await call(A, 'POST', '/internal/v1/messages/send-known-contact', A.accounts[0], { deliveryAttemptId: id, idempotencyKey: randomUUID(), channelAccountId: A.accounts[0], phoneE164: '+84901000001', externalReferenceId: 'x', content: 'a' });
      expect(bad.status).toBe(400); expect(bad.body).toEqual({ delivery: 'NOT_SENT', code: 'INVALID_REQUEST' });
      const mism = await call(A, 'POST', '/internal/v1/messages/send-known-contact', A.accounts[0], { deliveryAttemptId: id, idempotencyKey: id, channelAccountId: A.accounts[1], phoneE164: '+84901000001', externalReferenceId: 'x', content: 'a' });
      expect(mism.status).toBe(401);
    });
    it('DB chặn trùng (client, deliveryAttemptId) và SENT thiếu providerMessageId', async () => {
      const acc = await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: A.accounts[0] } }); const id = randomUUID();
      await prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: acc.id, deliveryAttemptId: id, requestHash: 'h' } });
      await expect(prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: acc.id, deliveryAttemptId: id, requestHash: 'h' } })).rejects.toThrow();
      await expect(prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: acc.id, deliveryAttemptId: randomUUID(), requestHash: 'h', state: 'SENT' } })).rejects.toThrow();
      const accB = await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: B.accounts[0] } });
      await expect(prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: accB.id, deliveryAttemptId: randomUUID(), requestHash: 'h' } })).rejects.toThrow();
    });
    it('giữ bản ghi >= 7 ngày', async () => {
      const acc = await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: A.accounts[0] } });
      const old = randomUUID(); const recent = randomUUID();
      await prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: acc.id, deliveryAttemptId: old, requestHash: 'h', state: 'SENT', providerMessageId: 'm', createdAt: new Date(Date.now() - 8 * 86_400_000) } });
      await prisma.gatewayDeliveryAttempt.create({ data: { clientRef: acc.clientRef, accountRef: acc.id, deliveryAttemptId: recent, requestHash: 'h', state: 'SENT', providerMessageId: 'm', createdAt: new Date(Date.now() - 6.5 * 86_400_000) } });
      await service.purgeIdempotency(1); // yêu cầu 1 ngày vẫn bị nâng lên 7
      expect(await prisma.gatewayDeliveryAttempt.findFirst({ where: { deliveryAttemptId: old } })).toBeNull();
      expect(await prisma.gatewayDeliveryAttempt.findFirst({ where: { deliveryAttemptId: recent } })).not.toBeNull();
    });
  });

  // ─────────────── F. Remote control ───────────────
  describe('F. pause / resume / disconnect', () => {
    it('pause/resume thật sự đổi trạng thái → ghi sự kiện health PAUSED / CONNECTED (không lặp khi gọi lại)', async () => {
      const acc = await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: A.accounts[0] } });
      const count = (s: string) => prisma.gatewayHealthOutbox.count({ where: { accountRef: acc.id, status: s } });
      const [p0, c0] = [await count('PAUSED'), await count('CONNECTED')];
      await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/pause`, A.accounts[0]);
      await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/pause`, A.accounts[0]);
      expect(await count('PAUSED')).toBe(p0 + 1);
      expect((await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/resume`, A.accounts[0])).status).toBe(200);
      await call(A, 'POST', `/internal/v1/accounts/${A.accounts[0]}/resume`, A.accounts[0]);
      expect(await count('CONNECTED')).toBe(c0 + 1);
    });
    it('resume khi hết phiên → 409 RELOGIN_REQUIRED', async () => {
      const r = await call(B, 'POST', `/internal/v1/accounts/${B.accounts[1]}/resume`, B.accounts[1]);
      expect(r.status).toBe(409);
      await prisma.gatewayChannelAccount.update({ where: { channelAccountId: B.accounts[1] }, data: { status: 'CONNECTED' } });
      const r2 = await call(B, 'POST', `/internal/v1/accounts/${B.accounts[1]}/resume`, B.accounts[1]);
      expect(r2.status).toBe(409); expect(r2.body.code).toBe('RELOGIN_REQUIRED');
    });
    it('send và disconnect đồng thời: lời gọi đang chạy xong trước, disconnect sau; không có send mới sau disconnect', async () => {
      const nick = await nickOf(A.accounts[1]); fake.mode.set(nick, 'slow');
      const sending = send(A, A.accounts[1]);
      await sleep(30);
      const disc = call(A, 'POST', `/internal/v1/accounts/${A.accounts[1]}/disconnect`, A.accounts[1]);
      const [s, d] = await Promise.all([sending, disc]);
      expect(s.body.delivery).toBe('SENT'); expect(d.status).toBe(200);
      const sentAt = fake.sendCalls.filter((c) => c.nickId === nick).pop()!.at;
      const termAt = fake.terminated.filter((t) => t.nickId === nick).pop()!.at;
      expect(termAt).toBeGreaterThanOrEqual(sentAt + 200);
      const n = fake.sendCalls.length;
      expect((await send(A, A.accounts[1])).body).toEqual({ delivery: 'NOT_SENT', code: 'ACCOUNT_UNAVAILABLE' });
      expect(fake.sendCalls.length).toBe(n);
      fake.mode.delete(nick);
    });
  });

  // ─────────────── G. v1 pilot (tương thích) ───────────────
  describe('G. route v1 pilot', () => {
    const v1Key = randomBytes(32).toString('hex');
    const v1 = (tweak: { key?: string } = {}) => {
      const raw = JSON.stringify({ content: 'Nhắc', externalReferenceId: 'appt:v1', phoneE164: '+84901000001' });
      const ts = String(Date.now()); const nonce = randomUUID(); const path = '/internal/v1/messages/send-known-contact';
      return fetch(base + path, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-gateway-client-id': 'pilot-v1-qa', 'x-gateway-timestamp': ts, 'x-gateway-nonce': nonce, 'x-gateway-signature': signV2(tweak.key ?? v1Key, 'POST', path, ts, nonce, raw) } });
    };
    it('tắt mặc định: client pilot bị coi là client lạ của v2 → 401', async () => {
      Object.assign(process.env, { GATEWAY_SENDER_CLIENT_ID: 'pilot-v1-qa', GATEWAY_SENDER_SIGNING_KEY: v1Key, GATEWAY_SENDER_ORG_ID: A.orgId, GATEWAY_SENDER_ZALO_ACCOUNT_ID: randomUUID() });
      delete process.env.GATEWAY_SENDER_V1_ENABLED;
      expect((await v1()).status).toBe(401);
    });
    it('bật rõ ràng: chữ ký raw body đúng → đi tới kiểm tra account cố định (423, không gọi Zalo); sai khoá → 401; không khai capability v2', async () => {
      process.env.GATEWAY_SENDER_V1_ENABLED = 'true';
      const n = fake.sendCalls.length;
      const ok = await v1(); expect(ok.status).toBe(423); expect((await ok.json()).code).toBe('ACCOUNT_RESTRICTED');
      expect((await v1({ key: randomBytes(32).toString('hex') })).status).toBe(401);
      expect(fake.sendCalls.length).toBe(n);
      const { registerClient } = await import('../src/modules/gateway-v2/gateway-v2-registry.js');
      await expect(registerClient({ clientId: 'pilot-v1-qa', orgId: A.orgId, ownerUserId: 'x' })).rejects.toThrow(/pilot v1/);
      delete process.env.GATEWAY_SENDER_V1_ENABLED;
    });
  });

  // ─────────────── Health outbox ───────────────
  describe('health outbox', () => {
    it('ghi sự kiện, ký HMAC, idempotent id, retry có backoff; không gửi khi chưa cấu hình URL', async () => {
      const { dispatchHealthOutbox, backoffMs } = await import('../src/modules/gateway-v2/gateway-v2-health.js');
      const pending = await prisma.gatewayHealthOutbox.count({ where: { deliveredAt: null } });
      expect(pending).toBeGreaterThan(0);
      let hits = 0; const noUrl = await dispatchHealthOutbox(async () => { hits++; return new Response(null, { status: 200 }); });
      expect(hits).toBe(0); expect(noUrl.skipped).toBeGreaterThan(0);
      await prisma.gatewaySenderClient.update({ where: { clientId: A.clientId }, data: { healthCallbackUrl: 'http://127.0.0.1:9/cb/:id' } });
      const seen: { headers: Headers; body: string }[] = [];
      const fail = await dispatchHealthOutbox(async (_u, init) => { seen.push({ headers: new Headers(init!.headers as any), body: String(init!.body) }); return new Response(null, { status: 503 }); });
      expect(fail.failed).toBeGreaterThan(0);
      const row = await prisma.gatewayHealthOutbox.findFirst({ where: { account: { client: { clientId: A.clientId } }, deliveredAt: null } });
      expect(row.attempts).toBe(1); expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
      expect(backoffMs(3)).toBe(120_000); expect(backoffMs(20)).toBe(3_600_000);
      expect(seen[0].headers.get('x-sender-signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(seen[0].headers.get('x-sender-event-id')).toBeTruthy();
      expect(seen[0].body).not.toMatch(/cookie|imei|09\d{8}|84\d{9}/);
      expect(Object.keys(JSON.parse(seen[0].body)).sort()).toEqual(['at', 'reason', 'status']);
    });
  });
});
