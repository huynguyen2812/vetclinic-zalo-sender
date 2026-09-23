# Báo cáo vòng 2 — Tích hợp Gateway ↔ Sender Zalo V2 (Claude, 2026-09-23/24)

Tiếp nối `claude-multi-zalo-sender-v2-2026-09-23.md`. Không làm lại từ đầu; không reset/clean/stash/checkout.
**Chưa commit / push / PR / deploy.** Dừng chờ Codex review.

| Mảng | Trạng thái |
|---|---|
| Code đã viết (sender + Gateway) | Xong vòng 2, chờ review |
| Test với Zalo giả | PASS (chi tiết §10) |
| Docker build + smoke | PASS (build 2/2 thành công; smoke đạt, xem §7) |
| Zalo thật | NOT RUN (không được phép) |
| Production-ready | **KHÔNG** — chưa thử Zalo thật được duyệt |

## 1. Git
- Sender `D:\DuAn\ZaloCRM-upstream`, nhánh `feat/multi-zalo-sender-v2`, HEAD `8664567` (không commit mới).
- Gateway `D:\DuAn\customer-care-gateway`, nhánh `feat/vetclinic-crm-customer-ui`, HEAD `0714a79` (không commit mới).
- Pilot được bảo toàn: `.pilot-files/`, `frontend/.env.local`, `docker-compose.gateway-pilot.yml`,
  `backend/scripts/pilot-authorized-send.ts` không đụng. `backend/.env` local không sửa thêm ở vòng này
  (vòng 1 đã thêm `GATEWAY_SENDER_V1_ENABLED=true` để pilot local không tắt). 2 file `customer-care-gateway-*.tar.gz` không đụng.
- Không có AGENTS.md/CLAUDE.md trong hai repo; không đổi git config global.

## 2. Health callback phía Gateway — PASS
- Mới: `src/channel/sender-health.controller.ts`, route `POST /api/v1/channel/accounts/:id/health` (ngoài CRM session).
- Xác thực: chữ ký HMAC trên **raw body** bằng khoá của chính account (account phải được đăng ký bởi đúng sender client
  ký request), timestamp ±5 phút, nonce một lần (`ControlNonce`, tiền tố `sender:`), header account phải khớp path.
  Mọi lỗi xác thực (sai chữ ký, body sửa, quá hạn, nonce lặp, account lạ, account của client/tenant khác) → **cùng 401**.
- Tenant lấy từ account trong DB, không tin tenant từ request. Trạng thái: CONNECTED, DISCONNECTED, RELOGIN_REQUIRED,
  RESTRICTED, PAUSED. `eventId` idempotent (bảng `SenderHealthEvent`, PK eventId) — lặp/đồng thời → áp dụng đúng 1 lần.
  Sự kiện cũ hơn sự kiện đã áp dụng → `STALE`. `PAUSED` chỉ áp khi account đang CONNECTED (không che RELOGIN/RESTRICTED).
- Audit `ZALO_ACCOUNT_SENDER_HEALTH`: eventId/status/reason/trạng thái trước — không cookie, phiên, khoá hay số đầy đủ.
- Migration Gateway `0008_sender_health_events` (forward-only, FK kép `(account, tenant)`, CHECK status).
- Sender: phát thêm sự kiện PAUSED (pause thật), CONNECTED (resume thật), RELOGIN_REQUIRED (QR bằng tài khoản Zalo khác).
  Chưa phát mất kết nối thụ động (pool chưa có hook) — ghi rủi ro §11.

## 3. Tự động đăng ký account — PASS
- Sender: `POST /internal/v1/accounts/:id/register` (ký như mọi v2). Client suy từ chữ ký (không chọn được client/tenant khác),
  idempotent, đồng thời an toàn (unique + đọc lại), id của client khác / đã thu hồi → 404 như id lạ.
- Gateway: `ZaloAccountsService.create` tự đăng ký khi `SENDER_V2_BASE_URL/CLIENT_ID/SIGNING_KEY` được cấu hình;
  chỉ ghi cấu hình gửi khi sender xác nhận. Sender chưa sẵn sàng → account vẫn tạo, không có cấu hình gửi, không dùng
  được, `login/start` → 503 `SENDER_REGISTRATION_PENDING`; CRM có `POST /crm/zalo-accounts/:id/sender/register` và nút
  "Thử đăng ký lại". Đăng ký ≠ kết nối (vẫn `PENDING_LOGIN`).
- Script `gateway-v2-admin.ts` giữ cho `register-client` (một lần / deployment) và khôi phục sự cố; sửa để chạy được trong
  image Docker (tự dùng `dist/`).

