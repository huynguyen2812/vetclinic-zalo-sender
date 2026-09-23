# Báo cáo vòng sửa cuối theo review Codex — Sender Zalo V2 + Customer Care Gateway (Claude, 2026-09-24)

Tiếp nối `claude-multi-zalo-sender-v2-round-2-2026-09-23.md`. Không reset/clean/stash/checkout; không ghi đè thay đổi có sẵn.
**Chưa commit / push / PR / deploy.** Zalo thật: **NOT RUN**. **Không production-ready** (chưa thử nghiệm Zalo thật được duyệt).

| # | Hạng mục | Kết quả |
|---|---|---|
| 1 | Bản quyền file mới | PASS |
| 2 | Race condition health callback | PASS |
| 3 | `.gitignore` file nhạy cảm / tạm | PASS |
| 4 | Xác minh AI-SYNC | PASS (đã cập nhật đúng file, xem §4) |
| 5 | Docker rebuild từ mã nguồn cuối + smoke | PASS |
| 6 | QA Sender / Gateway / tích hợp chéo | PASS (số liệu §6) |
| — | Zalo thật (QR, đăng nhập, gửi) | NOT RUN |
| — | Production | NOT RUN — không deploy, không migration production |

## 1. Bản quyền — PASS
- Anh Huy xác nhận là chủ sở hữu phần mã mới; tên pháp lý thể hiện trong copyright notice sẽ bổ sung trước khi phát hành.
- Đã xoá dòng "Chủ thể bản quyền phần mã mới: CHỜ QUYẾT ĐỊNH" khỏi 13 file mới; không còn cụm "chờ quyết định" ở bất kỳ file nào
  trong hai repo (grep toàn repo, trừ node_modules: 0 kết quả). Không ghi tên tác giả upstream cho code mới; không đoán tên pháp nhân.
- Header hiện tại của file mới (2 dòng):
  `// SPDX-License-Identifier: AGPL-3.0-or-later`
  `// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.`
  File: `backend/src/modules/gateway-v2/{account-lock,gateway-v2-auth,gateway-v2-health,gateway-v2-registry,gateway-v2-service,gateway-v2-types,pool-session-provider,zalo-session-provider}.ts`,
  `backend/src/shared/zalo-session-codec.ts`, `backend/scripts/gateway-v2-admin.ts`, `backend/src/modules/api/gateway-sender-routes.ts`,
  `backend/tests/gateway-v2.integration.test.ts`, `backend/tests/gateway-v2-pool.integration.test.ts`.
- `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`: `git diff` trống. Attribution, banner, header tác giả trong file upstream bị sửa: giữ nguyên.
- `docs/gateway-sender-v2.md` §"Bản quyền file mới" và báo cáo vòng 2 đã cập nhật theo câu trên.

## 2. Race condition health callback — PASS
File: `customer-care-gateway/src/channel/sender-health.controller.ts`; migration mới `prisma/migrations/0009_sender_health_ordering`
(forward-only: thêm cột `ZaloAccount.lastSenderEventAt`, backfill từ `SenderHealthEvent` đã APPLIED).
- Không còn quyết định dựa trên `account` đọc trước transaction (object đó chỉ dùng để xác thực chữ ký + lấy tenant từ DB).
- Trong một transaction:
  1. `INSERT … ON CONFLICT ("eventId") DO NOTHING` — eventId trùng (kể cả đồng thời) chỉ một bên chèn; bên kia chờ commit rồi trả kết quả đã lưu (`duplicate: true`).
  2. `UPDATE "ZaloAccount"` có điều kiện: đúng id + tenant, chưa thu hồi, `status <> REVOKED` (PAUSED ⇒ chỉ khi đang `CONNECTED`),
     `lastSenderEventAt IS NULL OR < occurredAt`; set `status`, `lastSenderEventAt`. PostgreSQL tuần tự hoá UPDATE cùng dòng và đánh giá lại
     điều kiện trên dữ liệu đã commit → sự kiện cũ commit sau không ghi đè sự kiện mới.
  3. Không cập nhật được → đọc dòng đã commit (không khoá) để ghi `STALE` / `IGNORED`; ghi kết quả vào sự kiện + audit.
