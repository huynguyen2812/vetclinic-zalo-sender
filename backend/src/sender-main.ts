// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Điểm khởi động CHẾ ĐỘ CHỈ-SENDER (bản VETCLINIC CRM chạy trên PC).
 *
 * Chỉ chạy: route contract v2 (/internal/v1/*), /health, /legal, pool phiên Zalo (kèm listener + đồng bộ bạn bè,
 * vì bước kiểm tra "chỉ nhắn bạn bè / hội thoại đã có" đọc dữ liệu đồng bộ này), kiểm tra sức khỏe phiên và bảo trì v2.
 * KHÔNG chạy: giao diện ZaloCRM, API người dùng, socket.io, cron nhắc lịch riêng của ZaloCRM, Telegram, AI,
 * quét nhóm (BullMQ), presence, chấm điểm, làm giàu dữ liệu… Không cần Redis: nonce lưu PostgreSQL.
 *
 * app.ts (bản đầy đủ) giữ nguyên, không bị ảnh hưởng.
 */
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import { prisma } from './shared/database/prisma-client.js';
import { runSystemQuery } from './shared/tenant/tenant-context.js';
import { logger } from './shared/utils/logger.js';
import { decodeZaloSession } from './shared/zalo-session-codec.js';
import { gatewaySenderRoutes } from './modules/api/gateway-sender-routes.js';
import { pgNonceStore, purgeExpiredNonces } from './modules/gateway-v2/pg-nonce-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_URL = process.env.SENDER_SOURCE_URL || 'https://github.com/huynguyen2812/vetclinic-zalo-sender';

/** NOTICE/LICENSE của bản phân phối (AGPL §7b ghi công, §13 nguồn): đọc từ thư mục cài, không sửa nội dung. */
function legalText(): string {
  const dir = process.env.SENDER_LEGAL_DIR || path.resolve(__dirname, '..', '..');
  let notice = '';
  try { notice = readFileSync(path.join(dir, 'NOTICE'), 'utf8'); } catch { notice = '(Không tìm thấy file NOTICE trong thư mục cài đặt.)'; }
  return [
    'VETCLINIC Zalo Sender — bản sửa đổi của ZaloCRM, phát hành theo GNU Affero General Public License v3.0.',
    `Mã nguồn tương ứng của bản đang chạy: ${SOURCE_URL} (và file sender-source.zip đi kèm bộ cài).`,
    'Toàn văn giấy phép: file LICENSE trong thư mục cài đặt.',
    '',
    notice,
  ].join('\n');
}

async function main(): Promise<void> {
  if (process.env.SENDER_ONLY !== 'true') throw new Error('sender-main requires SENDER_ONLY=true');
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.get('/health', async (_req, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; return { status: 'ok', mode: 'sender-only', db: 'connected' }; }
    catch { return reply.status(503).send({ status: 'error', mode: 'sender-only', db: 'disconnected' }); }
  });
  app.get('/legal', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(legalText()));
  await app.register(gatewaySenderRoutes, { nonceStore: pgNonceStore });
  app.setNotFoundHandler(async (_req, reply) => reply.status(404).send({ code: 'NOT_FOUND' }));
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    logger.error('[sender-only] request error', error.message);
    reply.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({ code: 'REQUEST_ERROR' });
  });

  const port = Number(process.env.PORT || 47110);
  const host = process.env.HOST || '127.0.0.1';
  await app.listen({ port, host });
  logger.info(`[sender-only] listening on http://${host}:${port}`);

  const cron = (await import('node-cron')).default;
  // Bảo trì contract v2: QR bỏ dở lúc tắt máy → EXPIRED; sổ idempotency > N ngày; nonce hết hạn; health callback.
  const { GatewayV2Service } = await import('./modules/gateway-v2/gateway-v2-service.js');
  const { poolSessionProvider } = await import('./modules/gateway-v2/pool-session-provider.js');
  const gatewayV2 = new GatewayV2Service(poolSessionProvider);
  const expired = await gatewayV2.recoverOnBoot().catch(() => 0);
  if (expired) logger.info(`[sender-only] recovered ${expired} open QR login(s) as EXPIRED`);
  cron.schedule('30 3 * * *', () => { void gatewayV2.purgeIdempotency(Number(process.env.GATEWAY_IDEMPOTENCY_RETENTION_DAYS || 7)).catch(() => undefined); });
  setInterval(() => { void purgeExpiredNonces().catch(() => undefined); }, 10 * 60_000).unref();
  if (process.env.GATEWAY_HEALTH_CALLBACK_ENABLED === 'true') {
    const { dispatchHealthOutbox } = await import('./modules/gateway-v2/gateway-v2-health.js');
    setInterval(() => { void dispatchHealthOutbox().catch(() => undefined); }, 30_000).unref();
  }

  // Phiên Zalo đã lưu (mã hóa) → kết nối lại; kiểm tra phiên mỗi 5 phút; đồng bộ bạn bè mỗi 15 phút.
  const { zaloPool } = await import('./modules/zalo/zalo-pool.js');
  const { startZaloHealthCheck } = await import('./modules/zalo/zalo-health-check.js');
  const { startFriendSyncCron } = await import('./modules/zalo/friend-sync-cron.js');
  startZaloHealthCheck();
  startFriendSyncCron(null);
  try {
    const accounts = await runSystemQuery(() => prisma.zaloAccount.findMany({
      where: { sessionData: { not: Prisma.JsonNull }, archivedAt: null, zaloUid: { not: null } },
      select: { id: true, sessionData: true },
    }));
    for (const account of accounts) {
      const session = decodeZaloSession(account.sessionData);
      if (session?.imei) zaloPool.reconnect(account.id, session).catch((err) => logger.warn(`[sender-only] reconnect failed ${account.id}`, err?.message ?? err));
    }
    logger.info(`[sender-only] reconnect scheduled for ${accounts.length} Zalo account(s)`);
  } catch (err) {
    logger.error('[sender-only] failed to load accounts for reconnect', (err as Error)?.message ?? err);
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return; stopping = true;
    logger.info(`[sender-only] ${signal} — closing`);
    const force = setTimeout(() => process.exit(1), 10_000); force.unref();
    await app.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => logger.error('[sender-only] unhandled rejection', (reason as Error)?.message ?? reason));
main().catch((err) => { logger.error('[sender-only] failed to start', err?.message ?? err); process.exit(1); });