## 4. Resume nhất quán — PASS
- Gateway `setPaused`: khoá tuần tự theo account. **Pause**: khoá ở Gateway trước, rồi báo sender.
  **Resume**: hỏi sender trước; chỉ khi sender trả `{ok:true, paused:false}` mới bỏ pause (và đặt CONNECTED).
  Sender 409 RELOGIN_REQUIRED → giữ pause + status RELOGIN_REQUIRED + 409 báo đăng nhập lại; 409 khác → 409
  ACCOUNT_UNAVAILABLE; timeout / không kết nối / 200 sai dạng / 5xx → 503 SENDER_UNAVAILABLE, giữ pause.
- Test: mất phiên, unavailable, timeout, phản hồi không xác định, trong lúc chờ sender vẫn pause (không có cửa sổ),
  hai resume đồng thời (sender chỉ bị hỏi 1 lần), cả qua HTTP CRM và qua tích hợp chéo.
- Adapter Gateway: `controlDetailed()` phân biệt APPLIED/REJECTED/UNSUPPORTED/UNKNOWN; `control()` cũ giữ nguyên chữ ký.

## 5. Pilot V1 — PASS (sửa được, có test)
- Rủi ro đã xác định: `zaloOps.sendMessage` → `exec()` thử lại tối đa 3 lần khi lỗi mạng tạm thời và thêm 1 lần sau khi tự
  reconnect phiên → **có thể gửi trùng**; ngoài ra v1 bịa `providerMessageId = personal:<ref>` khi thiếu id.
- Sửa: v1 gọi `api.sendMessage` đúng MỘT lần (kiểm rate-limit trước), lỗi sau khi gọi → 502 `SEND_FAILED` (Gateway: UNKNOWN,
  không gửi lại mù), không bịa id. Giữ nguyên mã/HTTP status khác của pilot.
- Test (pool thật + zca-js giả): lỗi mạng tạm thời → đúng 1 lời gọi SDK, 502; thành công → id thật.
- Mặc định `GATEWAY_SENDER_V1_ENABLED=false` trong `.env.example`. Không chuyển production sang V2.
- Hệ quả: pilot không còn tự reconnect+gửi lại khi phiên hết hạn giữa chừng (an toàn hơn, nhưng tin đó thành "chưa rõ").

## 6. Dependency — `npm audit --omit=dev`
Trước: 39 (15 moderate / 23 high / 1 critical). Sau nâng có chọn lọc: **35 (15 / 20 / 0)**.
- Đã sửa (trong cùng major, chỉ `package-lock.json`, `package.json` không đổi): `fastify` 5.8.4→5.12.5 (DIRECT, runtime sender:
  bypass schema qua Content-Type), `fast-jwt` 6.1.0→6.3.3 (**critical**, gián tiếp qua `@fastify/jwt`, runtime đăng nhập CRM),
  `fast-uri` 3.1.0→3.1.8, `find-my-way` 9.5.0→9.9.0. Hồi quy: 369/43 như baseline, test v2 39/39, build/typecheck đạt,
  image Docker chứa bản mới (kiểm trong container).
- Còn lại (không tự sửa — cần kế hoạch riêng):

| Gói | Trực tiếp? | Runtime sender? | Bản vá |
|---|---|---|---|
| `@fastify/static` ≤10.1.1 | DIRECT | Có (phục vụ frontend tĩnh) | 10.1.4 — **major** |
| `sharp` ≤0.35.4-rc.0 (libvips CVE) | DIRECT | Có (xử lý ảnh) | 0.35.4 — **major** |
| `image-size` ≤2.0.2 | DIRECT | Có (đọc kích thước ảnh gửi) | non-breaking |
| `engine.io`, `ws`, `socket.io-parser` | gián tiếp (socket.io) | Có (UI realtime) | non-breaking |
| `form-data`, `ip-address`, `tmp`, `brace-expansion`, `defu`, `hono`, `lodash` | gián tiếp | Chủ yếu qua tooling/SDK | non-breaking / qua prisma |
| `prisma`, `@prisma/config`, `@prisma/dev`, `@hono/node-server`, `deepmerge-ts`, `effect`, `mysql2` | gián tiếp (CLI prisma) | Không (CLI/migrate) | prisma@6.19.3 — **major đổi hướng (hạ từ 7)** |
Đề xuất: đợt riêng nâng `image-size` + nhóm socket.io (non-breaking) kèm test UI; `sharp`/`@fastify/static` cần kiểm thử ảnh/static.

