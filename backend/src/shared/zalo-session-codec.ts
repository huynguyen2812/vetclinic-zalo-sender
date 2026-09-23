// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * zalo-session-codec.ts — mã hóa phiên Zalo (cookie/imei/userAgent) khi lưu vào
 * zalo_accounts.session_data.
 *
 * - ZALO_SESSION_ENC_KEY (64 hex) có đặt → ghi dạng envelope AES-256-GCM
 *   `{ "__enc": "aesgcm:v1", "data": "<iv>:<tag>:<ct>" }`.
 * - Không đặt → ghi như cũ (JSON thuần) để không đổi hành vi bản Community.
 * - Đọc: nhận CẢ hai dạng (dữ liệu cũ vẫn dùng được).
 *
 * Gateway sender v2 bắt buộc có khóa (fail closed) — xem modules/gateway-v2.
 */
import { decrypt, encrypt } from './crypto/aes-gcm.js';

export interface ZaloSessionCredentials {
  cookie: any;
  imei: string;
  userAgent: string;
}

const ENVELOPE = 'aesgcm:v1';

function sessionKey(): string | null {
  const k = process.env.ZALO_SESSION_ENC_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(k) ? k : null;
}

export function sessionEncryptionEnabled(): boolean {
  return sessionKey() !== null;
}

/** Giá trị để ghi vào session_data. */
export function encodeZaloSession(creds: ZaloSessionCredentials): unknown {
  const key = sessionKey();
  if (!key) return creds;
  return { __enc: ENVELOPE, data: encrypt(JSON.stringify(creds), key) };
}

/** Đọc session_data (envelope hoặc JSON cũ). Trả null nếu rỗng/hỏng/thiếu khóa. */
export function decodeZaloSession(value: unknown): ZaloSessionCredentials | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.__enc === ENVELOPE && typeof v.data === 'string') {
    const key = sessionKey();
    if (!key) return null;
    try { return JSON.parse(decrypt(v.data, key)) as ZaloSessionCredentials; } catch { return null; }
  }
  return typeof v.imei === 'string' ? (v as unknown as ZaloSessionCredentials) : null;
}
