-- Add confirm_window_seconds to execution_settings
ALTER TABLE "execution_settings" ADD COLUMN "confirm_window_seconds" INTEGER NOT NULL DEFAULT 60;

-- Add fill_price and confirmed_at to executions
ALTER TABLE "executions" ADD COLUMN "fill_price" DECIMAL(65,30);
ALTER TABLE "executions" ADD COLUMN "confirmed_at" TIMESTAMP(3);
