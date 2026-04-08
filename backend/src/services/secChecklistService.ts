/**
 * SEC Checklist Service — orchestrates EDGAR, Finnhub, and Yahoo Finance
 * into a single structured checklist with short-bias label. Cat5ive v4.
 */

import { getShelfAndFilingHistory, getRecentEightKText, EightKResult } from './edgarService';
import { getAnalystCoverage, getShortInterest, getRecentNews, AnalystCoverage, NewsItem } from './finnhubService';
import { getPriceActionSignals } from './marketDataService';
import { computeScoreSnapshot, ScoreSnapshot } from './scoringEngineService';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChecklistBias =
  | 'OFFERING_LIVE'
  | 'ATM_LIVE'
  | 'AH_REVERSED'
  | 'BLOW_OFF_TOP'
  | 'OVEREXTENDED_AH'
  | 'LOW_FLOAT_PARABOLIC'
  | 'OFFERING_SPIKE'
  | 'PRIME_SHORT'
  | 'TRAP_SETUP'
  | 'CLEAN_TAPE'
  | 'WEAK_HOLD'
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

  phase1b: {
    ah_high: number | null;
    ah_low: number | null;
    ah_move_pct: number | null;
    ah_vol_ratio: number | null;
    ah_classification: 'THIN_AH_SPIKE' | 'HEALTHY_AH_BUILD' | null;
    ah_reversal_pct: number | null;    // negative = AH high faded in PM
    prior_close: number | null;
    gap_pct: number | null;            // PM high vs prior close %
  };

  phase2: {
    catalyst_tier: 1 | 2 | 3 | 4 | null;
    proceeds_type: 'MILESTONE' | 'LOSSES' | 'UNKNOWN' | null;
    news_fallback: NewsItem[];
    sympathy_trade: boolean | null;   // MANUAL only
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
    intraday_move_pct: number | null;
    efficiency: number | null;
    error?: string;
    // Manual fields — set via checklist-manual PATCH
    structure?: 'BLOW_OFF_TOP' | 'WEAK_HOLD' | 'STRONG_HOLD' | 'RANGE' | null;
    large_print_zone?: 'BELOW_VWAP' | 'ABOVE_VWAP' | null;
    borrow?: 'EASY' | 'HARD' | 'HTB' | 'NO_LOCATE' | null;
    w1_imbalance?: number | null;  // -1.0 to +1.0, W1 open order imbalance
  };

  phase4: {
    shares_outstanding: number | null;
    short_interest: number | null;
    short_float_pct: number | null;
    short_date: string | null;
    error?: string;
  };

  overrides: {
    override_ah_reversal: boolean;         // ah_reversal_pct < -30%
    override_low_float_parabolic: boolean; // day_of_run >= 3 AND catalyst_tier >= 3
    override_blowoff: boolean;             // wick_ratio > 0.80 AND vwap_failed
    override_weak_hold: boolean;           // no shelf/424B but short_float_pct > 20
    override_overextended: boolean;        // gap_pct > 80%
    override_offering_spike: boolean;      // same-day 424B + price within 15% of pm_high
  };

  bias: ChecklistBias;
  score: number;             // legacy -30 to +30 (backward compat)
  score_snapshot: ScoreSnapshot; // 6-rule weighted score, probabilities, reason
  completion_pct: number;
}

// ─── Overrides ────────────────────────────────────────────────────────────────

function computeOverrides(
  phase1: SecChecklist['phase1'],
  phase1b: SecChecklist['phase1b'],
  phase2: SecChecklist['phase2'],
  phase3: SecChecklist['phase3'],
  phase4: SecChecklist['phase4']
): SecChecklist['overrides'] {
  return {
    override_ah_reversal:
      phase1b.ah_reversal_pct !== null && phase1b.ah_reversal_pct < -30,

    override_low_float_parabolic:
      (phase3.day_of_run ?? 0) >= 3 &&
      (phase2.catalyst_tier ?? 0) >= 3,

    override_blowoff:
      (phase3.wick_ratio ?? 0) > 0.80 && phase3.vwap_failed === true,

    override_weak_hold:
      !phase1.shelf_type &&
      phase1.prior_424b_count_12m === 0 &&
      (phase4.short_float_pct ?? 0) > 20,

    override_overextended:
      (phase1b.gap_pct ?? 0) > 80,

    override_offering_spike:
      phase1.same_day_424b.length > 0 &&
      phase3.current_price !== null &&
      phase3.pm_high !== null &&
      phase3.current_price >= phase3.pm_high * 0.85
  };
}

// ─── Bias hierarchy ───────────────────────────────────────────────────────────

