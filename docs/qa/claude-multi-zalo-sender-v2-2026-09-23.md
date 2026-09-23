# Báo cáo — Sender Zalo cá nhân contract v2 nhiều account (Claude, 2026-09-23)

Trạng thái: **Đã chạy kỹ thuật với Zalo GIẢ.** Chưa có thử nghiệm Zalo thật được duyệt → **KHÔNG production-ready**.
Chưa commit / push / PR / deploy. Dừng chờ Codex review.

## 1. Nhánh, HEAD, Git
- Repo `D:\DuAn\ZaloCRM-upstream`, remote `origin https://github.com/locphamnguyen/ZaloCRM.git`.
- Trước: `main...origin/main`, HEAD `8664567`, pilot chưa commit: `M backend/.env.example`, `M backend/src/app.ts`,
  `?? .pilot-files/ backend/scripts/pilot-authorized-send.ts backend/src/modules/api/gateway-sender-routes.ts docker-compose.gateway-pilot.yml frontend/.env.local`.
- Tạo nhánh `feat/multi-zalo-sender-v2` bằng `git checkout -b` từ đúng working tree (không reset/clean/stash). HEAD vẫn `8664567`.
- Không có AGENTS.md/CLAUDE.md trong repo sender (AGENTS.md bị gitignore, không tồn tại). Không đổi git config global.
- Bảo toàn pilot:
  - `.pilot-files/`, `frontend/.env.local`, `docker-compose.gateway-pilot.yml`, `scripts/pilot-authorized-send.ts`: **không đụng**.
  - `gateway-sender-routes.ts` (pilot v1): giữ nguyên logic v1 trong `handleV1`, chỉ đổi kiểm chữ ký sang raw body và gate
    bằng `GATEWAY_SENDER_V1_ENABLED=true`. Bản gốc lưu ở scratchpad (sha256 `ea1599bf…4762c`).
  - `backend/.env` (local, gitignore): **thêm 1 dòng** `GATEWAY_SENDER_V1_ENABLED=true` để pilot không bị tắt. Không đọc/in secret.
- Sau: thay đổi chưa commit — xem `git status` cuối (§12).

## 2. Kết quả

| Hạng mục | Kết quả |
|---|---|
| Typecheck `tsc --noEmit` / `npm run build` | PASS |
| Test v2 HTTP thật + Postgres QA + Redis QA (`tests/gateway-v2.integration.test.ts`) | PASS 32/32, 3 lần liên tiếp ổn định |
| Test v2 trên session pool thật + zca-js giả (`tests/gateway-v2-pool.integration.test.ts`) | PASS 4/4 |
| Bộ test có sẵn (`npx vitest run`) | 369 pass / 43 fail / 72 suite lỗi — **giống hệt mốc HEAD sạch** (so từng tên test: 0 lỗi mới, 0 thay đổi) → không hồi quy; 43 lỗi là lỗi có sẵn của upstream |
| Migration forward-only trên DB QA riêng + `migrate deploy` lần 2 | PASS ("No pending migrations") |
| `npm audit --omit=dev` | 39 (15 moderate / 23 high / 1 critical) — **không đổi**, không thêm dependency |
| Tích hợp với Customer Care Gateway (mã Gateway đã build, không sửa) | PASS 14/14 |
| Docker build local | **BLOCKED** — 2 lần lỗi mạng/I-O khi `apk add` tải gói Alpine (`dl-cdn.alpinelinux.org … I/O error`), dừng trước bước build mã |
| Zalo thật (tài khoản, QR, gửi) | **NOT RUN** (không được phép) |
| Health callback tới Gateway thật | **BLOCKED** (Gateway chưa có endpoint nhận) |

QA: Postgres `zalocrm-v2-qa-db` (127.0.0.1:5443, DB `zalocrm_v2_qa`), Redis `zalocrm-v2-qa-redis` (127.0.0.1:6381) — container riêng,
**không** dùng DB/Redis pilot (5442/6380). Gateway QA DB: `ccg_sender_v2_int`, `_int2`, `_int3` (lượt cuối) trên container Gateway local.

