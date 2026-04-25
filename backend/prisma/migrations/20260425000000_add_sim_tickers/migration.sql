CREATE TABLE "sim_tickers" (
  "id"          TEXT NOT NULL,
  "ticker"      TEXT NOT NULL,
  "spike_date"  TEXT NOT NULL,
  "csv_fields"  TEXT NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sim_tickers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sim_tickers_ticker_spike_date_key" ON "sim_tickers"("ticker","spike_date");
