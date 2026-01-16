-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "trade_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "quality_tier" TEXT NOT NULL,
    "quality_score" INTEGER NOT NULL,
    "price" DECIMAL NOT NULL,
    "card_state" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "primary_blocker" TEXT,
    "expires_at" DATETIME NOT NULL,
    "created_date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ticker_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "blocked_until" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "execution_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "execution_mode" TEXT NOT NULL DEFAULT 'safe',
    "default_delay_bars" INTEGER NOT NULL DEFAULT 2,
    "gate_threshold" INTEGER NOT NULL DEFAULT 3,
    "limit_edit_window" INTEGER NOT NULL DEFAULT 120,
    "max_adjustment_pct" DECIMAL NOT NULL DEFAULT 2.0,
    "email_notifications" BOOLEAN NOT NULL DEFAULT false,
    "notification_email" TEXT,
    "notify_on_approval" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_execution" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_close" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "executions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "order_action" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "limit_price" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "delay_expires_at" DATETIME,
    "executed_at" DATETIME,
    "error_message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_type" TEXT NOT NULL,
    "ticker" TEXT,
    "details" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "entry_price" DECIMAL NOT NULL,
    "opened_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" DATETIME,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "wall_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_type" TEXT NOT NULL,
    "ticker" TEXT,
    "data" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "trade_intents_card_state_idx" ON "trade_intents"("card_state");

-- CreateIndex
CREATE INDEX "trade_intents_status_idx" ON "trade_intents"("status");

-- CreateIndex
CREATE INDEX "trade_intents_ticker_idx" ON "trade_intents"("ticker");

-- CreateIndex
CREATE INDEX "trade_intents_expires_at_idx" ON "trade_intents"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ticker_configs_ticker_key" ON "ticker_configs"("ticker");

-- CreateIndex
CREATE INDEX "ticker_configs_ticker_idx" ON "ticker_configs"("ticker");

-- CreateIndex
CREATE INDEX "executions_ticker_idx" ON "executions"("ticker");

-- CreateIndex
CREATE INDEX "executions_status_idx" ON "executions"("status");

-- CreateIndex
CREATE INDEX "audit_logs_event_type_idx" ON "audit_logs"("event_type");

-- CreateIndex
CREATE INDEX "audit_logs_ticker_idx" ON "audit_logs"("ticker");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "positions_ticker_idx" ON "positions"("ticker");

-- CreateIndex
CREATE INDEX "positions_closed_at_idx" ON "positions"("closed_at");

-- CreateIndex
CREATE INDEX "webhook_logs_source_idx" ON "webhook_logs"("source");

-- CreateIndex
CREATE INDEX "webhook_logs_status_idx" ON "webhook_logs"("status");

-- CreateIndex
CREATE INDEX "webhook_logs_timestamp_idx" ON "webhook_logs"("timestamp");

-- CreateIndex
CREATE INDEX "wall_events_event_type_idx" ON "wall_events"("event_type");

-- CreateIndex
CREATE INDEX "wall_events_ticker_idx" ON "wall_events"("ticker");
