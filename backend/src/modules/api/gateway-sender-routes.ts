// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Private Customer Care Gateway sender (server-to-server only — never expose publicly).
 *
 * v2 (contract customer-care-gateway/docs/multi-zalo-sender-contract.md): nhiều account, mỗi
 * Gateway client có signing key riêng (DB, mã hoá), mapping channelAccountId → nick, QR theo
 * account, preflight, gửi idempotent theo deliveryAttemptId, pause/resume/disconnect.
 *
 * v1 (pilot, một org/account cố định từ env): CHỈ chạy khi GATEWAY_SENDER_V1_ENABLED=true và
 * request đến từ đúng GATEWAY_SENDER_CLIENT_ID. v1 không khai capability v2 và dùng namespace
 * nonce riêng. Kế hoạch tắt v1: docs/gateway-sender-v2.md.
 *
 * Cả hai kiểm chữ ký trên RAW body. Không log signature, key, cookie hay số điện thoại.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { getRedis } from '../../shared/redis-client.js';
import { normalizePhone } from '../../shared/utils/phone.js';
import { logger } from '../../shared/utils/logger.js';
import { authenticateV2, redisNonceStore, type NonceStore } from '../gateway-v2/gateway-v2-auth.js';
import { GatewayV2Service } from '../gateway-v2/gateway-v2-service.js';
import { GatewayV2Error } from '../gateway-v2/gateway-v2-types.js';
import type { ZaloSessionProvider } from '../gateway-v2/zalo-session-provider.js';

type SenderBody = { externalReferenceId?: string; phoneE164?: string; content?: string };
type RawRequest = FastifyRequest & { rawBody?: string };

export interface GatewaySenderOptions {
  provider?: ZaloSessionProvider;
  nonceStore?: NonceStore;
  service?: GatewayV2Service;
}

const SEND_PATH = '/internal/v1/messages/send-known-contact';

function reject(reply: FastifyReply) { return reply.status(401).send({ error: 'Invalid request authentication' }); }

export function v1Enabled(): boolean {
  return process.env.GATEWAY_SENDER_V1_ENABLED === 'true' && !!process.env.GATEWAY_SENDER_CLIENT_ID && !!process.env.GATEWAY_SENDER_SIGNING_KEY;
}

/** Pilot v1: một org/account cố định từ env. Giữ nguyên hành vi pilot; chữ ký kiểm trên raw body. */
async function handleV1(request: RawRequest, reply: FastifyReply) {
  const clientId = String(request.headers['x-gateway-client-id'] || '');
  const timestamp = String(request.headers['x-gateway-timestamp'] || '');
  const nonce = String(request.headers['x-gateway-nonce'] || '');
  const signature = String(request.headers['x-gateway-signature'] || '');
  const expectedClient = process.env.GATEWAY_SENDER_CLIENT_ID || '';
  const signingKey = process.env.GATEWAY_SENDER_SIGNING_KEY || '';
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!expectedClient || !signingKey || clientId !== expectedClient || !nonce || !Number.isFinite(age) || age > 300_000 || !/^[a-f0-9]{64}$/.test(signature)) return reject(reply);

  const raw = request.rawBody ?? '';
  const canonical = `POST\n${SEND_PATH}\n${timestamp}\n${nonce}\n${createHash('sha256').update(raw).digest('hex')}`;
  const expected = createHmac('sha256', signingKey).update(canonical).digest('hex');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return reject(reply);

  const redis = await getRedis();
  if (!redis) return reply.status(503).send({ error: 'Replay protection unavailable', code: 'REPLAY_STORE_UNAVAILABLE' });
  let accepted: string | null;
  try { accepted = await redis.set(`gateway:nonce:${clientId}:${nonce}`, '1', 'EX', 600, 'NX'); } catch { return reply.status(503).send({ error: 'Replay protection unavailable', code: 'REPLAY_STORE_UNAVAILABLE' }); }
  if (accepted !== 'OK') return reject(reply);

  const orgId = process.env.GATEWAY_SENDER_ORG_ID || '';
  const accountId = process.env.GATEWAY_SENDER_ZALO_ACCOUNT_ID || '';
  const body = request.body as SenderBody;
  const phoneNormalized = normalizePhone(body.phoneE164);
  if (!orgId || !accountId || !phoneNormalized || !body.content || body.content.length > 2000 || !body.externalReferenceId) {
    return reply.status(400).send({ error: 'Invalid sender request' });
  }

  const account = await prisma.zaloAccount.findFirst({ where: { id: accountId, orgId, archivedAt: null }, select: { id: true, status: true } });
  if (!account || account.status !== 'connected') return reply.status(423).send({ error: 'Account unavailable', code: 'ACCOUNT_RESTRICTED' });
  const friend = await prisma.friend.findFirst({ where: {
    orgId, zaloAccountId: accountId,
    contact: { phoneNormalized, mergedInto: null },
    OR: [{ friendshipStatus: 'accepted' }, { hasConversation: true }],
  }, select: { zaloUidInNick: true } });
  if (!friend) return reply.status(404).send({ error: 'Known recipient not found', code: 'RECIPIENT_NOT_FOUND' });

  // 2026-09-23 (round 2): KHÔNG dùng zaloOps.sendMessage nữa — hàm đó tự thử lại tối đa 3 lần khi lỗi mạng và
  // thêm 1 lần sau khi tự reconnect → có thể gửi trùng. V1 giờ gọi SDK đúng MỘT lần; mọi lỗi sau khi gọi → 502
  // (Gateway phân loại UNKNOWN, không gửi lại mù). Giữ nguyên mã/HTTP status cũ để pilot không đổi hành vi hiển thị.
  const { zaloPool } = await import('../zalo/zalo-pool.js');
  const { zaloRateLimiter } = await import('../zalo/zalo-rate-limiter.js');
  const api = zaloPool.getApi(accountId);
  if (!api) return reply.status(423).send({ error: 'Account unavailable', code: 'ACCOUNT_RESTRICTED' });
  const limit = await zaloRateLimiter.checkLimits(accountId, 'message');
  if (!limit.allowed) return reply.status(429).send({ error: 'Rate limited', code: 'RATE_LIMITED' });
  try {
    const result = await api.sendMessage({ msg: body.content }, friend.zaloUidInNick, 0);
    void zaloRateLimiter.recordSend(accountId, 'message');
    const msgId = (result as any)?.message?.msgId;
    // Không có msgId → không bịa id: Gateway nhận 2xx thiếu id sẽ coi là UNKNOWN (an toàn).
    return { success: true, externalReferenceId: body.externalReferenceId, ...(msgId !== undefined && msgId !== null ? { providerMessageId: String(msgId) } : {}) };
  } catch {
    return reply.status(502).send({ error: 'Send failed', code: 'SEND_FAILED' });
  }
}

