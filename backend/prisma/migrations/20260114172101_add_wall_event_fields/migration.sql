-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_trade_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "strategy_id" TEXT,
    "timeframe" TEXT,
    "gates_hit" INTEGER NOT NULL DEFAULT 0,
    "gates_total" INTEGER NOT NULL DEFAULT 0,
    "confidence" REAL NOT NULL DEFAULT 0,
    "quality_tier" TEXT NOT NULL DEFAULT 'C',
    "quality_score" INTEGER NOT NULL DEFAULT 50,
    "card_state" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "primary_blocker" TEXT,
    "intent_data" TEXT,
    "gates_data" TEXT,
    "raw_payload" TEXT,
    "expires_at" DATETIME NOT NULL,
    "created_date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_trade_intents" ("card_state", "created_date", "dir", "expires_at", "id", "price", "primary_blocker", "quality_score", "quality_tier", "status", "ticker", "updated_at") SELECT "card_state", "created_date", "dir", "expires_at", "id", "price", "primary_blocker", "quality_score", "quality_tier", "status", "ticker", "updated_at" FROM "trade_intents";
DROP TABLE "trade_intents";
ALTER TABLE "new_trade_intents" RENAME TO "trade_intents";
CREATE INDEX "trade_intents_card_state_idx" ON "trade_intents"("card_state");
CREATE INDEX "trade_intents_status_idx" ON "trade_intents"("status");
CREATE INDEX "trade_intents_ticker_idx" ON "trade_intents"("ticker");
CREATE INDEX "trade_intents_strategy_id_idx" ON "trade_intents"("strategy_id");
CREATE INDEX "trade_intents_confidence_idx" ON "trade_intents"("confidence");
CREATE INDEX "trade_intents_expires_at_idx" ON "trade_intents"("expires_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