- Lỗi thật phát hiện khi viết test: bản đầu dùng `SELECT … FOR UPDATE` ở bước 3 → **deadlock 40P01** với khoá KEY SHARE mà INSERT sự kiện
  (khoá ngoại) của transaction khác giữ. Đã bỏ `FOR UPDATE` (quyết định đã nằm ở UPDATE có điều kiện).
- Xác thực không đổi: mọi lỗi → cùng 401 (không lộ account tồn tại); tenant lấy từ DB.
- Test PostgreSQL QA thật (`test/sender-v2-gateway.integration.spec.ts`, nhóm 4 — một transaction riêng giữ khoá dòng để ép chồng lấn):
  - 2 event khác eventId đồng thời × 10 lượt (đảo thứ tự gửi): account luôn giữ event mới nhất; thực tế cả hai thứ tự commit đều xảy ra
    (event cũ STALE ở 4–9/10 lượt, các lượt còn lại event cũ áp trước rồi bị event mới ghi đè); event cũ đến sau event mới → STALE.
  - Event cũ gửi trước / mới gửi sau cùng chờ khoá → cuối cùng CONNECTED (mới); DISCONNECTED cũ đến sau → STALE.
  - 8 event ngẫu nhiên đồng thời → trạng thái = event có occurredAt lớn nhất, `lastSenderEventAt` đúng.
  - 4 callback cùng eventId khi dòng bị khoá → 1 bản ghi, 3 duplicate, 1 audit.
  - RELOGIN_REQUIRED mới rồi PAUSED cũ hơn → STALE; PAUSED mới hơn khi không CONNECTED → IGNORED; vẫn RELOGIN_REQUIRED.
  - Account bị thu hồi trong lúc callback chờ khoá → IGNORED, vẫn REVOKED, `lastSenderEventAt` không đổi.
  - Callback account tenant A không đổi trạng thái / mốc / updatedAt của account tenant B; sự kiện ghi đúng tenant A.
  Chạy 3 lần liên tiếp: 25/25 mỗi lần.

## 3. File nhạy cảm / tạm — PASS
Không đọc/in nội dung; không xoá file nào (vẫn còn trên đĩa). Quy tắc thêm:
- `ZaloCRM-upstream/.gitignore`: `/.pilot-files/`, `/frontend/.env.local`, `/docker-compose.gateway-pilot.yml`, `/backend/scripts/pilot-authorized-send.ts`.
- `customer-care-gateway/.gitignore`: `/customer-care-gateway-*.tar.gz`.
- `ZaloCRM-upstream/.dockerignore`: `backend/scripts/pilot-authorized-send.ts`, `.pilot-files` (để image không chứa script có số điện thoại thật).

`git check-ignore -v` (kết quả thật):
```
.gitignore:55:/frontend/.env.local	frontend/.env.local
.gitignore:54:/.pilot-files/	.pilot-files/
.gitignore:54:/.pilot-files/	.pilot-files/media/12cd6dea….jpg
.gitignore:56:/docker-compose.gateway-pilot.yml	docker-compose.gateway-pilot.yml
.gitignore:57:/backend/scripts/pilot-authorized-send.ts	backend/scripts/pilot-authorized-send.ts
.gitignore:3:.env	backend/.env
.gitignore:16:/customer-care-gateway-*.tar.gz	customer-care-gateway-0714a79.tar.gz     (Gateway)
.gitignore:16:/customer-care-gateway-*.tar.gz	customer-care-gateway-d6c9d19.tar.gz     (Gateway)
```
**Không nên commit:** `frontend/.env.local`; `.pilot-files/` (ảnh media pilot); `docker-compose.gateway-pilot.yml` (mật khẩu DB local ghi cứng);
`backend/scripts/pilot-authorized-send.ts` (chứa số điện thoại thật + id account pilot); `backend/.env` (đã bị ignore sẵn);
2 file `customer-care-gateway-*.tar.gz` (archive source). Quét toàn bộ untracked (`--untracked-files=all`) theo mẫu
`.env|.pem|.key|secret|credential|token|.tar|.gz|.zip|.sql|.dump|.bak|.log|scratch|backup|id_rsa|.sqlite`: ngoài các mục trên chỉ còn
file `migration.sql` hợp lệ. Scratchpad nằm ngoài repo. Không dùng `git add .`.

