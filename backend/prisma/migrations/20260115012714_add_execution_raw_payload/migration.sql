-- AlterTable
ALTER TABLE "executions" ADD COLUMN "dir" TEXT;
ALTER TABLE "executions" ADD COLUMN "intent_id" TEXT;
ALTER TABLE "executions" ADD COLUMN "raw_payload" TEXT;

-- CreateIndex
CREATE INDEX "executions_intent_id_idx" ON "executions"("intent_id");
