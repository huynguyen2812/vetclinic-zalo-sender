// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Xác thực request contract v2 (server-to-server):
 *   signature = hex(HMAC-SHA256(signingKey, METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)))
 * - Ký trên RAW body (không stringify lại object đã parse); GET dùng body rỗng.
 * - |now - timestamp| <= 300 s; nonce chống replay theo client (Redis, >= 10 phút).
 * - Replay store lỗi → 503 REPLAY_STORE_UNAVAILABLE (fail closed).
 * - Signing key lưu mã hoá AES-256-GCM (GATEWAY_SENDER_ENC_KEY); hỗ trợ khoá cũ trong thời gian xoay.
 * - Không log signature, key hay body.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { GatewaySenderClient } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { decrypt, encrypt } from '../../shared/crypto/aes-gcm.js';
import { getRedis } from '../../shared/redis-client.js';
import { GatewayV2Error } from './gateway-v2-types.js';

export const MAX_SKEW_MS = 300_000;
export const NONCE_TTL_SECONDS = 600;

export interface NonceStore {
  /** true = nonce mới (đã ghi), false = replay. Ném lỗi nếu store không dùng được. */
  claim(clientId: string, nonce: string): Promise<boolean>;
}

/** Redis là nguồn chuẩn cho nonce (namespace riêng, không dùng chung với v1). */
export const redisNonceStore: NonceStore = {
  async claim(clientId, nonce) {
    const redis = await getRedis();
    if (!redis) throw new Error('REDIS_UNAVAILABLE');
    const r = await redis.set(`gwv2:nonce:${clientId}:${nonce}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    return r === 'OK';
  },
};

export function encryptionKey(): string {
  const k = process.env.GATEWAY_SENDER_ENC_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new GatewayV2Error(503, 'SENDER_NOT_CONFIGURED');
  return k;
}
export const sealSigningKey = (plain: string) => encrypt(plain, encryptionKey());
const openSigningKey = (sealed: string) => decrypt(sealed, encryptionKey());

export function sha256Hex(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }

export function signV2(signingKey: string, method: string, path: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHmac('sha256', signingKey).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${sha256Hex(rawBody)}`).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AuthInput {
  method: string;
  path: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

const header = (h: AuthInput['headers'], k: string) => { const v = h[k]; return Array.isArray(v) ? '' : String(v ?? ''); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trả client đã xác thực + channelAccountId trong header. Mọi thất bại xác thực trả cùng một
 * dạng 401; replay store lỗi → 503. KHÔNG chạm phiên Zalo nào trước khi hàm này thành công.
 */
export async function authenticateV2(input: AuthInput, nonces: NonceStore, now = Date.now()): Promise<{ client: GatewaySenderClient; accountId: string }> {
  const unauthorized = new GatewayV2Error(401, 'UNAUTHORIZED', 'Invalid request authentication');
  const clientId = header(input.headers, 'x-gateway-client-id');
  const timestamp = header(input.headers, 'x-gateway-timestamp');
  const nonce = header(input.headers, 'x-gateway-nonce');
  const signature = header(input.headers, 'x-gateway-signature');
  const accountId = header(input.headers, 'x-gateway-account-id');
  if (!/^[A-Za-z0-9._:-]{3,100}$/.test(clientId) || !/^\d{10,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature) || !UUID.test(accountId)) throw unauthorized;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) throw unauthorized;

  const client = await runSystemQuery(() => prisma.gatewaySenderClient.findUnique({ where: { clientId } }));
  if (!client || client.revokedAt) throw unauthorized;
  const keys = [openSigningKey(client.signingKeyEnc)];
  if (client.previousSigningKeyEnc && client.previousKeyExpiresAt && client.previousKeyExpiresAt.getTime() > now) keys.push(openSigningKey(client.previousSigningKeyEnc));
  const valid = keys.some((k) => safeEqualHex(signature, signV2(k, input.method.toUpperCase(), input.path, timestamp, nonce, input.rawBody)));
  if (!valid) throw unauthorized;

  let fresh: boolean;
  try { fresh = await nonces.claim(client.clientId, nonce); } catch { throw new GatewayV2Error(503, 'REPLAY_STORE_UNAVAILABLE', 'Replay protection unavailable'); }
  if (!fresh) throw unauthorized;
  return { client, accountId: accountId.toLowerCase() };
}
