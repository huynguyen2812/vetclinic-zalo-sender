-- Standalone PC edition: PostgreSQL replay store for contract v2 (replaces Redis in sender-only mode).
-- Additive, forward-only.
CREATE TABLE "gateway_v2_nonces" (
    "client_id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gateway_v2_nonces_pkey" PRIMARY KEY ("client_id", "nonce")
);
CREATE INDEX "gateway_v2_nonces_expires_at_idx" ON "gateway_v2_nonces"("expires_at");