## 3. Schema / migration `20260923000000_gateway_sender_v2`
Chỉ tạo bảng/index/FK mới (+1 FK từ bảng mới tới `zalo_accounts`); không sửa bảng cũ. Viết tay từ `migrate diff`, **loại bỏ**
các khác biệt có sẵn của upstream (drop index `contacts_pool_robin_idx` …) không thuộc task.
- `gateway_sender_clients`, `gateway_channel_accounts`, `gateway_login_attempts`, `gateway_delivery_attempts`, `gateway_health_outbox`.
- Ràng buộc DB: `channel_account_id` unique (một account chỉ thuộc một client); `zalo_account_id` unique (1 account ↔ 1 nick);
  unique `(client_ref, delivery_attempt_id)`; FK kép `(account_ref, client_ref)`; CHECK trạng thái; CHECK `SENT ⇒ provider_message_id`;
  partial unique tối đa 1 phiên QR mở / account.
- Lưu ý drift: CHECK/partial unique/FK kép viết tay nên `prisma migrate diff` sẽ luôn đề xuất bỏ — không được dùng `migrate dev`.
- Back-relation `ZaloAccount.gatewayChannelAccount` thêm vào schema.

## 4. Mapping Gateway account → nick/phiên, cách ly
- `channelAccountId` (UUID Gateway) → `gateway_channel_accounts` → đúng một `zalo_accounts` (nick). Nick thuộc org của client,
  owner là service user của client. Tái sử dụng **ZaloAccountPool** sẵn có: mỗi nick một instance zca-js (cookie/imei/listener riêng).
- Không dùng biến môi trường account cố định cho v2. Client A không thấy/điều khiển account của B; account của B và id ngẫu nhiên → **cùng một 404**.
- Khởi động lại: `app.ts` nối lại từng nick bằng phiên của chính nó (luồng boot sẵn có); `recoverOnBoot()` đóng các QR đang mở (EXPIRED) và xoá nick tạm.
- **Sửa lỗi upstream phá cách ly** (`zalo-pool.ts`): khi một nick connect, vòng "dọn ghost" ngắt **mọi** instance `qr_pending` trong pool
  (mọi org/owner). Nay chỉ ngắt đúng các ghost vừa cập nhật và loại trừ nick do Gateway quản lý. Test: account 2 đang chờ QR không bị ngắt khi account 1 connect.

## 5. Xác thực request
Header `x-gateway-client-id|timestamp|nonce|account-id|signature`; `HMAC-SHA256(key, METHOD\nPATH\nTS\nNONCE\nSHA256(rawBody))`.
- Kiểm trên **raw body** (parser riêng trong plugin, giới hạn 64 KB); GET dùng body rỗng. Test: cùng JSON khác khoảng trắng → 401.
- Lệch giờ ≤ 300 s; so sánh chữ ký kiểm độ dài trước `timingSafeEqual`; chữ ký + timestamp kiểm **trước** nonce và trước khi chạm phiên Zalo.
- Nonce Redis `SET NX EX 600` theo client, namespace `gwv2:` (v1 giữ `gateway:`). Redis lỗi → 503 `REPLAY_STORE_UNAVAILABLE`.
- Header account phải khớp `:id` (route account) hoặc `channelAccountId` trong body (send) → khác = 401.
- Signing key lưu AES-256-GCM (`GATEWAY_SENDER_ENC_KEY`); xoay khoá có khoá cũ hiệu lực trong thời gian ân hạn; thu hồi client.
- Không log signature/key/cookie/số điện thoại.

