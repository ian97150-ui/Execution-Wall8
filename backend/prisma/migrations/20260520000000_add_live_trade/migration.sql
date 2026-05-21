-- CreateTable
CREATE TABLE "live_trades" (
    "id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "intent_id" TEXT,
    "record_json" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_trades_record_id_key" ON "live_trades"("record_id");

-- CreateIndex
CREATE INDEX "live_trades_ticker_date_idx" ON "live_trades"("ticker", "date");
