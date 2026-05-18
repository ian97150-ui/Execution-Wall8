/**
 * Price action signals sourced from the Tradier official API.
 * Replaces the previous Yahoo Finance unofficial API implementation.
 * Requires TRADIER_API_KEY env var; returns null fields + error when missing.
 */

import { fetchTimesales, fetchDailyBars, fetchQuote } from './tradierService';

// ─── ET helpers ──────────────────────────────────────────────────────────────

function isRTHOpen(): boolean {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat', 'Sun'].includes(day)) return false;
  const etHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
  );
  const totalMin = etHour * 60 + now.getMinutes();
  return totalMin >= 570 && totalMin < 960; // 9:30–16:00
}

function fmtDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function fmtDateTime(d: Date, h: number, m: number): string {
  return `${fmtDate(d)} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getPriorTradingDay(nowET: Date): Date {
  const d = new Date(nowET);
  d.setDate(d.getDate() - 1);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() - 1);
  return d;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceActionResult {
  market_open: boolean;
  // AH (prior day after-hours 16:00–20:00 ET)
  ah_high: number | null;
  ah_low: number | null;
  ah_move_pct: number | null;         // ((ah_high - prior_close) / prior_close) * 100
  ah_vol_ratio: number | null;        // AH volume / prior RTH volume
  ah_classification: 'THIN_AH_SPIKE' | 'HEALTHY_AH_BUILD' | null;
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
  efficiency: number | null;          // intraday_move_pct / vol_ratio
  structure: 'BLOW_OFF_TOP' | 'WEAK_HOLD' | 'STRONG_HOLD' | 'RANGE' | null;
  error?: string;
}

// ─── getPriceActionSignals ───────────────────────────────────────────────────

export async function getPriceActionSignals(ticker: string): Promise<PriceActionResult> {
  const base: PriceActionResult = {
    market_open: false,
    ah_high: null, ah_low: null, ah_move_pct: null,
    ah_vol_ratio: null, ah_classification: null, ah_reversal_pct: null,
    prior_close: null, gap_pct: null, pm_high: null,
    rth_open: null, pm_high_reclaimed: null,
    vwap: null, vwap_failed: null, wick_ratio: null,
    volume_ratio: null, day_of_run: null,
    current_price: null, intraday_move_pct: null, efficiency: null, structure: null,
  };

  if (!process.env.TRADIER_API_KEY) {
    return { ...base, error: 'TRADIER_API_KEY not configured' };
  }

  try {
    // Current ET date/time and prior trading day
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const priorDay = getPriorTradingDay(nowET);
    const priorDateStr = fmtDate(priorDay);
    const todayDateStr = fmtDate(nowET);

    // Timesales range: prior day 09:00 ET → today 16:05 ET (captures prior RTH + AH + PM + today)
    const tsStart = fmtDateTime(priorDay, 9, 0);
    const tsEnd   = fmtDateTime(nowET, 16, 5);

    // Daily bars range: 35 calendar days back → today
    const dailyStart = fmtDate(new Date(Date.now() - 35 * 86_400_000));

    const [bars, dailyBars, quote] = await Promise.all([
      fetchTimesales(ticker, tsStart, tsEnd, 'all'),
      fetchDailyBars(ticker, dailyStart, todayDateStr),
      fetchQuote(ticker),
    ]);

    base.market_open = isRTHOpen();

    // ── Bucket 1-min bars ────────────────────────────────────────────────────
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

    for (const bar of bars) {
      // Tradier time field is 'YYYY-MM-DDTHH:MM:SS' in ET — no timezone math needed
      const barDate = bar.time.substring(0, 10); // 'YYYY-MM-DD'
      const barTime = bar.time.substring(11, 16); // 'HH:MM'
      const { high: h, low: l, close: c, open: o, volume: v } = bar;
      if (!h || !l || !c) continue;

      if (barDate === priorDateStr && barTime >= '09:30' && barTime < '16:00') {
        // Prior day RTH — last close is prior_close
        priorClose = c;
        priorRthVol += v;
      } else if (barDate === priorDateStr && barTime >= '16:00' && barTime < '20:00') {
        // Prior day AH
        if (ahHigh === null || h > ahHigh) ahHigh = h;
        if (ahLow === null || l < ahLow) ahLow = l;
        ahVol += v;
      } else if (
        (barDate === priorDateStr && barTime >= '20:00') ||
        (barDate === todayDateStr && barTime < '09:30')
      ) {
        // Today pre-market (prior 20:00 → today 9:30)
        if (pmHigh === null || h > pmHigh) pmHigh = h;
      } else if (barDate === todayDateStr && barTime >= '09:30') {
        // Today RTH
        if (rthOpenPrice === null) rthOpenPrice = o || c;
        rthCandles.push({ h, l, c, v, o: o || c });
        currentPrice = c;
        if (maxHighSinceOpen === null || h > maxHighSinceOpen) maxHighSinceOpen = h;
      }
    }

    base.prior_close  = priorClose;
    base.pm_high      = pmHigh;
    base.rth_open     = rthOpenPrice;
    base.current_price = currentPrice;

    // Intraday move %
    if (maxHighSinceOpen !== null && rthOpenPrice !== null && rthOpenPrice > 0) {
      base.intraday_move_pct = parseFloat(
        (((maxHighSinceOpen - rthOpenPrice) / rthOpenPrice) * 100).toFixed(2)
      );
    }

    const todayRthVol = rthCandles.reduce((s, cd) => s + cd.v, 0);

    // AH derived fields
    if (ahHigh !== null) {
      base.ah_high = ahHigh;
      base.ah_low  = ahLow;
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

    // PM high reclaimed at open
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
        ? parseFloat((sumUpperWick / sumRange).toFixed(3)) : null;
    }

    // ── Daily bars: volume_ratio + day_of_run + prior_close fallback ─────────
    const validDaily = dailyBars.filter(b => b.close != null && b.volume != null && b.volume > 0);
    if (validDaily.length >= 2) {
      const priorBars = validDaily.filter(b => b.date < todayDateStr);
      const priorVols = priorBars.map(b => b.volume).filter(v => v > 0);
      if (priorVols.length > 0 && todayRthVol > 0) {
        const avgVol = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
        if (avgVol > 0) base.volume_ratio = parseFloat((todayRthVol / avgVol).toFixed(2));
      }

      // Fallback prior_close from daily if intraday didn't capture it
      if (base.prior_close === null && priorBars.length > 0) {
        base.prior_close = priorBars[priorBars.length - 1].close;
        if (base.pm_high !== null && base.prior_close !== null) {
          base.gap_pct = parseFloat(
            (((base.pm_high - base.prior_close) / base.prior_close) * 100).toFixed(2)
          );
        }
      }

      // day_of_run: consecutive days where close >= 70% of most recent close
      const closes = validDaily.map(b => b.close);
      const threshold = closes[closes.length - 1] * 0.7;
      let runDays = 0;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] >= threshold) runDays++;
        else break;
      }
      base.day_of_run = runDays;
    }

    // ── Tradier quote: current_price + volume_ratio + prior_close fallbacks ──
    if (quote) {
      if (!base.current_price && quote.last) base.current_price = quote.last;
      if (!base.volume_ratio && quote.volume > 0 && quote.average_volume > 0) {
        base.volume_ratio = parseFloat((quote.volume / quote.average_volume).toFixed(2));
      }
      if (!base.prior_close && quote.prevclose) {
        base.prior_close = quote.prevclose;
        if (base.pm_high !== null) {
          base.gap_pct = parseFloat(
            (((base.pm_high - base.prior_close) / base.prior_close) * 100).toFixed(2)
          );
        }
      }
    }

    // Efficiency = intraday_move_pct / volume_ratio
    if (base.intraday_move_pct !== null && base.volume_ratio !== null && base.volume_ratio > 0) {
      base.efficiency = parseFloat(
        (base.intraday_move_pct / Math.max(base.volume_ratio, 0.01)).toFixed(3)
      );
    }

    // Auto-classify structure
    if (base.wick_ratio !== null && base.vwap_failed === true && base.wick_ratio > 0.70) {
      base.structure = 'BLOW_OFF_TOP';
    } else if (base.pm_high_reclaimed === true && base.vwap_failed === false) {
      base.structure = 'STRONG_HOLD';
    } else if (base.pm_high_reclaimed === false && base.efficiency !== null && base.efficiency < 0.50) {
      base.structure = 'WEAK_HOLD';
    } else if (base.wick_ratio !== null || base.pm_high_reclaimed !== null) {
      base.structure = 'RANGE';
    }

    return base;
  } catch (err: any) {
    return { ...base, error: err.message };
  }
}
