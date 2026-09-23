// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Customer Care Gateway sender contract v2 — kiểu dữ liệu dùng chung.
 * Hợp đồng: customer-care-gateway/docs/multi-zalo-sender-contract.md
 */

/** Capability mà route v2 khai báo. Route v1 (pilot) KHÔNG khai báo capability nào. */
export const V2_CAPABILITIES = Object.freeze({
  contractVersion: 2,
  qrLogin: true,
  recipientPreflight: true,
  idempotentSend: true,
  remoteControl: true,
});

/** Sự kiện login của MỘT account (khớp cấu trúc PoolLoginEvent trong zalo-pool). */
export type LoginEvent =
  | { type: 'qr'; image: string }
  | { type: 'scanned'; displayName?: string }
  | { type: 'expired' }
  | { type: 'connected'; zaloUid: string }
  | { type: 'failed'; code: string };

export type NotSentCode =
  | 'ACCOUNT_UNAVAILABLE' | 'RELOGIN_REQUIRED' | 'ACCOUNT_RESTRICTED' | 'RATE_LIMITED'
  | 'ACCOUNT_PAUSED' | 'RECIPIENT_NOT_FOUND' | 'INVALID_REQUEST';

export type SendResult =
  | { delivery: 'SENT'; providerMessageId: string }
  | { delivery: 'NOT_SENT'; code: NotSentCode }
  | { delivery: 'UNKNOWN'; code: string };

export type Eligibility =
  | 'ELIGIBLE_EXISTING_FRIEND' | 'ELIGIBLE_EXISTING_CONVERSATION' | 'NOT_FOUND' | 'ACCOUNT_UNAVAILABLE' | 'UNKNOWN';

export type LoginStatus = 'PENDING' | 'SCANNED' | 'CONNECTED' | 'EXPIRED' | 'FAILED';

/** Lỗi nghiệp vụ có mã + HTTP status, route chuyển thành JSON an toàn. */
export class GatewayV2Error extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code); }
}

export const NOT_FOUND = () => new GatewayV2Error(404, 'NOT_FOUND', 'Account not found');
