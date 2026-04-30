-- Add exit_require_approval flag to execution_settings
ALTER TABLE "execution_settings" ADD COLUMN "exit_require_approval" BOOLEAN NOT NULL DEFAULT false;