## 6. QR theo account
- `login/start` → `{loginId, qrImage: data:image/png;base64,…, expiresAt}` (≤ 3 phút). zca-js bỏ tiền tố data URL → provider thêm lại.
- Chưa có nick → tạo **nick tạm**; hết hạn / thất bại / bị thay → xoá nick tạm **trong cùng transaction** với việc đóng phiên (không nick rác).
- QR mới đánh dấu QR cũ SUPERSEDED (đọc ra EXPIRED). `maxQrRetry=1`: QR đã trả cho Gateway không tự sinh lại.
- `login/:loginId`: PENDING/SCANNED/CONNECTED/EXPIRED/FAILED; CONNECTED kèm `displayName`, `phoneMasked` (`090****222`). loginId của account/client khác → 404.
- Đăng nhập lại bằng **tài khoản Zalo khác** → FAILED `ACCOUNT_MISMATCH`, xoá phiên, khôi phục uid cũ, account RELOGIN_REQUIRED.
- Phiên lưu mã hoá (`ZALO_SESSION_ENC_KEY`, envelope `aesgcm:v1`); mọi chỗ đọc session_data trong ZaloCRM dùng `decodeZaloSession`
  (đọc được cả dữ liệu cũ). Route **xuất credential** trả 403 cho nick do Gateway quản lý.

## 7. Preflight
Chỉ đọc bảng Friend đã đồng bộ của **đúng nick**: bạn đã chấp nhận → FRIEND; có hội thoại → CONVERSATION; còn lại NOT_FOUND;
account không sẵn sàng/đang pause → ACCOUNT_UNAVAILABLE; lỗi đọc → UNKNOWN. Test chứng minh số dòng contacts/friends/conversations không đổi
và provider không bị gọi hàm nào. Provider không có API kết bạn/tạo hội thoại/tìm người lạ.
Giới hạn: NOT_FOUND nghĩa là "không phải người quen đã đồng bộ của nick này" — sender cũng sẽ từ chối gửi (nhất quán).

## 8. Idempotency — máy trạng thái
`CLAIMED` (insert `ON CONFLICT DO NOTHING`) → kiểm tra trước gửi thất bại → `NOT_SENT` (được claim lại nguyên tử, cùng hash) |
ghi `SENDING` bền vững **trước** khi gọi Zalo → `SENT(providerMessageId)` | `UNKNOWN`.
Gửi lại: hash khác → 409; SENT → cùng id; SENDING/UNKNOWN/CLAIMED → UNKNOWN, không gửi mù. Zalo trả muộn kèm msgId sau timeout → SENT.
Giữ ≥ 7 ngày (cron 03:30 hằng ngày; yêu cầu < 7 bị nâng lên 7).
**Phát hiện**: `zaloOps.exec` (upstream) tự thử lại `sendMessage` tối đa 3 lần khi lỗi mạng + 1 lần sau reconnect → có thể gửi trùng.
v2 gọi `api.sendMessage` **đúng một lần**. Route v1 pilot vẫn dùng `zaloOps.sendMessage` (giữ nguyên hành vi pilot) — rủi ro trùng của v1 còn đó.

## 9. Phân loại kết quả
SENT → 200 `{delivery:SENT, providerMessageId}`. NOT_SENT (423/404/429/400): ACCOUNT_UNAVAILABLE, RELOGIN_REQUIRED, ACCOUNT_RESTRICTED,
RATE_LIMITED (kiểm limiter trước gửi), ACCOUNT_PAUSED, RECIPIENT_NOT_FOUND, INVALID_REQUEST. UNKNOWN (502): ZALO_TIMEOUT (8 s < 10 s của Gateway),
ZALO_SEND_ERROR, SENT_WITHOUT_MESSAGE_ID, PREVIOUS_OUTCOME_UNKNOWN, ATTEMPT_IN_PROGRESS. Không bao giờ đổi UNKNOWN thành NOT_SENT.

## 10. Khoá theo account; pause / resume / disconnect
- `KeyedMutex` theo account: login-start, xử lý connected, pause, resume, disconnect và **toàn bộ send (kể cả chờ Zalo)** chạy nối tiếp trong một account;
  account khác không bị chặn. Phạm vi một tiến trình (chống trùng xuyên tiến trình do ràng buộc DB). Test: send đang chạy xong rồi mới disconnect; sau disconnect không gọi Zalo.
