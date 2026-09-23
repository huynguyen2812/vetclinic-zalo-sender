# Customer Care Gateway — sender nội bộ contract v2

Hợp đồng gốc: `customer-care-gateway/docs/multi-zalo-sender-contract.md`.
Trạng thái (2026-09-24, vòng 2): **đã chạy kỹ thuật với Zalo GIẢ**, Docker build + smoke test đạt; chưa thử với
tài khoản Zalo thật → **không production-ready**.

Sender này là dịch vụ **nội bộ**, chỉ Customer Care Gateway gọi qua API server-to-server có ký HMAC.
Không mở ra Internet, không nối giao diện ZaloCRM với VETCLINIC CRM, không có campaign/gửi hàng loạt.
Sender và Gateway tách repo, database, secrets; chỉ giao tiếp qua HTTP.

## Cấu hình

| Biến | Ý nghĩa |
|---|---|
| `GATEWAY_SENDER_ENC_KEY` | 64 hex. Mã hoá signing key của Gateway client trong DB. Thiếu → mọi request v2 trả 503 `SENDER_NOT_CONFIGURED`. |
| `ZALO_SESSION_ENC_KEY` | 64 hex. Mã hoá phiên Zalo (cookie/imei/userAgent) trong `zalo_accounts.session_data`. Thiếu → `login/start` trả 503 `SESSION_ENCRYPTION_REQUIRED`. Khi đặt, mọi phiên mới (kể cả nick thường của ZaloCRM) lưu dạng mã hoá; phiên cũ vẫn đọc được. |
| `REDIS_URL` | Bắt buộc: nonce chống replay (namespace `gwv2:nonce:`), fail closed. |
| `GATEWAY_IDEMPOTENCY_RETENTION_DAYS` | Mặc định 7, không thể thấp hơn 7. |
| `GATEWAY_HEALTH_CALLBACK_ENABLED` | Mặc định `false`. Bật để gửi health callback về Gateway (Gateway đã có endpoint từ vòng 2). |
| `GATEWAY_SENDER_V1_ENABLED` | Pilot v1 một account. **Mặc định `false`** trong `.env.example`; chỉ `true` mới chạy. |

Khuyến nghị vận hành: dùng **một tổ chức ZaloCRM riêng** cho Gateway, chỉ có service user làm owner, không có người
dùng thật — nick do Gateway quản lý vẫn hiện trong giao diện ZaloCRM của tổ chức đó.
Chỉ chạy **một tiến trình** sender (phiên zca-js và khoá theo account nằm trong bộ nhớ tiến trình).

## Đăng ký

**Luồng chính (tự động, vòng 2):** khi CRM tạo tài khoản Zalo, Gateway gọi
`POST /internal/v1/accounts/:id/register` (có ký). Sender gắn account vào **chính client đã ký** request — Gateway không
chọn được client/tenant khác. Idempotent; id đã thuộc client khác hoặc đã thu hồi → cùng 404 như id lạ.
Trả `{channelAccountId, status, capabilities}`. Đăng ký ≠ kết nối: account vẫn `PENDING_LOGIN` tới khi QR thành công.

**Một lần / deployment (người vận hành):** tạo Gateway client + URL health callback:
```
npx tsx scripts/gateway-v2-admin.ts register-client <clientId> <orgId> <ownerUserId> [healthCallbackUrl]
```
Ví dụ URL: `https://<gateway>/api/v1/channel/accounts/:id/health` (`:id` được thay bằng channelAccountId).

**Khôi phục / sự cố (không phải luồng chính):** `register-account`, `rotate-key`, `revoke-account`, `revoke-client`.
Script chạy được cả trong image Docker (tự dùng `dist/`) lẫn khi dev (`src/`).
Signing key chỉ in ra một lần. `revoke-account` chạy ở tiến trình riêng: xoá phiên trong DB và chặn mọi request ngay;
listener đang sống trong tiến trình sender dừng hẳn ở lần khởi động lại (hoặc gọi `disconnect` qua API trước).

## Health callback (sender → Gateway)

