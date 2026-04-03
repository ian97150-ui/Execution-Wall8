/**
 * Yahoo Finance unofficial API — price action signals for short-selling analysis.
 * All functions return typed results with optional `error` field; never throws.
 * Works for low-frequency use (~5-20 calls/day per ticker).
 */

const TIMEOUT_MS = 8000;

// ET timezone offset helpers
function isRTHOpen(): boolean {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat', 'Sun'].includes(day)) return false;
  const etHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
  );
  const etMin = now.getMinutes();
  const totalMin = etHour * 60 + etMin;
  return totalMin >= 570 && totalMin < 960; // 9:30=570, 16:00=960
}

function getETOffsetMs(date: Date): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(utcStr);
  return date.getTime() - etDate.getTime();
}

function getRTHBoundaryUnix(dateInET: Date): { open: number; close: number } {
  const open = new Date(dateInET);
  open.setHours(9, 30, 0, 0);
  const close = new Date(dateInET);
  close.setHours(16, 0, 0, 0);
  const etOffset = getETOffsetMs(open);
  return {
    open: Math.floor((open.getTime() + etOffset) / 1000),
    close: Math.floor((close.getTime() + etOffset) / 1000)
  };
}

function getAHBoundaryUnix(dateInET: Date): { open: number; close: number } {
  // Prior day AH: 16:00–20:00 ET
  const open = new Date(dateInET);
  open.setHours(16, 0, 0, 0);
  const close = new Date(dateInET);
  close.setHours(20, 0, 0, 0);
  const etOffset = getETOffsetMs(open);
  return {
    open: Math.floor((open.getTime() + etOffset) / 1000),
    close: Math.floor((close.getTime() + etOffset) / 1000)
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceActionResult {
  market_open: boolean;
  // AH (prior day after-hours)
  ah_high: number | null;
  ah_low: number | null;
  ah_move_pct: number | null;         // ((ah_high - prior_close) / prior_close) * 100
  ah_vol_ratio: number | null;        // AH volume / prior RTH volume
  ah_classification: 'THIN_AH_SPIKE' | 'HEALTHY_AH_BUILD' | null;  // >= 0.20 = HEALTHY
  ah_reversal_pct: number | null;     // ((pm_high - ah_high) / ah_high) * 100; negative = faded
  // PM + gap
  prior_close: number | null;
  gap_pct: number | null;             // ((pm_high - prior_close) / prior_close) * 100
  pm_high: number | null;
  // RTH
  rth_open: number | null;
  pm_high_reclaimed: boolean | null;
  vwap: number | null;
  vwap_failed: boolean | null;
  wick_ratio: number | null;          // > 0.65 = distribution
  volume_ratio: number | null;        // today / 30d avg
  day_of_run: number | null;
  current_price: number | null;
  intraday_move_pct: number | null;   // (max_high_since_rth_open - rth_open) / rth_open * 100
  efficiency: number | null;          // intraday_move_pct / vol_ratio — demand vs supply quality
  error?: string;
}

// ─── getPriceActionSignals ───────────────────────────────────────────────────

export async function getPriceActionSignals(ticker: string): Promise<PriceActionResult> {
  const base: PriceActionResult = {
    market_open: false,
    ah_high: null,
    ah_low: null,
    ah_move_pct: null,
    ah_vol_ratio: null,
    ah_classification: null,
    ah_reversal_pct: null,
    prior_close: null,
    gap_pct: null,
    pm_high: null,
    rth_open: null,
    pm_high_reclaimed: null,
    vwap: null,
    vwap_failed: null,
    wick_ratio: null,
    volume_ratio: null,
    day_of_run: null,
    current_price: null,
    intraday_move_pct: null,
    efficiency: null
  };

  try {
    // Parallel fetch: 2d intraday 1m (captures prior AH) + quoteSummary + 10d daily
    const [intradayRes, quoteRes, dailyRes] = await Promise.all([
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=2d&includePrePost=true`,
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

        const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

        // Prior trading day (skip weekends back to Friday)
        const priorDay = new Date(nowET);
        priorDay.setDate(priorDay.getDate() - 1);
        while ([0, 6].includes(priorDay.getDay())) priorDay.setDate(priorDay.getDate() - 1);

        const priorRTH = getRTHBoundaryUnix(priorDay);
        const priorAH = getAHBoundaryUnix(priorDay);
        const todayRTH = getRTHBoundaryUnix(nowET);

        base.market_open = isRTHOpen();

        // Four-bucket accumulators
        let priorClose: number | null = null;
        let priorRthVol = 0;
        let ahHigh: number | null = null;
        let ahLow: number | null = null;
        let ahVol = 0;
        let pmHigh: number | null = null;
        let rthOpenPrice: number | null = null;
        let currentPrice: number | null = null;
        let maxHighSinceOpen: number | null = null;
        const rthCandles: { h: number; l: number; c: number; v: number; o: number }[] = [];

        for (let i = 0; i < timestamps.length; i++) {
          const ts = timestamps[i];
          const h = highs[i], l = lows[i], c = closes[i], o = opens[i], v = volumes[i];
          if (h == null || l == null || c == null) continue;

          if (ts >= priorRTH.open && ts < priorRTH.close) {
            // Prior day RTH — last close = prior_close, accumulate vol
            priorClose = c;
            priorRthVol += v || 0;
          } else if (ts >= priorAH.open && ts < priorAH.close) {
            // Prior day AH (16:00–20:00 ET)
            if (ahHigh === null || h > ahHigh) ahHigh = h;
            if (ahLow === null || l < ahLow) ahLow = l;
            ahVol += v || 0;
          } else if (ts >= priorAH.close && ts < todayRTH.open) {
            // Today's pre-market (20:00 prior → 9:30 today)
            if (pmHigh === null || h > pmHigh) pmHigh = h;
          } else if (ts >= todayRTH.open) {
            // Today RTH
            if (rthOpenPrice === null) rthOpenPrice = o || c;
            rthCandles.push({ h, l, c, v: v || 0, o: o || c });
            currentPrice = c;
            if (maxHighSinceOpen === null || h > maxHighSinceOpen) maxHighSinceOpen = h;
          }
        }

        base.prior_close = priorClose;
        base.pm_high = pmHigh;
        base.rth_open = rthOpenPrice;
        base.current_price = currentPrice;

        // Intraday move % + efficiency
        if (maxHighSinceOpen !== null && rthOpenPrice !== null && rthOpenPrice > 0) {
          base.intraday_move_pct = parseFloat(
            (((maxHighSinceOpen - rthOpenPrice) / rthOpenPrice) * 100).toFixed(2)
          );
        }

        // AH derived fields
        if (ahHigh !== null) {
          base.ah_high = ahHigh;
          base.ah_low = ahLow;
          base.ah_vol_ratio = priorRthVol > 0
            ? parseFloat((ahVol / priorRthVol).toFixed(3)) : null;
          base.ah_classification = base.ah_vol_ratio !== null
            ? (base.ah_vol_ratio >= 0.20 ? 'HEALTHY_AH_BUILD' : 'THIN_AH_SPIKE') : null;
          if (priorClose !== null) {
            base.ah_move_pct = parseFloat(
              (((ahHigh - priorClose) / priorClose) * 100).toFixed(2)
            );
          }
          if (pmHigh !== null) {
            base.ah_reversal_pct = parseFloat(
              (((pmHigh - ahHigh) / ahHigh) * 100).toFixed(2)
            );
          }
        }

        // Gap %
        if (pmHigh !== null && priorClose !== null) {
          base.gap_pct = parseFloat(
            (((pmHigh - priorClose) / priorClose) * 100).toFixed(2)
          );
        }

        // PM high reclaimed at RTH open
        if (pmHigh !== null && rthOpenPrice !== null) {
          base.pm_high_reclaimed = rthOpenPrice >= pmHigh;
        }

        // VWAP (RTH candles only)
        if (rthCandles.length > 0) {
          let sumTPV = 0, sumV = 0;
          for (const cd of rthCandles) {
            const tp = (cd.h + cd.l + cd.c) / 3;
            sumTPV += tp * cd.v;
            sumV += cd.v;
          }
          base.vwap = sumV > 0 ? parseFloat((sumTPV / sumV).toFixed(4)) : null;

          if (base.vwap !== null && currentPrice !== null) {
            const first30 = rthCandles.slice(0, 30);
            const reclaimedVwap = first30.some(cd => cd.c >= base.vwap!);
            base.vwap_failed = currentPrice < base.vwap && !reclaimedVwap;
          }
        }

        // Wick ratio (first 12 RTH candles) — > 0.65 = distribution
        const first12 = rthCandles.slice(0, 12);
        if (first12.length >= 3) {
          let sumUpperWick = 0, sumRange = 0;
          for (const cd of first12) {
            sumUpperWick += cd.h - cd.c;
            sumRange += cd.h - cd.l;
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

    // Efficiency computed after vol_ratio is available
    if (base.intraday_move_pct !== null && base.volume_ratio !== null) {
      const cappedVol = Math.max(base.volume_ratio, 0.01);
      base.efficiency = parseFloat((base.intraday_move_pct / cappedVol).toFixed(3));
    }

    // ── Day of run + prior_close fallback (10d daily) ─────────────────────────
    if (dailyRes.ok) {
      const dailyData = await dailyRes.json() as any;
      const result = dailyData?.chart?.result?.[0];
      if (result) {
        const closes: number[] = result.indicators?.quote?.[0]?.close || [];
        const validCloses = closes.filter((c: any) => c != null);
        if (validCloses.length >= 2) {
          // Fallback prior_close from daily if intraday didn't capture prior RTH
          if (base.prior_close === null) {
            base.prior_close = validCloses[validCloses.length - 2];
            // Recompute gap_pct with fallback prior_close
            if (base.pm_high !== null) {
              base.gap_pct = parseFloat(
                (((base.pm_high - base.prior_close) / base.prior_close) * 100).toFixed(2)
              );
            }
          }
          const currentClose = validCloses[validCloses.length - 1];
          const threshold = currentClose * 0.7;
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