export async function gatewaySenderRoutes(app: FastifyInstance, opts: GatewaySenderOptions = {}): Promise<void> {
  // Plugin đóng gói: parser raw body chỉ áp cho các route trong plugin này.
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (req, body, done) => {
    const raw = String(body ?? '');
    (req as RawRequest).rawBody = raw;
    if (!raw) return done(null, {});
    try { done(null, JSON.parse(raw)); } catch { const e = new Error('Invalid JSON') as Error & { statusCode: number }; e.statusCode = 400; done(e, undefined); }
  });

  const nonces = opts.nonceStore ?? redisNonceStore;
  let service = opts.service ?? null;
  const getService = async () => {
    if (service) return service;
    const provider = opts.provider ?? (await import('../gateway-v2/pool-session-provider.js')).poolSessionProvider;
    service = new GatewayV2Service(provider);
    return service;
  };

  const auth = (request: RawRequest) => authenticateV2({
    method: request.method, path: request.url.split('?')[0], rawBody: request.rawBody ?? '', headers: request.headers,
  }, nonces);

  /** Chạy handler v2: lỗi nghiệp vụ → JSON có mã; lỗi khác → 500 không lộ chi tiết. */
  const v2 = (fn: (request: RawRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(request as RawRequest, reply);
    } catch (err) {
      if (err instanceof GatewayV2Error) return reply.status(err.status).send({ code: err.code, error: err.message });
      logger.error('[gateway-v2] unexpected error', (err as Error)?.message ?? err);
      return reply.status(500).send({ code: 'INTERNAL_ERROR', error: 'Internal error' });
    }
  };

  /** Route account: header account phải khớp :id (kiểm TRƯỚC khi chạm phiên Zalo). */
  type Client = Awaited<ReturnType<typeof auth>>['client'];
  const accountRoute = (fn: (s: GatewayV2Service, client: Client, id: string, request: RawRequest) => Promise<unknown>) =>
    v2(async (request, reply) => {
      const { client, accountId } = await auth(request);
      const id = String((request.params as { id?: string }).id || '').toLowerCase();
      if (id !== accountId) throw new GatewayV2Error(401, 'UNAUTHORIZED', 'Invalid request authentication');
      const out = await fn(await getService(), client, id, request);
      return reply.status(200).send(out);
    });

  app.post('/internal/v1/accounts/:id/register', accountRoute((s, c, id) => s.register(c, id)));
  app.post('/internal/v1/accounts/:id/login/start', accountRoute((s, c, id) => s.loginStart(c, id)));
  app.get('/internal/v1/accounts/:id/login/:loginId', accountRoute((s, c, id, r) => s.loginStatus(c, id, String((r.params as { loginId?: string }).loginId || ''))));
  app.post('/internal/v1/accounts/:id/pause', accountRoute((s, c, id) => s.pause(c, id)));
  app.post('/internal/v1/accounts/:id/resume', accountRoute((s, c, id) => s.resume(c, id)));
  app.post('/internal/v1/accounts/:id/disconnect', accountRoute((s, c, id) => s.disconnect(c, id)));
  app.post('/internal/v1/accounts/:id/recipient-eligibility', accountRoute(async (s, c, id, r) => ({ result: await s.eligibility(c, id, r.body) })));

  app.post(SEND_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const clientId = String(request.headers['x-gateway-client-id'] || '');
    if (v1Enabled() && clientId === process.env.GATEWAY_SENDER_CLIENT_ID) return handleV1(request as RawRequest, reply);
    return v2(async (r, rep) => {
      const { client, accountId } = await auth(r);
      const out = await (await getService()).send(client, accountId, r.body);
      return rep.status(out.status).send(out.result);
    })(request, reply);
  });
}
