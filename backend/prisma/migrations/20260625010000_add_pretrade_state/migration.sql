-- AlterTable
ALTER TABLE "trade_intents" ADD COLUMN "pretrade_state" TEXT;
ALTER TABLE "trade_intents" ADD COLUMN "pretrade_is_distribution" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "trade_intents" ADD COLUMN "pretrade_checked_at" TIMESTAMP(3);