## 7. Docker — PASS
- Build 1/2 (`zalocrm-sender-v2-qa:r2`): thành công. Build 2/2 (sau khi cập nhật lockfile): thành công. Vòng 1 từng lỗi I/O Alpine CDN — lần này mạng ổn, không đổi mirror/TLS.
- Smoke trên image (DB QA riêng `zalocrm_v2_docker_smoke`, Redis QA db 5):
  - `migrate deploy` trong container: áp 109 migration; chạy lần 2: "No pending migrations" — PASS.
  - Container `zalocrm-sender-v2-smoke`: `/health` → `{"status":"ok","db":"connected"}` — PASS.
  - `register-client` trong container — **lần đầu FAIL** (script trỏ `src/`, image chỉ có `dist/`); đã sửa script, kiểm bằng cách
    chép script mới vào container → PASS. **Image hiện tại chưa chứa bản sửa script này** (không build lần 3 theo giới hạn) — cần build lại.
  - API ký: register 200 (+ lần 2 200), pause 200, resume khi không có phiên 409 RELOGIN_REQUIRED, sai khoá 401,
    account lạ 404, send khi chưa kết nối 423 NOT_SENT — PASS. Không có QR/Zalo thật.
  - `docker stop` (SIGTERM): log "[shutdown] … đóng gọn xong", exit 0 — PASS. Log không chứa signingKey/cookie.

## 8. Giấy phép / bản quyền (không phải kết luận pháp lý)
- Không thay đổi `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`, attribution hay banner upstream (git diff trống cho các file này).
- **Đã gỡ** dòng `Copyright (C) 2026 Nguyễn Tiến Lộc` khỏi các file **mới** (không chính xác: tác giả upstream không viết code này),
  giữ `SPDX-License-Identifier: AGPL-3.0-or-later`, thêm dòng "là phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE)" và
  một dòng đánh dấu chủ thể bản quyền còn để ngỏ (đã thay ở vòng sửa cuối — xem báo cáo final-review-fixes). 13 file mới:
  `backend/src/modules/gateway-v2/{account-lock,gateway-v2-auth,gateway-v2-health,gateway-v2-registry,gateway-v2-service,gateway-v2-types,pool-session-provider,zalo-session-provider}.ts`,
  `backend/src/shared/zalo-session-codec.ts`, `backend/scripts/gateway-v2-admin.ts`, `backend/tests/gateway-v2.integration.test.ts`,
  `backend/tests/gateway-v2-pool.integration.test.ts`, `backend/src/modules/api/gateway-sender-routes.ts` (file pilot do Codex tạo, nay chứa code mới).
  `backend/scripts/pilot-authorized-send.ts` (pilot) không có header — không đụng. Migration SQL không có header.
- File upstream bị **sửa** (giữ nguyên header tác giả upstream — đúng): `zalo-pool.ts`, `zalo-operations.ts`, `credential-routes.ts`,
  `zalo-routes.ts`, `zalo-dashboard-routes.ts`, `zalo-health-check.ts`, `app.ts`, `schema.prisma`, `.env.example`.
- Đề xuất để anh Huy/Codex chọn: (a) `Copyright (C) 2026 <pháp nhân VETCLINIC>` cho file mới; (b) ghi nhóm tác giả
  "VETCLINIC contributors"; (c) tách sender thành fork riêng đã đổi tên (NOTICE §7(e) cấm dùng tên "ZaloCRM" cho bản phái sinh).
  Kèm lưu ý AGPL §13: nếu người dùng bên ngoài tương tác qua mạng với bản sửa, phải cung cấp mã nguồn — cần tư vấn pháp lý.
- Sender và Gateway vẫn tách repo, database, secrets; giao tiếp HTTP.

## 9. Migration
- Sender `20260923000000_gateway_sender_v2`: không đổi ở vòng 2 (endpoint register dùng bảng sẵn có). Deploy lần 2 trên DB QA
  và trong container: không pending — PASS.
- Gateway `0008_sender_health_events`: DB QA mới `ccg_sender_r2_qa` và `ccg_sender_r2_int` — áp 8 migration, lần 2 "No pending" — PASS.
  `migrate diff` chỉ còn drift đã biết `ZaloRoutingRule_scope_key` (NULLS NOT DISTINCT).

## 10. QA
| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Sender typecheck/build | `npx tsc --noEmit -p .`, `npm run build` | PASS |
| Sender test v2 (HTTP thật + Postgres/Redis QA, Zalo giả) | `GATEWAY_V2_QA=1 DATABASE_URL=<5443/zalocrm_v2_qa> REDIS_URL=<6381> npx vitest run tests/gateway-v2.integration.test.ts tests/gateway-v2-pool.integration.test.ts` | PASS 39/39 (+3 test mới: đăng ký, health pause/resume, v1 không retry) |
| Sender toàn bộ vs baseline HEAD sạch | `npx vitest run` (so từng tên test) | 369 pass / 43 fail — **giống hệt baseline**, 0 lỗi mới → không hồi quy (43 lỗi có sẵn của upstream) |
| Gateway build/typecheck + web | `npm run build`, `tsc --noEmit`, `npm run build:web` | PASS |
| Gateway unit | `npm test` | PASS 22/22 |
| Gateway integration | `DATABASE_URL=<ccg_sender_r2_qa> npm run test:integration` | PASS 95/95 (18 test mới `sender-v2-gateway.integration.spec.ts`) |
| Tích hợp chéo (sender thật + Zalo giả ↔ Gateway, HTTP thật, 2 tenant × 2 account) | harness scratchpad `gw-int/sender-harness-r2.mts` + `gateway-driver-r2.cjs` | PASS 17/17 |

