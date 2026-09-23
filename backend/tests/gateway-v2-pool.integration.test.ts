// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Gateway sender v2 trên SESSION POOL THẬT của ZaloCRM (zalo-pool.ts) với zca-js GIẢ.
 * Chứng minh phần nối: QR theo account qua hook, phiên lưu mã hoá, gửi đúng 1 lần (không qua
 * zaloOps.exec tự retry), QR hết hạn không tự sinh lại, một nick connect không giết QR của account khác,
 * disconnect chỉ dừng listener của đúng nick. Không có tài khoản/QR/tin Zalo thật.
 *
 * Chạy: GATEWAY_V2_QA=1 DATABASE_URL=<QA> REDIS_URL=<QA redis> npx vitest run tests/gateway-v2-pool.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';

const QA = process.env.GATEWAY_V2_QA === '1';
process.env.GATEWAY_SENDER_ENC_KEY ||= randomBytes(32).toString('hex');
process.env.ZALO_SESSION_ENC_KEY ||= randomBytes(32).toString('hex');

/** zca-js giả: mỗi `new Zalo()` là một phiên riêng; test điều khiển từng bước QR. */
class FakeListener extends EventEmitter { started = 0; stopped = 0; start() { this.started++; } stop() { this.stopped++; } }
class FakeZaloSDK {
  static all: FakeZaloSDK[] = [];
  cb: ((e: any) => void) | null = null; retries = 0; listener = new FakeListener();
  sendCalls: any[] = []; sendMode: 'ok' | 'transient' = 'ok';
  private resolveLogin!: (api: any) => void; private rejectLogin!: (e: Error) => void; uid = '';
  constructor() { FakeZaloSDK.all.push(this); }
  loginQR(_o: unknown, cb: (e: any) => void) {
    this.cb = cb;
    setImmediate(() => cb({ type: 0, data: { image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }, actions: { retry: () => { this.retries++; } } }));
    return new Promise((res, rej) => { this.resolveLogin = res; this.rejectLogin = rej; });
  }
  login() { return Promise.resolve(this.api()); }
  api() {
    const self = this;
    const base: Record<string, unknown> = {
      listener: this.listener,
      getOwnId: async () => self.uid,
      getUserInfo: async () => ({ changed_profiles: {} }),
      sendMessage: async (msg: any, thread: string) => {
        self.sendCalls.push({ msg, thread });
        if (self.sendMode === 'transient') throw new Error('fetch failed');
        return { message: { msgId: 1000 + self.sendCalls.length } };
      },
    };
    return new Proxy(base, { get: (t, k) => (k in t ? (t as any)[k] : k === 'then' || typeof k === 'symbol' ? undefined : async () => ({})) });
  }
  // điều khiển test
  scan() { this.cb?.({ type: 2, data: { display_name: 'QA', avatar: '' } }); }
  complete(uid: string) {
    this.uid = uid;
    this.cb?.({ type: 4, data: { cookie: [{ key: 'zpw_sek', value: `secret-${uid}` }], imei: `imei-${uid}`, userAgent: 'qa-agent' } });
    this.resolveLogin(this.api());
  }
  expire() { this.cb?.({ type: 1, data: {}, actions: { retry: () => { this.retries++; } } }); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean> | boolean, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(25); } throw new Error('timeout waiting'); }

