-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_execution_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "execution_mode" TEXT NOT NULL DEFAULT 'safe',
    "default_delay_bars" INTEGER NOT NULL DEFAULT 2,
    "gate_threshold" INTEGER NOT NULL DEFAULT 3,
    "limit_edit_window" INTEGER NOT NULL DEFAULT 120,
    "max_adjustment_pct" DECIMAL NOT NULL DEFAULT 2.0,
    "broker_webhook_url" TEXT,
    "broker_webhook_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_notifications" BOOLEAN NOT NULL DEFAULT false,
    "notification_email" TEXT,
    "notify_on_approval" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_execution" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_close" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_execution_settings" ("created_at", "default_delay_bars", "email_notifications", "execution_mode", "gate_threshold", "id", "limit_edit_window", "max_adjustment_pct", "notification_email", "notify_on_approval", "notify_on_close", "notify_on_execution", "updated_at") SELECT "created_at", "default_delay_bars", "email_notifications", "execution_mode", "gate_threshold", "id", "limit_edit_window", "max_adjustment_pct", "notification_email", "notify_on_approval", "notify_on_close", "notify_on_execution", "updated_at" FROM "execution_settings";
DROP TABLE "execution_settings";
ALTER TABLE "new_execution_settings" RENAME TO "execution_settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