- Pause: chặn gửi mới, không xoá phiên, không ảnh hưởng account khác. Resume: chỉ khi phiên còn sống, ngược lại 409 `RELOGIN_REQUIRED`/`ACCOUNT_UNAVAILABLE`.
- Disconnect: đóng QR mở, dừng listener/socket đúng nick, xoá phiên (`disconnectReason=manual` → không tự nối lại), `sessionVersion++`, outbox DISCONNECTED.

## 11. Test
- **Độc lập (HTTP thật, DB/Redis QA, Zalo giả)** — 2 client × 2 account:
  - A. Xác thực: đúng, sai khoá, body sửa, timestamp cũ, nonce lặp, raw body, Redis lỗi, header ≠ path, A→B và id ngẫu nhiên cùng 404, một channelAccountId không đăng ký cho client thứ hai.
  - B. Cách ly: 4 nick/4 phiên khác nhau, gửi đúng nick, pause/disconnect/login lại một account không ảnh hưởng account khác, mismatch uid, restart khôi phục đúng mapping.
  - C. QR: start/scanned/connected/expired/failed/hết hạn theo thời gian/QR mới vô hiệu QR cũ/loginId account khác/không trả cookie/phiên lưu mã hoá.
  - D. Preflight: 5 kết quả, không ghi dữ liệu, không thấy khách của nick khác.
  - E. Idempotency: 10 request đồng thời → 1 lời gọi; SENT trả lại cùng id; 409; crash sau SENDING; timeout + xác nhận muộn; 2xx không id; lỗi SDK; NOT_SENT rồi gửi lại; RELOGIN; body sai; ràng buộc DB; giữ 7 ngày.
  - F. Resume khi hết phiên; send ↔ disconnect đồng thời. G. v1 tắt mặc định / bật rõ ràng / sai khoá / không trùng clientId v2. Health outbox (ký, idempotent id, backoff, không gửi khi chưa có URL).
- **Pool thật + zca-js giả**: QR qua hook (tiền tố data URL), không ngắt QR account khác, phiên mã hoá, gửi đúng 1 lần kể cả lỗi mạng tạm thời, hết hạn không retry, disconnect đúng listener.
- **Tích hợp Gateway** (Gateway build hiện tại, DB QA riêng, `WORKER_ENABLED=false`, worker gọi tay; sender v2 thật qua loopback, Zalo giả):
  Gateway tạo 2 account; QR đúng hợp đồng → CONNECTED + số che; preflight chọn account 2 (account 1 ưu tiên hơn nhưng NOT_FOUND);
  2 worker → 1 lời gọi Zalo; timeout → UNKNOWN, cùng account, xếp lại; gửi lại cùng deliveryAttemptId → cùng providerMessageId, Zalo nhận 1 lần;
  pause/resume phản ánh sang sender; sender NOT_SENT ACCOUNT_PAUSED → Gateway failover sang account 2; disconnect xoá đúng phiên. 14/14 PASS.

## 12. Lệch/ghi chú hợp đồng với Gateway (không sửa Gateway)
1. Gateway không tự đăng ký account ở sender — cần người vận hành chạy `register-account` cho mỗi account mới (hoặc bổ sung endpoint đăng ký có ký ở vòng sau).
2. Gateway chỉ dùng account có phân công hoặc là mặc định (đúng thiết kế) — kịch bản QA phải tạo quy tắc.
3. Preflight của Gateway loại account đang pause phía sender trước khi gửi; NOT_SENT failover chỉ xảy ra khi pause đổi giữa preflight và gửi (hoặc account không bật preflight).
4. Resume khi phiên hết: sender trả 409 (`senderApplied=false`) nhưng Gateway vẫn bỏ pause cục bộ → lệch trạng thái tạm thời; lượt gửi sau nhận NOT_SENT (an toàn, không gửi trùng).
5. 409 IDEMPOTENCY_CONFLICT không có trường `delivery` → Gateway coi là UNKNOWN (an toàn).
6. Health callback: sender có outbox + dispatcher (tắt mặc định); Gateway chưa có endpoint → BLOCKED.

