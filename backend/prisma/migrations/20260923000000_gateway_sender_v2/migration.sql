-- Customer Care Gateway sender contract v2 (2026-09-23). Additive, forward-only.
-- Chỉ tạo bảng/index/FK mới; không sửa bảng cũ ngoài FK trỏ tới zalo_accounts.

-- CreateTable
CREATE TABLE "gateway_sender_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "signing_key_enc" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "previous_signing_key_enc" TEXT,
    "previous_key_expires_at" TIMESTAMP(3),
    "health_callback_url" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_sender_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_channel_accounts" (
    "id" TEXT NOT NULL,
    "client_ref" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "zalo_account_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_LOGIN',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "display_name" TEXT,
    "phone_masked" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "gateway_channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_login_attempts" (
    "id" TEXT NOT NULL,
    "account_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failure_code" TEXT,
    "provisional_zalo_account_id" TEXT,
    "expected_zalo_uid" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_delivery_attempts" (
    "id" TEXT NOT NULL,
    "client_ref" TEXT NOT NULL,
    "account_ref" TEXT NOT NULL,
    "delivery_attempt_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLAIMED',
    "outcome_code" TEXT,
    "provider_message_id" TEXT,
    "send_calls" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sending_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_health_outbox" (
    "id" TEXT NOT NULL,
    "account_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_health_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_sender_clients_client_id_key" ON "gateway_sender_clients"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_channel_accounts_channel_account_id_key" ON "gateway_channel_accounts"("channel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_channel_accounts_zalo_account_id_key" ON "gateway_channel_accounts"("zalo_account_id");

-- CreateIndex
CREATE INDEX "gateway_channel_accounts_client_ref_idx" ON "gateway_channel_accounts"("client_ref");

-- CreateIndex
CREATE INDEX "gateway_login_attempts_account_ref_status_idx" ON "gateway_login_attempts"("account_ref", "status");

-- CreateIndex
CREATE INDEX "gateway_delivery_attempts_created_at_idx" ON "gateway_delivery_attempts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_delivery_attempts_client_ref_delivery_attempt_id_key" ON "gateway_delivery_attempts"("client_ref", "delivery_attempt_id");

-- CreateIndex
CREATE INDEX "gateway_health_outbox_delivered_at_next_attempt_at_idx" ON "gateway_health_outbox"("delivered_at", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_health_outbox_account_ref_at_key" ON "gateway_health_outbox"("account_ref", "at");

-- AddForeignKey
ALTER TABLE "gateway_channel_accounts" ADD CONSTRAINT "gateway_channel_accounts_client_ref_fkey" FOREIGN KEY ("client_ref") REFERENCES "gateway_sender_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_channel_accounts" ADD CONSTRAINT "gateway_channel_accounts_zalo_account_id_fkey" FOREIGN KEY ("zalo_account_id") REFERENCES "zalo_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_login_attempts" ADD CONSTRAINT "gateway_login_attempts_account_ref_fkey" FOREIGN KEY ("account_ref") REFERENCES "gateway_channel_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_delivery_attempts" ADD CONSTRAINT "gateway_delivery_attempts_client_ref_fkey" FOREIGN KEY ("client_ref") REFERENCES "gateway_sender_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_delivery_attempts" ADD CONSTRAINT "gateway_delivery_attempts_account_ref_fkey" FOREIGN KEY ("account_ref") REFERENCES "gateway_channel_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_health_outbox" ADD CONSTRAINT "gateway_health_outbox_account_ref_fkey" FOREIGN KEY ("account_ref") REFERENCES "gateway_channel_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Ràng buộc bổ sung (Prisma không biểu diễn được) ──────────────────────────
-- Trạng thái hợp lệ.
ALTER TABLE "gateway_channel_accounts" ADD CONSTRAINT "gateway_channel_accounts_status_check"
  CHECK ("status" IN ('PENDING_LOGIN','CONNECTING','CONNECTED','RELOGIN_REQUIRED','RESTRICTED','DISCONNECTED','REVOKED'));
ALTER TABLE "gateway_login_attempts" ADD CONSTRAINT "gateway_login_attempts_status_check"
  CHECK ("status" IN ('PENDING','SCANNED','CONNECTED','EXPIRED','FAILED','SUPERSEDED'));
ALTER TABLE "gateway_delivery_attempts" ADD CONSTRAINT "gateway_delivery_attempts_state_check"
  CHECK ("state" IN ('CLAIMED','NOT_SENT','SENDING','SENT','UNKNOWN'));
-- SENT bắt buộc có providerMessageId.
ALTER TABLE "gateway_delivery_attempts" ADD CONSTRAINT "gateway_delivery_attempts_sent_has_id_check"
  CHECK ("state" <> 'SENT' OR "provider_message_id" IS NOT NULL);
-- Tối đa 1 phiên QR đang mở / account.
CREATE UNIQUE INDEX "gateway_login_attempts_one_open_per_account"
  ON "gateway_login_attempts"("account_ref") WHERE "status" IN ('PENDING','SCANNED');
-- Attempt chỉ thuộc account của CHÍNH client đó (FK kép).
CREATE UNIQUE INDEX "gateway_channel_accounts_id_client_ref_key" ON "gateway_channel_accounts"("id", "client_ref");
ALTER TABLE "gateway_delivery_attempts" ADD CONSTRAINT "gateway_delivery_attempts_account_client_fkey"
  FOREIGN KEY ("account_ref", "client_ref") REFERENCES "gateway_channel_accounts"("id", "client_ref") ON DELETE RESTRICT ON UPDATE CASCADE;
