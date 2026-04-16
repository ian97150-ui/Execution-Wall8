-- Add TTP Exit SL threshold to positions
-- EXIT webhooks at or above this price are blocked (broker SL handles the close)
ALTER TABLE "positions" ADD COLUMN "ttp_exit_price" DECIMAL(10,4);