## 4. AI-SYNC — PASS
- File điều phối đúng: **`D:\DuAn\b2b-sales-management\AI-SYNC.md`**. Bằng chứng: `AGENTS.md` của repo này quy định file trạng thái sống
  `AI-SYNC.md` ở gốc repo (gitignored — `git check-ignore` → `.gitignore:15:AI-SYNC.md`); file có mục Codex
  "tiếp quản Customer Care Gateway" và các mục Claude của chuỗi task CRM/Sender; đây là thư mục làm việc chính của phiên.
- `D:\DuAn\b2b-sales-essential-regression-20260913-01\AI-SYNC.md`: **không bị sửa** (sửa lần cuối 13/09, 0 mục Sender/CRM).
- Chỉ thêm mục Claude mới ở đầu file; không sửa mục của Codex/người khác.

## 5. Docker — PASS
- Image mới: **`zalocrm-sender-v2-qa:r3-final`**, ID `sha256:4600bcf32901ab459b31280cfd5d236b11416d889c4ebb60062aab3790f2685f`,
  build `--no-cache` từ working tree cuối, thành công lần 1 (Alpine CDN ổn; không đổi mirror/TLS). Image cũ `:r2` giữ nguyên, không ghi đè.
  (Một lần build bị em chủ động huỷ trước khi xong để thêm `.dockerignore` cho script pilot — không tạo image.)
- Nội dung đã kiểm trong image: `scripts/gateway-v2-admin.ts` là **bản đã sửa** (tự chọn `dist/`), 32 file `dist/modules/gateway-v2/`,
  `dist/modules/api/gateway-sender-routes.js` có route register, `fast-jwt 6.3.3`, `fastify 5.12.5` (package-lock mới), **không có**
  `pilot-authorized-send.ts` và `.pilot-files`.
- Smoke (DB QA mới `zalocrm_v2_docker_final`, Redis QA db 6, container `zalocrm-sender-v2-final-smoke`, **không chép file nào vào container**):
  | Bước | Kết quả |
  |---|---|
  | `prisma migrate deploy` lần 1 | "All migrations have been successfully applied" (109) — PASS |
  | lần 2 | "No pending migrations to apply" — PASS |
  | `/health` | `{"status":"ok","db":"connected"}` — PASS |
  | `npx tsx scripts/gateway-v2-admin.ts register-client / register-account / rotate-key` trong image | PASS |
  | Đăng ký account bằng API ký (+ lặp lại) | 200 / 200, capability v2 — PASS |
  | Sai chữ ký | 401 — PASS |
  | Account lạ | 404 `NOT_FOUND` (không lộ) — PASS |
  | Gửi khi chưa kết nối | 423 `{"delivery":"NOT_SENT","code":"ACCOUNT_UNAVAILABLE"}` — PASS |
  | SIGTERM (`docker stop`) | "[shutdown] … đóng gọn xong", exit 0 — PASS |
  | Log chứa signing key / cookie / sessionData / imei / số đầy đủ | 0 lần — PASS |

## 6. QA
| Kiểm tra | Kết quả |
|---|---|
| Sender typecheck `tsc --noEmit`, build `npm run build` | PASS |
| Sender V2 (HTTP thật + Postgres `zalocrm_v2_qa` 5443 + Redis 6381, Zalo giả): `tests/gateway-v2.integration.test.ts` + `tests/gateway-v2-pool.integration.test.ts` | PASS 39/39 (gồm test V1 không retry mù: lỗi mạng → đúng 1 lời gọi SDK, 502) |
| Sender toàn bộ `npx vitest run` so với baseline HEAD sạch | 474 test: 369 pass / 43 fail / 62 skip; baseline 435: 369 / 43 / 23. **0 lỗi mới, 0 suite lỗi mới** (43 lỗi + 72 suite lỗi có sẵn của upstream) |
| Sender `npm audit --omit=dev` | 35: **critical 0**, high 20, moderate 15 (bảng phân loại ở báo cáo vòng 2 §6, không đổi) |
| Gateway build, `tsc --noEmit`, `npm run build:web` | PASS |
| Gateway unit `npm test` | PASS 22/22 |
| Gateway integration `npm run test:integration` (DB QA mới `ccg_sender_final_qa`) | PASS 102/102 (7 suite; `sender-v2-gateway` 25 test gồm 7 test đồng thời mới) |
| Gateway migration 0008 + 0009 trên DB QA mới; lần 2 | Áp thành công; lần 2 "No pending migrations" — PASS. `migrate diff` chỉ còn drift đã biết `ZaloRoutingRule_scope_key` |
| Test concurrency health callback (chạy riêng 3 lần) | PASS 25/25 × 3 |
| Tích hợp chéo Gateway ↔ Sender qua HTTP thật (harness sender thật + Zalo giả, Gateway build hiện tại, DB `ccg_sender_final_int3`) | PASS 18/18 |