## 13. Giấy phép (đánh giá, không phải kết luận pháp lý)
- ZaloCRM: **AGPL-3.0** + điều khoản bổ sung §7(b) (giữ attribution/banner tác giả), §7(e) (không dùng tên/logo "ZaloCRM" cho bản phái sinh), có license thương mại riêng.
- zca-js/openzca: MIT (THIRD-PARTY-LICENSES.md).
- Sender v2 là **bản sửa đổi** ZaloCRM chạy dịch vụ mạng. AGPL §13 yêu cầu cung cấp mã nguồn bản sửa cho **người dùng tương tác qua mạng**.
  Sender chỉ được Gateway gọi server-to-server; việc "người dùng" ở đây là ai (Gateway của chính doanh nghiệp, hay khách CRM gián tiếp) cần tư vấn pháp lý.
  Nếu phát hành/cho bên thứ ba dùng, phải công bố mã nguồn bản sửa theo AGPL và giữ nguyên NOTICE/attribution/banner.
- Không đổi LICENSE/NOTICE/THIRD-PARTY/attribution/brand. File mới mang header `SPDX AGPL-3.0-or-later` và dòng copyright giống file pilot
  (ghi tên tác giả upstream) — **cần anh Huy/Codex chốt** dòng copyright cho phần tự viết (không xoá attribution upstream).
- Sender không được trộn vào mã Gateway (Gateway gọi qua HTTP) — giữ ranh giới giấy phép rõ; vẫn cần xác nhận pháp lý.

## 14. Chỉ fake / đã thử thật / BLOCKED
- Chỉ fake: toàn bộ phiên Zalo (provider giả + zca-js giả), QR, gửi tin, danh sách bạn bè (seed giả).
- Đã thử với Zalo thật: **không có**.
- BLOCKED: Docker build (mạng Alpine CDN), health callback Gateway, thử nghiệm Zalo thật (chờ duyệt), chạy nhiều tiến trình sender (không hỗ trợ).
- Ghi chú upstream khác: extension `strip-null-bytes` biến `Prisma.JsonNull` thành `{}` (phiên bị "xoá" thành `{}` — không giải mã được, an toàn, nhưng không phải NULL).

## 15. File
Mới: `backend/src/modules/gateway-v2/{gateway-v2-types,zalo-session-provider,pool-session-provider,gateway-v2-auth,account-lock,gateway-v2-service,gateway-v2-registry,gateway-v2-health}.ts`,
`backend/src/shared/zalo-session-codec.ts`, `backend/scripts/gateway-v2-admin.ts`, migration `20260923000000_gateway_sender_v2`,
`backend/tests/gateway-v2.integration.test.ts`, `backend/tests/gateway-v2-pool.integration.test.ts`, `docs/gateway-sender-v2.md`, báo cáo này.
Sửa: `backend/prisma/schema.prisma`, `backend/src/modules/api/gateway-sender-routes.ts` (pilot), `backend/src/app.ts` (pilot + bảo trì v2 khi boot),
`backend/src/modules/zalo/zalo-pool.ts` (hook login, maxQrRetry, vá ghost cleanup, mã hoá phiên), `credential-routes.ts`, `zalo-routes.ts`,
`zalo-dashboard-routes.ts`, `zalo-health-check.ts`, `backend/src/shared/zalo-operations.ts` (đọc phiên mã hoá), `backend/.env.example`.
Không sửa: frontend, customer-care-gateway, Platform/B2B, LICENSE/NOTICE/THIRD-PARTY.

Chạy test v2: `GATEWAY_V2_QA=1 DATABASE_URL=<QA> REDIS_URL=<QA> npx vitest run tests/gateway-v2.integration.test.ts tests/gateway-v2-pool.integration.test.ts`
(không có `GATEWAY_V2_QA=1` → tự bỏ qua trong bộ test thường).
