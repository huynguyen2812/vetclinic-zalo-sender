// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Ranh giới giữa sender v2 và phiên Zalo thật. Bản chạy thật (pool-session-provider.ts)
 * dùng lại ZaloAccountPool sẵn có (mỗi nick = 1 instance zca-js, listener, cookie riêng).
 * Test dùng provider giả — KHÔNG có tài khoản/QR/tin Zalo thật nào trong test tự động.
 */
import type { LoginEvent } from './gateway-v2-types.js';

export type ProviderStatus = 'connected' | 'connecting' | 'qr_pending' | 'disconnected';

/** Ném TRƯỚC khi gọi Zalo (chắc chắn chưa gửi) — ví dụ instance không có API. */
export class ProviderNotConnectedError extends Error {
  constructor() { super('ZALO_NOT_CONNECTED'); }
}

export interface ZaloSessionProvider {
  /** Bắt đầu QR login cho đúng 1 nick; sự kiện trả qua onEvent (chạy nền). */
  startQrLogin(nickId: string, onEvent: (e: LoginEvent) => void): void;
  /** Huỷ phiên QR đang chờ của nick (không đụng nick khác). */
  cancelLogin(nickId: string): void;
  status(nickId: string): ProviderStatus;
  hasSavedSession(nickId: string): Promise<boolean>;
  /** Kiểm tra giới hạn tốc độ TRƯỚC khi gửi (không gọi Zalo). */
  checkSendAllowed(nickId: string): Promise<boolean>;
  /** Gọi Zalo ĐÚNG MỘT LẦN, không tự thử lại. */
  sendText(nickId: string, threadUid: string, text: string): Promise<{ msgId: string | null }>;
  /** Dừng listener/socket + xoá phiên đã lưu của đúng nick này. */
  terminate(nickId: string): Promise<void>;
  /** Thử khôi phục phiên đã lưu (sau khi relogin thất bại). Best-effort. */
  restoreSaved(nickId: string): void;
}