Tích hợp chéo: 2 tenant × 2 account tự đăng ký; đăng ký lại idempotent; tenant A không đọc/đăng ký/pause/resume/disconnect/đăng nhập
account B (404); QR giả → CONNECTED; health CONNECTED ×4 qua HTTP, dispatch lại không lặp; 4 worker × 2 job → đúng 2 lời gọi Zalo,
đúng tenant; timeout → UNKNOWN không failover, gửi lại cùng deliveryAttemptId → cùng id, Zalo nhận 1 lần; pause/resume/mất phiên/
2 resume đồng thời; health PAUSED/CONNECTED/DISCONNECTED; **mới:** 6 lượt cặp health event đồng thời + đảo thứ tự qua HTTP (account luôn
RESTRICTED = event mới, event cũ STALE, tenant B không đổi); audit không lộ khoá/cookie/số.
Không dùng DB/Redis production hay pilot (5442/6380).

## 7. File sửa / mới (vòng này)
- Sender — sửa: header 13 file mới (liệt kê §1), `.gitignore`, `.dockerignore`, `docs/gateway-sender-v2.md`,
  `docs/qa/claude-multi-zalo-sender-v2-round-2-2026-09-23.md`; mới: báo cáo này.
- Gateway — sửa: `src/channel/sender-health.controller.ts`, `prisma/schema.prisma`, `test/sender-v2-gateway.integration.spec.ts`,
  `.gitignore`, `docs/api-contract.md`, `docs/status.md`; mới: `prisma/migrations/0009_sender_health_ordering/migration.sql`.
- Toàn bộ thay đổi tích luỹ chưa commit của hai repo: xem `git status` (Sender HEAD `8664567`, nhánh `feat/multi-zalo-sender-v2`;
  Gateway HEAD `0714a79`, nhánh `feat/vetclinic-crm-customer-ui`).

## 8. Dependency
Critical 0 (đã xử lý `fast-jwt` ở vòng 2). High 20 còn lại: `@fastify/static`, `sharp` (bản vá là major), `image-size`, nhóm
`socket.io/engine.io/ws`, và nhóm CLI `prisma` — cần đợt nâng cấp riêng có test (không tự sửa).

## 9. Tài nguyên QA còn giữ cho Codex (chưa xoá)
- Container: `zalocrm-v2-qa-db` (127.0.0.1:5443; DB `zalocrm_v2_qa`, `zalocrm_v2_docker_smoke`, `zalocrm_v2_docker_final`),
  `zalocrm-v2-qa-redis` (127.0.0.1:6381), đã dừng: `zalocrm-sender-v2-smoke`, `zalocrm-sender-v2-final-smoke`.
- Image: `zalocrm-sender-v2-qa:r3-final` (duyệt), `zalocrm-sender-v2-qa:r2` (cũ, không dùng).
- Trên `customer-care-gateway-postgres-1`: `ccg_sender_final_qa`, `ccg_sender_final_int`, `_int2`, `_int3` (vòng này);
  `ccg_sender_r3_qa`, `ccg_sender_r2_qa`, `ccg_sender_r2_int`, `ccg_sender_v2_int*` (vòng trước) và DB QA của các task CRM trước.
- Scratchpad (ngoài repo): harness/driver `gw-int/*`, kết quả `gw-int/gateway-integration-final-results.json`, baseline test, log Docker.