describe.skipIf(!QA)('Gateway v2 trên session pool thật (zca-js giả)', () => {
  let prisma: any; let service: any; let pool: any; let client: any; let orgId = '';
  const accs = [randomUUID(), randomUUID()];
  const sdkOf = () => FakeZaloSDK.all[FakeZaloSDK.all.length - 1];
  const nickOf = async (acc: string) => (await prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: acc } })).zaloAccountId as string;

  beforeAll(async () => {
    // Thay zca-js trong require cache TRƯỚC khi zalo-pool nạp nó qua createRequire.
    const req = createRequire(import.meta.url);
    const path = req.resolve('zca-js');
    req.cache[path] = { id: path, filename: path, loaded: true, exports: { Zalo: FakeZaloSDK } } as any;
    ({ prisma } = await import('../src/shared/database/prisma-client.js'));
    ({ zaloPool: pool } = await import('../src/modules/zalo/zalo-pool.js'));
    const { poolSessionProvider } = await import('../src/modules/gateway-v2/pool-session-provider.js');
    const { GatewayV2Service } = await import('../src/modules/gateway-v2/gateway-v2-service.js');
    const { registerClient, registerAccount } = await import('../src/modules/gateway-v2/gateway-v2-registry.js');
    const org = await prisma.organization.create({ data: { name: 'QA pool v2' } }); orgId = org.id;
    const owner = await prisma.user.create({ data: { orgId, passwordHash: 'x', fullName: 'svc', role: 'owner', email: `pool-${randomUUID().slice(0, 8)}@qa.invalid` } });
    ({ client } = await registerClient({ clientId: `qa-pool-${randomUUID().slice(0, 6)}`, orgId, ownerUserId: owner.id }));
    for (const a of accs) await registerAccount(client.clientId, a);
    service = new GatewayV2Service(poolSessionProvider, { qrWaitMs: 3000, sendTimeoutMs: 2000 });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const a of accs) { const n = await nickOf(a).catch(() => null); if (n) pool.disconnect(n); }
    await prisma.gatewayDeliveryAttempt.deleteMany({ where: { clientRef: client.id } });
    await prisma.gatewayChannelAccount.deleteMany({ where: { clientRef: client.id } });
    await prisma.gatewaySenderClient.delete({ where: { id: client.id } });
    await prisma.organization.delete({ where: { id: orgId } });
    const { closeRedis } = await import('../src/shared/redis-client.js'); await closeRedis();
    await prisma.$disconnect();
  });

  it('QR qua pool: ảnh có tiền tố data URL; account 2 đang chờ QR KHÔNG bị ngắt khi account 1 kết nối', async () => {
    const s1 = await service.loginStart(client, accs[0]); const sdk1 = sdkOf();
    expect(s1.qrImage).toMatch(/^data:image\/png;base64,iVBOR/);
    const s2 = await service.loginStart(client, accs[1]); const sdk2 = sdkOf();
    const nick2 = (await prisma.gatewayLoginAttempt.findUnique({ where: { id: s2.loginId } })).provisionalZaloAccountId;
    sdk1.scan();
    await until(async () => (await service.loginStatus(client, accs[0], s1.loginId)).status === 'SCANNED');
    sdk1.complete('zuid-pool-1');
    await until(async () => (await service.loginStatus(client, accs[0], s1.loginId)).status === 'CONNECTED').catch(async (e) => { const a = await prisma.gatewayLoginAttempt.findUnique({ where: { id: s1.loginId } }); throw new Error(`login ${a.status} ${a.failureCode} pool=${pool.getStatus(a.provisionalZaloAccountId)}`); });
    await sleep(300); // cho nhánh dọn ghost chạy nền
    expect(pool.getStatus(nick2)).toBe('qr_pending'); // QR của account khác không bị ngắt
    expect(sdk2.listener.stopped).toBe(0);
    expect((await service.loginStatus(client, accs[1], s2.loginId)).status).toBe('PENDING');
    const nick1 = await nickOf(accs[0]);
    await until(async () => (await prisma.zaloAccount.findUnique({ where: { id: nick1 } })).sessionData !== null);
    const saved = (await prisma.zaloAccount.findUnique({ where: { id: nick1 } })).sessionData;
    expect(saved.__enc).toBe('aesgcm:v1'); expect(JSON.stringify(saved)).not.toMatch(/secret-|imei-|qa-agent/);
    sdk2.scan(); sdk2.complete('zuid-pool-2');
    await until(async () => (await service.loginStatus(client, accs[1], s2.loginId)).status === 'CONNECTED');
    expect(await nickOf(accs[1])).toBe(nick2);
    expect(pool.getStatus(nick1)).toBe('connected'); expect(pool.getStatus(nick2)).toBe('connected');
    expect(pool.getApi(nick1)).not.toBe(pool.getApi(nick2));
  });

  it('gửi qua pool: đúng MỘT lời gọi SDK, kể cả khi lỗi mạng tạm thời (zaloOps.exec sẽ retry — v2 không dùng)', async () => {
    const nick1 = await nickOf(accs[0]);
    const contact = await prisma.contact.create({ data: { orgId, phone: '+84901777001', fullName: 'Khách QA' } });
    await prisma.friend.create({ data: { orgId, contactId: contact.id, zaloAccountId: nick1, zaloUidInNick: 'peer-1', friendshipStatus: 'accepted' } });
    const sdk1 = FakeZaloSDK.all.find((s) => s.uid === 'zuid-pool-1')!;
    const body = (id: string) => ({ deliveryAttemptId: id, idempotencyKey: id, channelAccountId: accs[0], phoneE164: '+84901777001', externalReferenceId: 'appt:1', content: 'Nhắc lịch QA' });
    const ok = await service.send(client, accs[0], body(randomUUID()));
    expect(ok.result.delivery).toBe('SENT'); expect(sdk1.sendCalls).toHaveLength(1); expect(sdk1.sendCalls[0].thread).toBe('peer-1');
    sdk1.sendMode = 'transient';
    const id = randomUUID();
    const r = await service.send(client, accs[0], body(id));
    expect(r.result).toEqual({ delivery: 'UNKNOWN', code: 'ZALO_SEND_ERROR' });
    expect(sdk1.sendCalls).toHaveLength(2);
    const again = await service.send(client, accs[0], body(id));
    expect(again.result.delivery).toBe('UNKNOWN'); expect(sdk1.sendCalls).toHaveLength(2);
    sdk1.sendMode = 'ok';
  });

  it('QR hết hạn: không tự sinh QR mới (maxQrRetry=1), phiên → EXPIRED; nick cũ không bị đụng', async () => {
    const acc3 = randomUUID();
    const { registerAccount } = await import('../src/modules/gateway-v2/gateway-v2-registry.js');
    await registerAccount(client.clientId, acc3); accs.push(acc3);
    const s = await service.loginStart(client, acc3); const sdk = sdkOf();
    const prov = (await prisma.gatewayLoginAttempt.findUnique({ where: { id: s.loginId } })).provisionalZaloAccountId;
    sdk.expire();
    await until(async () => (await service.loginStatus(client, acc3, s.loginId)).status === 'EXPIRED');
    expect(sdk.retries).toBe(0);
    expect(await prisma.zaloAccount.findUnique({ where: { id: prov } })).toBeNull();
    expect(pool.getStatus(await nickOf(accs[0]))).toBe('connected');
  });

  it('pilot V1: lỗi mạng tạm thời → đúng MỘT lời gọi SDK, trả 502 (không còn retry của zaloOps.exec); thành công không bịa msgId', async () => {
    const nick1 = await nickOf(accs[0]);
    const { createHash, createHmac } = await import('node:crypto');
    const Fastify = (await import('fastify')).default;
    const { gatewaySenderRoutes } = await import('../src/modules/api/gateway-sender-routes.js');
    const v1Key = randomBytes(32).toString('hex');
    Object.assign(process.env, { GATEWAY_SENDER_V1_ENABLED: 'true', GATEWAY_SENDER_CLIENT_ID: 'pilot-v1-pool', GATEWAY_SENDER_SIGNING_KEY: v1Key, GATEWAY_SENDER_ORG_ID: orgId, GATEWAY_SENDER_ZALO_ACCOUNT_ID: nick1 });
    await prisma.zaloAccount.update({ where: { id: nick1 }, data: { status: 'connected' } });
    const app = Fastify({ logger: false }); await app.register(gatewaySenderRoutes, { service });
    const post = async () => {
      const raw = JSON.stringify({ content: 'Nhắc lịch QA', externalReferenceId: 'appt:v1', phoneE164: '+84901777001' });
      const ts = String(Date.now()); const nonce = randomUUID();
      const sig = createHmac('sha256', v1Key).update(`POST\n/internal/v1/messages/send-known-contact\n${ts}\n${nonce}\n${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
      return app.inject({ method: 'POST', url: '/internal/v1/messages/send-known-contact', payload: raw, headers: { 'content-type': 'application/json', 'x-gateway-client-id': 'pilot-v1-pool', 'x-gateway-timestamp': ts, 'x-gateway-nonce': nonce, 'x-gateway-signature': sig } });
    };
    const sdk1 = FakeZaloSDK.all.find((s) => s.uid === 'zuid-pool-1')!;
    const n = sdk1.sendCalls.length;
    sdk1.sendMode = 'transient';
    const fail = await post();
    expect(fail.statusCode).toBe(502); expect(sdk1.sendCalls.length - n).toBe(1);
    sdk1.sendMode = 'ok';
    const ok = await post();
    expect(ok.statusCode).toBe(200); expect(ok.json().providerMessageId).toMatch(/^\d+$/); expect(sdk1.sendCalls.length - n).toBe(2);
    delete process.env.GATEWAY_SENDER_V1_ENABLED;
    await app.close();
  });

  it('disconnect: dừng listener + xoá phiên của đúng nick, nick khác vẫn sống', async () => {
    const [n1, n2] = [await nickOf(accs[0]), await nickOf(accs[1])];
    const sdk1 = FakeZaloSDK.all.find((s) => s.uid === 'zuid-pool-1')!; const sdk2 = FakeZaloSDK.all.find((s) => s.uid === 'zuid-pool-2')!;
    await service.disconnect(client, accs[1]);
    expect(sdk2.listener.stopped).toBeGreaterThan(0); expect(sdk1.listener.stopped).toBe(0);
    expect(pool.getStatus(n2)).toBe('disconnected'); expect(pool.getStatus(n1)).toBe('connected');
    const nick2 = await prisma.zaloAccount.findUnique({ where: { id: n2 } });
    const { decodeZaloSession } = await import('../src/shared/zalo-session-codec.js');
    // Prisma.JsonNull bị extension strip-null-bytes của ZaloCRM biến thành {} — phiên vẫn bị xoá (không còn gì giải mã được).
    expect(decodeZaloSession(nick2.sessionData)).toBeNull(); expect(JSON.stringify(nick2.sessionData)).not.toMatch(/__enc|cookie|imei/);
    expect(nick2.disconnectReason).toBe('manual');
  });
});
