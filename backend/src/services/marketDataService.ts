/**
 * Yahoo Finance unofficial API — price action signals for short-selling analysis.
 * All functions return typed results with optional `error` field; never throws.
 * Works for low-frequency use (~5-20 calls/day per ticker).
 */

const TIMEOUT_MS = 8000;

// ET timezone offset helpers
function isRTHOpen(): boolean {
  const now = new Date();
  const etHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
  );
  const etMin = now.getMinutes();
  const totalMin = etHour * 60 + etMin;
  const dayOfWeek = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
      .replace(/[^0-6]/, '') // fallback
  );
  // Mon-Fri, 9:30–16:00
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat', 'Sun'].includes(day)) return false;
  return totalMin >= 570 && totalMin < 960; // 9:30 = 570, 16:00 = 960
}

function getRTHBoundaryUnix(dateInET: Date): { open: number; close: number } {
  // 9:30 AM ET as unix
  const open = new Date(dateInET);
  open.setHours(9, 30, 0, 0);
  const close = new Date(dateInET);
  close.setHours(16, 0, 0, 0);
  // Convert ET date to UTC unix timestamps
  const etOffset = getETOffsetMs(open);
  return {
    open: Math.floor((open.getTime() + etOffset) / 1000),
    close: Math.floor((close.getTime() + etOffset) / 1000)
  };
}

function getETOffsetMs(date: Date): number {
  // Gets the UTC offset for ET at a given date (handles DST)
  const utcStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(utcStr);
  return date.getTime() - etDate.getTime();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceActionResult {
  market_open: boolean;
  pm_high: number | null;
  rth_open: number | null;
  pm_high_reclaimed: boolean | null;
  vwap: number | null;
  vwap_failed: boolean | null;
  wick_ratio: number | null;           // > 0.65 = distribution
  volume_ratio: number | null;         // today / 30d avg
  day_of_run: number | null;
  current_price: number | null;
  error?: string;
}

// ─── getPriceActionSignals ───────────────────────────────────────────────────

export async function getPriceActionSignals(ticker: string): Promise<PriceActionResult> {
  const base: PriceActionResult = {
    market_open: false,
    pm_high: null,
    rth_open: null,
    pm_high_reclaimed: null,
    vwap: null,
    vwap_failed: null,
    wick_ratio: null,
    volume_ratio: null,
    day_of_run: null,
    current_price: null
  };

  try {
    // Parallel fetch: intraday 1m + quoteSummary + 10d daily
    const [intradayRes, quoteRes, dailyRes] = await Promise.all([
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      ),
      fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      ),
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      )
    ]);

    // ── Intraday processing ──────────────────────────────────────────────────
    if (intradayRes.ok) {
      const intradayData = await intradayRes.json() as any;
      const result = intradayData?.chart?.result?.[0];
      if (result) {
        const timestamps: number[] = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0];
        const highs: number[] = quotes?.high || [];
        const lows: number[] = quotes?.low || [];
        const closes: number[] = quotes?.close || [];
        const opens: number[] = quotes?.open || [];
        const volumes: number[] = quotes?.volume || [];

        // Determine RTH boundary
        const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const { open: rthOpenUnix } = getRTHBoundaryUnix(nowET);

        base.market_open = isRTHOpen();

        // PM high = max high before 9:30am ET
        let pmHigh: number | null = null;
        let rthOpenPrice: number | null = null;
        let currentPrice: number | null = null;

        const rthCandles: { h: number; l: number; c: number; v: number; o: number }[] = [];

        for (let i = 0; i < timestamps.length; i++) {
          const ts = timestamps[i];
          const h = highs[i], l = lows[i], c = closes[i], o = opens[i], v = volumes[i];
          if (!h || !l || !c) continue;

          if (ts < rthOpenUnix) {
            // Pre-market
            if (pmHigh === null || h > pmHigh) pmHigh = h;
          } else {
            // RTH
            if (rthOpenPrice === null) rthOpenPrice = o || c;
            rthCandles.push({ h, l, c, v: v || 0, o: o || c });
            currentPrice = c;
          }
        }

        base.pm_high = pmHigh;
        base.rth_open = rthOpenPrice;
        base.current_price = currentPrice;

        if (pmHigh !== null && rthOpenPrice !== null) {
          base.pm_high_reclaimed = rthOpenPrice >= pmHigh;
        }

        // VWAP (RTH candles)
        if (rthCandles.length > 0) {
          let sumTPV = 0, sumV = 0;
          for (const c of rthCandles) {
            const tp = (c.h + c.l + c.c) / 3;
            sumTPV += tp * c.v;
            sumV += c.v;
          }
          base.vwap = sumV > 0 ? parseFloat((sumTPV / sumV).toFixed(4)) : null;

          if (base.vwap !== null && currentPrice !== null) {
            // vwap_failed: current below VWAP + no reclaim in first 30 candles
            const first30 = rthCandles.slice(0, 30);
            const reclaimedVwap = first30.some(c => c.c >= base.vwap!);
            base.vwap_failed = currentPrice < base.vwap && !reclaimedVwap;
          }
        }

        // Wick ratio (first 12 RTH candles) — > 0.65 = distribution
        const first12 = rthCandles.slice(0, 12);
        if (first12.length >= 3) {
          let sumUpperWick = 0, sumRange = 0;
          for (const c of first12) {
            sumUpperWick += c.h - c.c;
            sumRange += c.h - c.l;
          }
          base.wick_ratio = sumRange > 0
            ? parseFloat((sumUpperWick / sumRange).toFixed(3))
            : null;
        }
      }
    }

    // ── Volume ratio ─────────────────────────────────────────────────────────
    if (quoteRes.ok) {
      const quoteData = await quoteRes.json() as any;
      const price = quoteData?.quoteSummary?.result?.[0]?.price;
      if (price) {
        const todayVol = price.regularMarketVolume?.raw;
        const avgVol = price.averageDailyVolume3Month?.raw;
        if (todayVol && avgVol && avgVol > 0) {
          base.volume_ratio = parseFloat((todayVol / avgVol).toFixed(2));
        }
        if (!base.current_price && price.regularMarketPrice?.raw) {
          base.current_price = price.regularMarketPrice.raw;
        }
      }
    }

    // ── Day of run (10d daily) ────────────────────────────────────────────────
    if (dailyRes.ok) {
      const dailyData = await dailyRes.json() as any;
      const result = dailyData?.chart?.result?.[0];
      if (result) {
        const closes: number[] = result.indicators?.quote?.[0]?.close || [];
        const validCloses = closes.filter((c: any) => c != null);
        if (validCloses.length >= 2) {
          const currentClose = validCloses[validCloses.length - 1];
          const threshold = currentClose * 0.7;
          // Find how many consecutive days close has been above threshold
          let runDays = 0;
          for (let i = validCloses.length - 1; i >= 0; i--) {
            if (validCloses[i] >= threshold) runDays++;
            else break;
          }
          base.day_of_run = runDays;
        }
      }
    }

    return base;
  } catch (err: any) {
    return { ...base, error: err.message };
  }
}