function computeBias(
  phase1: SecChecklist['phase1'],
  overrides: SecChecklist['overrides']
): ChecklistBias {
  if (phase1.error && !phase1.shelf_type && phase1.prior_424b_count_12m === 0) {
    return 'NO_DATA';
  }

  // Tier 1 — confirmed offering/instrument
  if (phase1.same_day_424b.length > 0) return 'OFFERING_LIVE';
  if (
    phase1.eightk.signals.includes('ATM_TERMINATED') ||
    phase1.eightk.signals.includes('UNDERWRITING_DONE')
  ) return 'ATM_LIVE';

  // Tier 2 — computed price action overrides
  if (overrides.override_ah_reversal) return 'AH_REVERSED';
  if (overrides.override_blowoff) return 'BLOW_OFF_TOP';
  if (overrides.override_overextended) return 'OVEREXTENDED_AH';
  if (overrides.override_low_float_parabolic) return 'LOW_FLOAT_PARABOLIC';
  if (overrides.override_offering_spike) return 'OFFERING_SPIKE';

  // Tier 3 — EDGAR filing profile
  if (phase1.shelf_type && phase1.prior_424b_count_12m >= 2) return 'PRIME_SHORT';
  if (phase1.shelf_type) return 'TRAP_SETUP';

  // Tier 4 — clean profile
  if (!phase1.shelf_type && phase1.prior_424b_count_12m === 0) {
    return overrides.override_weak_hold ? 'WEAK_HOLD' : 'CLEAN_TAPE';
  }

  return 'NO_DATA';
}

// ─── Score ────────────────────────────────────────────────────────────────────

function computeScore(
  phase1: SecChecklist['phase1'],
  phase2: SecChecklist['phase2'],
  phase3: SecChecklist['phase3'],
  phase4: SecChecklist['phase4'],
  overrides: SecChecklist['overrides']
): number {
  let score = 0;

  // EDGAR — short signals
  if (phase1.same_day_424b.length > 0) score += 5;
  if (
    phase1.eightk.signals.includes('ATM_TERMINATED') ||
    phase1.eightk.signals.includes('UNDERWRITING_DONE')
  ) score += 5;
  if (phase1.shelf_type && phase1.prior_424b_count_12m >= 2) score += 4;
  else if (phase1.shelf_type) score += 2;

  // Analyst
  if (phase1.analyst.analyst_bias === 'BEARISH') score += 2;
  else if (phase1.analyst.analyst_bias === 'BULLISH') score -= 2;

  // Catalyst
  if (phase2.proceeds_type === 'LOSSES') score += 2;
  else if (phase2.proceeds_type === 'MILESTONE') score -= 2;
  if (phase2.catalyst_tier !== null && phase2.catalyst_tier >= 3) score += 2;
  else if (phase2.catalyst_tier === 1) score -= 3;
  if (phase2.sympathy_trade === true) score += 2;

  // Price action
  if (phase3.pm_high_reclaimed === false) score += 2;
  if (phase3.vwap_failed === true) score += 2;
  if ((phase3.wick_ratio ?? 0) > 0.65) score += 2;
  if ((phase3.day_of_run ?? 0) >= 3) score += 1;

  // Overrides (computed — strongest signals)
  if (overrides.override_ah_reversal) score += 3;
  if (overrides.override_blowoff) score += 3;
  if (overrides.override_overextended) score += 3;
  if (overrides.override_low_float_parabolic) score += 2;

  // Float/short interest
  if ((phase4.short_float_pct ?? 0) > 20) score += 2;

  // Clean tape negative signals
  if (!phase1.shelf_type && phase1.prior_424b_count_12m === 0) score -= 5;
  if (phase3.pm_high_reclaimed === true && !phase3.vwap_failed) score -= 2;

  return Math.max(-30, Math.min(30, score));
}

// ─── Completion ───────────────────────────────────────────────────────────────

function computeCompletion(
  phase1: SecChecklist['phase1'],
  phase1b: SecChecklist['phase1b'],
  phase2: SecChecklist['phase2'],
  phase3: SecChecklist['phase3'],
  phase4: SecChecklist['phase4']
): number {
  const checkpoints = [
    phase1.shelf_type !== undefined,
    phase1.prior_424b_count_12m !== undefined,
    phase1.eightk.found !== undefined,
    phase1.analyst.analyst_bias !== null,
    phase1b.ah_move_pct !== null,
    phase1b.ah_classification !== null,
    phase1b.gap_pct !== null,
    phase2.catalyst_tier !== null,
    phase2.sympathy_trade !== null,
    phase2.proceeds_type !== null,
    phase3.pm_high !== null || !phase3.market_open,
    phase3.vwap !== null || !phase3.market_open,
    phase3.wick_ratio !== null || !phase3.market_open,
    phase3.volume_ratio !== null,
    phase3.day_of_run !== null,
    phase4.short_float_pct !== null || phase4.shares_outstanding !== null,
  ];

  const done = checkpoints.filter(Boolean).length;
  return Math.round((done / checkpoints.length) * 100);
}

