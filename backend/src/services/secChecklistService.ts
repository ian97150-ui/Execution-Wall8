/**
 * SEC Checklist Service — orchestrates EDGAR, Finnhub, and Yahoo Finance
 * into a single structured checklist with short-bias label.
 */

import { getShelfAndFilingHistory, getRecentEightKText, EightKResult, ShelfHistory } from './edgarService';
import { getAnalystCoverage, getShortInterest, getRecentNews, AnalystCoverage, ShortInterestResult, NewsItem } from './finnhubService';
import { getPriceActionSignals, PriceActionResult } from './marketDataService';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChecklistBias =
  | 'OFFERING_LIVE'
  | 'ATM_LIVE'
  | 'PRIME_SHORT'
  | 'TRAP_SETUP'
  | 'CLEAN_TAPE'
  | 'NO_DATA';

export interface SecChecklist {
  ticker: string;
  run_at: string;
  version: 4;

  phase1: {
    complete: boolean;
    shelf_type: string | null;
    shelf_date: string | null;
    shelf_age_days: number | null;
    prior_424b_count_12m: number;
    same_day_424b: { form: string; filing_url: string }[];
    eightk: EightKResult;
    analyst: AnalystCoverage;
    error?: string;
  };

  phase2: {
    catalyst_tier: 1 | 2 | 3 | 4 | null;
    proceeds_type: 'MILESTONE' | 'LOSSES' | 'UNKNOWN' | null;
    news_fallback: NewsItem[];
    sympathy_trade: boolean | null;   // MANUAL
  };

  phase3: {
    market_open: boolean;
    pm_high: number | null;
    rth_open: number | null;
    pm_high_reclaimed: boolean | null;
    vwap: number | null;
    vwap_failed: boolean | null;
    wick_ratio: number | null;
    volume_ratio: number | null;
    day_of_run: number | null;
    current_price: number | null;
    pm_high_override: boolean | null;   // MANUAL
    vwap_override: boolean | null;      // MANUAL
    error?: string;
  };

  phase4: {
    shares_outstanding: number | null;
    short_interest: number | null;
    short_float_pct: number | null;
    short_date: string | null;
    error?: string;
  };

  bias: ChecklistBias;
  short_signal_count: number;
  completion_pct: number;
}

// ─── Bias hierarchy ───────────────────────────────────────────────────────────

function computeBias(checklist: Omit<SecChecklist, 'bias' | 'short_signal_count' | 'completion_pct'>): ChecklistBias {
  const { phase1 } = checklist;

  if (phase1.error && !phase1.shelf_type && phase1.prior_424b_count_12m === 0) {
    return 'NO_DATA';
  }

  // 1. Same-day 424B filed = live offering
  if (phase1.same_day_424b.length > 0) return 'OFFERING_LIVE';

  // 2. 8-K signals ATM terminated or underwriting done
  if (
    phase1.eightk.signals.includes('ATM_TERMINATED') ||
    phase1.eightk.signals.includes('UNDERWRITING_DONE')
  ) return 'ATM_LIVE';

  // 3. Shelf + serial diluter (2+ 424Bs in 12m)
  if (phase1.shelf_type && phase1.prior_424b_count_12m >= 2) return 'PRIME_SHORT';

  // 4. Shelf exists (any count)
  if (phase1.shelf_type) return 'TRAP_SETUP';

  // 5. Clean tape
  if (!phase1.shelf_type && phase1.prior_424b_count_12m === 0) return 'CLEAN_TAPE';

  return 'NO_DATA';
}

function computeShortSignals(checklist: Omit<SecChecklist, 'bias' | 'short_signal_count' | 'completion_pct'>): number {
  let count = 0;
  const { phase1, phase2, phase3 } = checklist;

  if (phase1.same_day_424b.length > 0) count++;
  if (phase1.eightk.signals.length > 0) count++;
  if (phase1.shelf_type && phase1.prior_424b_count_12m >= 2) count++;
  if (phase1.analyst.analyst_bias === 'BEARISH') count++;
  if (phase2.proceeds_type === 'LOSSES') count++;
  if (phase2.catalyst_tier !== null && phase2.catalyst_tier >= 3) count++;
  if (phase2.sympathy_trade === true) count++;
  if (phase3.pm_high_reclaimed === false || phase3.pm_high_override === false) count++;
  if (phase3.vwap_failed === true || phase3.vwap_override === false) count++;
  if (phase3.wick_ratio !== null && phase3.wick_ratio > 0.65) count++;

  return count;
}

