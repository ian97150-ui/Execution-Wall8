ALTER TABLE "trade_intents" ADD COLUMN "wait_watch_until" TIMESTAMP(3);
ALTER TABLE "execution_settings" ADD COLUMN "pushover_on_wait_upgrade" BOOLEAN NOT NULL DEFAULT true;