// ─── runChecklist ─────────────────────────────────────────────────────────────

export async function runChecklist(ticker: string, existing?: SecChecklist | null): Promise<SecChecklist> {
  const upper = ticker.toUpperCase();

  // Preserve only the manual field
  const manualSympathy = existing?.phase2?.sympathy_trade ?? null;

  const [shelf, eightk, priceAction, analyst, shortInterest, news] = await Promise.all([
    getShelfAndFilingHistory(upper),
    getRecentEightKText(upper),
    getPriceActionSignals(upper),
    getAnalystCoverage(upper),
    getShortInterest(upper),
    getRecentNews(upper, 2)
  ]);

  const phase1: SecChecklist['phase1'] = {
    complete: !shelf.error,
    shelf_type: shelf.shelf_type,
    shelf_date: shelf.shelf_date,
    shelf_age_days: shelf.shelf_age_days,
    prior_424b_count_12m: shelf.prior_424b_count_12m,
    same_day_424b: shelf.same_day_424b,
    eightk,
    analyst,
    ...(shelf.error ? { error: shelf.error } : {})
  };

  const phase1b: SecChecklist['phase1b'] = {
    ah_high: priceAction.ah_high,
    ah_low: priceAction.ah_low,
    ah_move_pct: priceAction.ah_move_pct,
    ah_vol_ratio: priceAction.ah_vol_ratio,
    ah_classification: priceAction.ah_classification,
    ah_reversal_pct: priceAction.ah_reversal_pct,
    prior_close: priceAction.prior_close,
    gap_pct: priceAction.gap_pct
  };

  const phase2: SecChecklist['phase2'] = {
    catalyst_tier: eightk.catalyst_tier,
    proceeds_type: eightk.proceeds_type,
    news_fallback: eightk.found ? [] : news,
    sympathy_trade: manualSympathy
  };

  const phase3: SecChecklist['phase3'] = {
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
    intraday_move_pct: priceAction.intraday_move_pct,
    efficiency: priceAction.efficiency,
    ...(priceAction.error ? { error: priceAction.error } : {})
  };

  const phase4: SecChecklist['phase4'] = {
    shares_outstanding: shortInterest.shares_outstanding,
    short_interest: shortInterest.short_interest,
    short_float_pct: shortInterest.short_float_pct,
    short_date: shortInterest.date,
    ...(shortInterest.error ? { error: shortInterest.error } : {})
  };

  const overrides = computeOverrides(phase1, phase1b, phase2, phase3, phase4);
  const bias = computeBias(phase1, overrides);
  const score = computeScore(phase1, phase2, phase3, phase4, overrides);
  const completion_pct = computeCompletion(phase1, phase1b, phase2, phase3, phase4);

  const partial = { ticker: upper, run_at: new Date().toISOString(), version: 4 as const, phase1, phase1b, phase2, phase3, phase4, overrides, bias, score, completion_pct };
  const score_snapshot = computeScoreSnapshot(partial as SecChecklist);

  return { ...partial, score_snapshot };
}

// ─── applyManualOverride ──────────────────────────────────────────────────────

export function applyManualOverride(
  existing: SecChecklist,
  updates: {
    phase2?: { sympathy_trade?: boolean | null };
    phase3?: {
      structure?: 'BLOW_OFF_TOP' | 'WEAK_HOLD' | 'STRONG_HOLD' | 'RANGE' | null;
      large_print_zone?: 'BELOW_VWAP' | 'ABOVE_VWAP' | null;
      borrow?: 'EASY' | 'HARD' | 'HTB' | 'NO_LOCATE' | null;
      w1_imbalance?: number | null;
    };
  }
): SecChecklist {
  const phase2: SecChecklist['phase2'] = {
    ...existing.phase2,
    ...(updates.phase2 ?? {})
  };

  const phase3: SecChecklist['phase3'] = {
    ...existing.phase3,
    ...(updates.phase3 ?? {})
  };

  const overrides = computeOverrides(existing.phase1, existing.phase1b, phase2, phase3, existing.phase4);
  const bias = computeBias(existing.phase1, overrides);
  const score = computeScore(existing.phase1, phase2, phase3, existing.phase4, overrides);
  const completion_pct = computeCompletion(existing.phase1, existing.phase1b, phase2, phase3, existing.phase4);
  const updated = { ...existing, phase2, phase3, overrides, bias, score, completion_pct };
  const score_snapshot = computeScoreSnapshot(updated);
  return { ...updated, score_snapshot };
}