function computeCompletion(checklist: Omit<SecChecklist, 'bias' | 'short_signal_count' | 'completion_pct'>): number {
  const checkpoints = [
    checklist.phase1.shelf_type !== undefined,                  // 1.1 shelf checked
    checklist.phase1.prior_424b_count_12m !== undefined,        // 1.2 424B count
    checklist.phase1.eightk.found !== undefined,                // 1.3 8-K checked
    checklist.phase1.analyst.analyst_bias !== null,             // 1.4 analyst
    checklist.phase2.catalyst_tier !== null,                    // 2.1 catalyst
    checklist.phase2.sympathy_trade !== null,                   // 2.2 sympathy MANUAL
    checklist.phase2.proceeds_type !== null,                    // 2.3 proceeds
    checklist.phase3.pm_high !== null || !checklist.phase3.market_open,  // 3.1 PM high
    checklist.phase3.vwap !== null || !checklist.phase3.market_open,     // 3.2 VWAP
    checklist.phase3.wick_ratio !== null || !checklist.phase3.market_open, // 3.3 wick
    checklist.phase3.volume_ratio !== null,                     // 3.4 volume
    checklist.phase3.day_of_run !== null,                       // 3.5 day of run
    checklist.phase4.short_float_pct !== null || checklist.phase4.shares_outstanding !== null, // 4
  ];

  const done = checkpoints.filter(Boolean).length;
  return Math.round((done / checkpoints.length) * 100);
}

// ─── runChecklist ─────────────────────────────────────────────────────────────

export async function runChecklist(ticker: string, existing?: SecChecklist | null): Promise<SecChecklist> {
  const upper = ticker.toUpperCase();

  // Preserve manual fields from existing checklist
  const manualSympathy = existing?.phase2?.sympathy_trade ?? null;
  const manualPmOverride = existing?.phase3?.pm_high_override ?? null;
  const manualVwapOverride = existing?.phase3?.vwap_override ?? null;

  // Run all data sources in parallel
  const [shelf, eightk, priceAction, analyst, shortInterest, news] = await Promise.all([
    getShelfAndFilingHistory(upper),
    getRecentEightKText(upper),
    getPriceActionSignals(upper),
    getAnalystCoverage(upper),
    getShortInterest(upper),
    getRecentNews(upper, 2)
  ]);

  const partial: Omit<SecChecklist, 'bias' | 'short_signal_count' | 'completion_pct'> = {
    ticker: upper,
    run_at: new Date().toISOString(),
    version: 4,

    phase1: {
      complete: !shelf.error,
      shelf_type: shelf.shelf_type,
      shelf_date: shelf.shelf_date,
      shelf_age_days: shelf.shelf_age_days,
      prior_424b_count_12m: shelf.prior_424b_count_12m,
      same_day_424b: shelf.same_day_424b,
      eightk,
      analyst,
      ...(shelf.error ? { error: shelf.error } : {})
    },

    phase2: {
      catalyst_tier: eightk.catalyst_tier,
      proceeds_type: eightk.proceeds_type,
      // Show news fallback only when no 8-K found
      news_fallback: eightk.found ? [] : news,
      sympathy_trade: manualSympathy
    },

    phase3: {
      market_open: priceAction.market_open,
      pm_high: priceAction.pm_high,
      rth_open: priceAction.rth_open,
      pm_high_reclaimed: priceAction.pm_high_reclaimed,
      vwap: priceAction.vwap,
      vwap_failed: priceAction.vwap_failed,
      wick_ratio: priceAction.wick_ratio,
      volume_ratio: priceAction.volume_ratio,
      day_of_run: priceAction.day_of_run,
      current_price: priceAction.current_price,
      pm_high_override: manualPmOverride,
      vwap_override: manualVwapOverride,
      ...(priceAction.error ? { error: priceAction.error } : {})
    },

    phase4: {
      shares_outstanding: shortInterest.shares_outstanding,
      short_interest: shortInterest.short_interest,
      short_float_pct: shortInterest.short_float_pct,
      short_date: shortInterest.date,
      ...(shortInterest.error ? { error: shortInterest.error } : {})
    }
  };

  const bias = computeBias(partial);
  const short_signal_count = computeShortSignals(partial);
  const completion_pct = computeCompletion(partial);

  return { ...partial, bias, short_signal_count, completion_pct };
}

// ─── applyManualOverride ──────────────────────────────────────────────────────

export function applyManualOverride(
  existing: SecChecklist,
  updates: {
    phase2?: { sympathy_trade?: boolean | null };
    phase3?: { pm_high_override?: boolean | null; vwap_override?: boolean | null };
  }
): SecChecklist {
  const updated: SecChecklist = {
    ...existing,
    phase2: {
      ...existing.phase2,
      ...(updates.phase2 ?? {})
    },
    phase3: {
      ...existing.phase3,
      ...(updates.phase3 ?? {})
    }
  };

  const partial = {
    ticker: updated.ticker,
    run_at: updated.run_at,
    version: updated.version,
    phase1: updated.phase1,
    phase2: updated.phase2,
    phase3: updated.phase3,
    phase4: updated.phase4
  } as Omit<SecChecklist, 'bias' | 'short_signal_count' | 'completion_pct'>;

  updated.bias = computeBias(partial);
  updated.short_signal_count = computeShortSignals(partial);
  updated.completion_pct = computeCompletion(partial);

  return updated;
}
