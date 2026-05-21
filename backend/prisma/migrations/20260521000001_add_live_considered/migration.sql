CREATE TABLE "live_considered" (
    "id"          TEXT NOT NULL,
    "record_id"   TEXT NOT NULL,
    "ticker"      TEXT NOT NULL,
    "date"        TEXT NOT NULL,
    "outcome"     TEXT NOT NULL,
    "record_json" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "live_considered_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "live_considered_record_id_key" ON "live_considered"("record_id");
CREATE INDEX "live_considered_ticker_date_idx" ON "live_considered"("ticker", "date");
