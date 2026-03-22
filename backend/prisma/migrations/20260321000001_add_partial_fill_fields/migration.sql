-- Add partial fill tracking fields to executions
ALTER TABLE "executions" ADD COLUMN "filled_quantity" INTEGER;
ALTER TABLE "executions" ADD COLUMN "remaining_quantity" INTEGER;
