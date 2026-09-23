// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Provider chạy thật: tái sử dụng ZaloAccountPool (session pool sẵn có của ZaloCRM).
 * Mỗi Gateway channel account ↔ một nick ↔ một instance zca-js riêng (cookie/imei/listener riêng).
 *
 * Khác zaloOps.exec: gửi gọi `api.sendMessage` ĐÚNG MỘT LẦN — exec tự thử lại khi lỗi mạng/phiên
 * hết hạn, có thể tạo tin trùng, nên không dùng cho đường gửi có idempotency.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { decodeZaloSession } from '../../shared/zalo-session-codec.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import { logger } from '../../shared/utils/logger.js';
import { ProviderNotConnectedError, type ProviderStatus, type ZaloSessionProvider } from './zalo-session-provider.js';
import type { LoginEvent } from './gateway-v2-types.js';

export const poolSessionProvider: ZaloSessionProvider = {
  startQrLogin(nickId: string, onEvent: (e: LoginEvent) => void): void {
    zaloPool.setLoginHook(nickId, (e) => {
      if (e.type === 'connected' || e.type === 'failed' || e.type === 'expired') zaloPool.setLoginHook(nickId, null);
      // zca-js bỏ tiền tố data URL; hợp đồng v2 yêu cầu "data:image/png;base64,…".
      if (e.type === 'qr') onEvent({ type: 'qr', image: e.image.startsWith('data:') ? e.image : `data:image/png;base64,${e.image}` });
      else onEvent(e);
    });
    void (async () => {
      const nick = await runSystemQuery(() => prisma.zaloAccount.findUnique({ where: { id: nickId }, select: { proxyUrl: true } }));
      await zaloPool.loginQR(nickId, nick?.proxyUrl ?? null, { maxQrRetry: 1 });
    })().catch((err) => {
      logger.warn(`[gateway-v2:${nickId}] loginQR ended with error`, err?.message ?? err);
      onEvent({ type: 'failed', code: 'LOGIN_ERROR' });
    });
  },

  cancelLogin(nickId: string): void {
    zaloPool.setLoginHook(nickId, null);
    const st = zaloPool.getStatus(nickId);
    if (st === 'qr_pending' || st === 'connecting') zaloPool.disconnect(nickId);
  },

  status(nickId: string): ProviderStatus {
    const st = zaloPool.getStatus(nickId);
    return st === 'connected' || st === 'connecting' || st === 'qr_pending' ? st : 'disconnected';
  },

  async hasSavedSession(nickId: string): Promise<boolean> {
    const nick = await runSystemQuery(() => prisma.zaloAccount.findUnique({ where: { id: nickId }, select: { sessionData: true } }));
    return decodeZaloSession(nick?.sessionData) !== null;
  },

  async checkSendAllowed(nickId: string): Promise<boolean> {
    const r = await zaloRateLimiter.checkLimits(nickId, 'message');
    return r.allowed;
  },

  async sendText(nickId: string, threadUid: string, text: string): Promise<{ msgId: string | null }> {
    const api = zaloPool.getApi(nickId);
    if (!api) throw new ProviderNotConnectedError();
    const result = await api.sendMessage({ msg: text }, threadUid, 0);
    void zaloRateLimiter.recordSend(nickId, 'message');
    const id = result?.message?.msgId;
    return { msgId: id === undefined || id === null || id === '' ? null : String(id) };
  },

  async terminate(nickId: string): Promise<void> {
    zaloPool.setLoginHook(nickId, null);
    zaloPool.disconnect(nickId);
    await runSystemQuery(() => prisma.zaloAccount.update({
      where: { id: nickId },
      data: { sessionData: Prisma.JsonNull, status: 'disconnected', disconnectReason: 'manual', disconnectedAt: new Date() },
    }));
  },

  restoreSaved(nickId: string): void {
    void (async () => {
      const nick = await runSystemQuery(() => prisma.zaloAccount.findUnique({ where: { id: nickId }, select: { sessionData: true, proxyUrl: true } }));
      const session = decodeZaloSession(nick?.sessionData);
      if (session) await zaloPool.reconnect(nickId, session, nick?.proxyUrl ?? null);
    })().catch((err) => logger.warn(`[gateway-v2:${nickId}] restoreSaved failed`, err?.message ?? err));
  },
};
