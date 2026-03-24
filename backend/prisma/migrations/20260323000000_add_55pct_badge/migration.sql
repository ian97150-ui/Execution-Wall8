-- Add day_peak_move and peak_move_updated_at to ticker_configs
ALTER TABLE "ticker_configs" ADD COLUMN IF NOT EXISTS "day_peak_move" DOUBLE PRECISION;
ALTER TABLE "ticker_configs" ADD COLUMN IF NOT EXISTS "peak_move_updated_at" TIMESTAMP(3);