Outbox `gateway_health_outbox`; sự kiện: `CONNECTED` (QR thành công, resume thật sự), `PAUSED` (pause thật sự),
`RELOGIN_REQUIRED` (đăng nhập lại bằng tài khoản Zalo khác), `DISCONNECTED` (disconnect). Không phát lặp khi pause/resume
không đổi trạng thái. Payload `{status, reason, at}`; header `x-sender-client-id|timestamp|nonce|event-id|account-id|signature`;
chữ ký `HMAC-SHA256(key, METHOD\nPATH\nTS\nNONCE\nSHA256(body))` bằng signing key của client; retry backoff lũy thừa ≤ 1 giờ.
Chưa phát: mất kết nối thụ động do Zalo/mạng (pool chưa có hook sự kiện này) — Gateway vẫn biết qua kết quả gửi.

## Pilot v1

- Chỉ chạy khi `GATEWAY_SENDER_V1_ENABLED=true` và request từ đúng `GATEWAY_SENDER_CLIENT_ID`; không khai capability v2.
- Vòng 2: **bỏ `zaloOps.sendMessage`** (tự thử lại tối đa 3 lần khi lỗi mạng + 1 lần sau tự reconnect → có thể gửi trùng).
  V1 gọi SDK đúng một lần; lỗi sau khi gọi → 502 `SEND_FAILED` (Gateway coi UNKNOWN, không gửi lại mù);
  thành công không có msgId → không bịa id (trước đây trả `personal:<ref>`), Gateway coi UNKNOWN.
- Hệ quả vận hành: nếu phiên hết hạn giữa chừng, v1 không còn tự reconnect + gửi lại; tin đó thành "chưa rõ kết quả".

## Mô hình dữ liệu (migration `20260923000000_gateway_sender_v2`, chỉ thêm mới)

- `gateway_sender_clients`: clientId, org, service user, signing key mã hoá (+ khoá cũ trong thời gian xoay), URL health, thu hồi.
- `gateway_channel_accounts`: `channelAccountId` ↔ đúng một nick (`zalo_account_id` unique), status, paused,
  sessionVersion, capabilities, tên/số đã che.
- `gateway_login_attempts`: phiên QR; tối đa một phiên mở / account (partial unique); nick tạm được xoá nếu không kết nối.
- `gateway_delivery_attempts`: sổ idempotency, unique `(client, deliveryAttemptId)`, FK kép `(account, client)`,
  CHECK `SENT ⇒ providerMessageId`.
- `gateway_health_outbox`: sự kiện health chờ gửi.

## Máy trạng thái gửi

```
CLAIMED ─(kiểm tra trước gửi thất bại)→ NOT_SENT   (được claim lại với cùng request hash)
CLAIMED ─(ghi SENDING bền vững TRƯỚC khi gọi Zalo)→ SENDING → SENT(providerMessageId) | UNKNOWN
```

Gửi lại cùng `deliveryAttemptId`: hash khác → 409 `IDEMPOTENCY_CONFLICT`; `SENT` → trả lại cùng id; `SENDING`/`UNKNOWN`/
`CLAIMED` → `UNKNOWN` (không gửi mù). Zalo trả về muộn **kèm msgId** sau timeout → bản ghi chuyển `SENT`.
Gọi SDK **đúng một lần** (`api.sendMessage`), không đi qua `zaloOps.exec`.

## Bản quyền file mới

Anh Huy xác nhận là chủ sở hữu phần mã mới; tên pháp lý thể hiện trong copyright notice sẽ bổ sung trước khi phát hành.
Hiện file mới chỉ mang `SPDX-License-Identifier: AGPL-3.0-or-later` và dòng mô tả "Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE)".
Không ghi tác giả upstream cho code mới. LICENSE, NOTICE, THIRD-PARTY-LICENSES.md, attribution, banner và quyền tác giả của
mã upstream **không bị thay đổi**.

## Kế hoạch tắt v1

1. Đăng ký client v2 + account cho nick pilot hiện tại (hoặc QR lại qua v2).
2. Gateway chuyển account sang capability v2 và signing key mới (`SENDER_V2_*`).
3. Đặt `GATEWAY_SENDER_V1_ENABLED=false`, xoá `GATEWAY_SENDER_CLIENT_ID/SIGNING_KEY/ORG_ID/ZALO_ACCOUNT_ID`.
4. Xoá `handleV1` ở release kế tiếp. Không tự chuyển production sang v2 khi chưa có duyệt.