Tích hợp chéo chứng minh: tự đăng ký 4 account; đăng ký lại idempotent; tenant A không đọc/đăng ký/pause/resume/disconnect/
đăng nhập account của B (404); QR giả → CONNECTED; health CONNECTED ×4 qua HTTP đúng account/tenant, dispatch lại không gửi lặp;
4 worker × 2 job → đúng 2 lời gọi Zalo, mỗi tenant chỉ dùng account của mình; timeout → UNKNOWN không failover, gửi lại cùng
deliveryAttemptId → cùng id, Zalo nhận 1 lần; mất phiên → resume RELOGIN_REQUIRED, Gateway giữ pause; 2 resume đồng thời
nhất quán; health PAUSED/CONNECTED/DISCONNECTED qua HTTP; audit không lộ khoá/cookie/số.
Test Gateway riêng phủ: replay (nonce lặp), sai chữ ký, body sửa, timestamp cũ, header khác path, id lạ, account của client khác,
eventId lặp + đồng thời, sự kiện trễ, trạng thái sai, sender down khi tạo account, timeout/unknown khi resume.

Không dùng DB/Redis production hay pilot (5442/6380). Không có Zalo thật.

## 11. Rủi ro / còn thiếu
- Zalo thật: NOT RUN — cần thử nghiệm được duyệt trước khi production.
- Mất kết nối thụ động (Zalo/mạng rớt) chưa phát health event; Gateway chỉ biết qua kết quả gửi / resume.
- Một tiến trình sender (khoá theo account trong bộ nhớ); nhiều tiến trình không được hỗ trợ.
- Gateway dùng một sender client cho cả deployment; cách ly tenant ở sender dựa trên Gateway (đã test) + mapping per-account.
- Image `zalocrm-sender-v2-qa:r2` chưa có bản sửa `gateway-v2-admin.ts` (cần build lại).
- Dependency còn 20 high (bảng §6).

## 12. File (vòng 2)
Sender — sửa: `backend/src/modules/gateway-v2/gateway-v2-service.ts` (register, health pause/resume/mismatch),
`backend/src/modules/api/gateway-sender-routes.ts` (route register, v1 không retry), `backend/scripts/gateway-v2-admin.ts`
(dist/src), header 13 file mới, `backend/.env.example`, `backend/package-lock.json`, `backend/tests/gateway-v2*.test.ts`,
`docs/gateway-sender-v2.md`; mới: báo cáo này.
Gateway — mới: `src/channel/sender-health.controller.ts`, `prisma/migrations/0008_sender_health_events/`,
`test/sender-v2-gateway.integration.spec.ts`; sửa: `prisma/schema.prisma`, `src/app.module.ts`,
`src/channel/personal-zalo.adapter.ts`, `src/crm/zalo-accounts.service.ts`, `src/crm/crm.controller.ts`, `package.json`,
`.env.example`, `web/src/lib/api.ts`, `web/src/pages/ZaloChannel.tsx`, `docs/{api-contract,security,status,multi-zalo-sender-contract}.md`.

## 13. Tài nguyên QA còn giữ (chưa xoá — chờ Codex review)
- Container `zalocrm-v2-qa-db` (127.0.0.1:5443; DB `zalocrm_v2_qa`, `zalocrm_v2_docker_smoke`), `zalocrm-v2-qa-redis` (127.0.0.1:6381),
  container đã dừng `zalocrm-sender-v2-smoke`, image `zalocrm-sender-v2-qa:r2` (1.3 GB).
- Trên `customer-care-gateway-postgres-1`: DB `ccg_sender_v2_int`, `_int2`, `_int3` (vòng 1), `ccg_sender_r2_qa`, `ccg_sender_r2_int` (vòng 2),
  cùng các DB QA của task CRM trước.
- Scratchpad: harness/driver `gw-int/*`, baseline `zcrm-before.json`, `package-lock.before-r2.json`, log Docker.
- Dữ liệu QA trong `zalocrm_v2_qa`: các org/client/account/outbox giả do test tạo (tự dọn phần lớn; outbox cũ của client
  không có URL còn lại — vô hại).
