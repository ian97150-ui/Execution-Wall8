-- Add SEC watch/confirm fields to trade_intents
ALTER TABLE "trade_intents" ADD COLUMN "sec_watch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "trade_intents" ADD COLUMN "sec_confirmed" BOOLEAN NOT NULL DEFAULT false;
