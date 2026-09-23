// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Health callback sender → Gateway (outbox). Gateway CHƯA có endpoint nhận (BLOCKED), nên
 * dispatcher chỉ chạy khi client có healthCallbackUrl và GATEWAY_HEALTH_CALLBACK_ENABLED=true.
 * Payload: { status, reason, at } — không có cookie, số điện thoại hay secret.
 * Ký HMAC-SHA256 cùng lược đồ v2 (METHOD\nPATH\nTS\nNONCE\nSHA256(body)) bằng signing key của client;
 * idempotent theo x-sender-event-id (= id outbox); lỗi → thử lại với backoff lũy thừa (tối đa 1 giờ).
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { decrypt } from '../../shared/crypto/aes-gcm.js';
import { encryptionKey, signV2 } from './gateway-v2-auth.js';

export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

export async function dispatchHealthOutbox(fetchImpl: typeof fetch = fetch, now = new Date(), limit = 20): Promise<{ delivered: number; failed: number; skipped: number }> {
  const rows = await runSystemQuery(() => prisma.gatewayHealthOutbox.findMany({
    where: { deliveredAt: null, nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: limit,
    include: { account: { include: { client: true } } },
  }));
  let delivered = 0; let failed = 0; let skipped = 0;
  for (const row of rows) {
    const client = row.account.client;
    if (!client.healthCallbackUrl || client.revokedAt) { skipped++; continue; }
    const url = new URL(client.healthCallbackUrl.replace(':id', row.account.channelAccountId));
    const body = JSON.stringify({ status: row.status, reason: row.reason, at: row.at.toISOString() });
    const ts = String(now.getTime()); const nonce = randomUUID();
    const sig = signV2(decrypt(client.signingKeyEnc, encryptionKey()), 'POST', url.pathname, ts, nonce, body);
    let ok = false; let err = '';
    try {
      const res = await fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(5000), headers: {
        'content-type': 'application/json', 'x-sender-client-id': client.clientId, 'x-sender-timestamp': ts, 'x-sender-nonce': nonce,
        'x-sender-event-id': row.id, 'x-sender-account-id': row.account.channelAccountId, 'x-sender-signature': sig,
      } });
      ok = res.ok; if (!ok) err = `HTTP_${res.status}`;
    } catch (e) { err = (e as Error)?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'; }
    if (ok) { delivered++; await runSystemQuery(() => prisma.gatewayHealthOutbox.update({ where: { id: row.id }, data: { deliveredAt: now, attempts: { increment: 1 }, lastError: null } })); }
    else {
      failed++;
      await runSystemQuery(() => prisma.gatewayHealthOutbox.update({ where: { id: row.id }, data: {
        attempts: { increment: 1 }, lastError: err, nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts + 1)),
      } }));
    }
  }
  return { delivered, failed, skipped };
}
