// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Replay store cho contract v2 bằng PostgreSQL (bản chạy trên PC, chế độ chỉ-sender, không Redis).
 * - claim nguyên tử: INSERT … ON CONFLICT DO NOTHING; 1 dòng được ghi = nonce mới.
 * - Lỗi DB → ném lỗi → authenticateV2 trả 503 REPLAY_STORE_UNAVAILABLE (fail closed), giống store Redis.
 * - Nonce hết hạn sau NONCE_TTL_SECONDS và được dọn định kỳ (purgeExpiredNonces).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { NONCE_TTL_SECONDS, type NonceStore } from './gateway-v2-auth.js';

export const pgNonceStore: NonceStore = {
  async claim(clientId, nonce) {
    const inserted = await runSystemQuery(() => prisma.$executeRaw`
      INSERT INTO "gateway_v2_nonces" ("client_id", "nonce", "expires_at")
      VALUES (${clientId}, ${nonce}, NOW() + make_interval(secs => ${NONCE_TTL_SECONDS}))
      ON CONFLICT DO NOTHING`);
    return inserted === 1;
  },
};

export async function purgeExpiredNonces(): Promise<number> {
  return runSystemQuery(() => prisma.$executeRaw`DELETE FROM "gateway_v2_nonces" WHERE "expires_at" < NOW()`);
}
