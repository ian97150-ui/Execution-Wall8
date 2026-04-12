/**
 * Scoring Engine — Cat5ive v5 (15-rule weighted model).
 * Derived from 74-trade dataset · S1=44 · S2=29 · 64.8% accuracy.
 * Deterministic: same inputs → same output. No randomness.
 * Scores stored in score_snapshot (non-repainting).
 *
 * ⚠️  Override rules (AH_REVERSAL_TRAP, DAY3_EXHAUSTION, STRONG_HOLD_TRAP)
 *     are SCORECARD LABELS ONLY — they never touch order execution.
 */

import type { SecChecklist } from './secChecklistService';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SignalTag =
  | 'AH_REVERSAL_TRAP'
  | 'STRONG_HOLD_TRAP'
  | 'DAY3_EXHAUSTION'
  | 'DAY1_RUN'
  | 'PM_FADE'
  | 'PM_SELL_PRESSURE'
  | 'MOVE_200'
  | 'MOVE_100'
  | 'GAP_40'
  | 'FRESH_SHELF'
  | 'ACTIVE_424B'
  | 'THIN_AH_SPIKE'
  | 'LARGE_PRINT_BELOW'
  | 'VWAP_HELD'
  // Composite patterns
  | 'OFFERING_FADE'
  | 'LF_BLOWOFF_FADE'
  // AH filing gap tiers
  | 'AH_FILING_GAP_T1'
  | 'AH_FILING_GAP_T2'
  // Insider signals
  | 'FORM144_PRESALE'
  | 'FORM4_SELL'
  | 'ATM_TERMINATED';

export type TradeBias =
  | 'MAX_CONVICTION'    // score >= 15 · 94% dump
  | 'HIGH_CONVICTION'   // score >= 12 · 93% dump
  | 'CONFIRMED_SHORT'   // score >= 8  · 86% dump
  | 'NEUTRAL'           // score 2–7
  | 'LONG_BIAS'         // score <= 1
  | 'LONG_CANDIDATE';   // score <= -3 · EQ_CONTINUATION setup

export type TradeSection = 'S1' | 'S2';  // D+1 vs D+5 exit

export type CleanOutcome = 'DUMP' | 'CLEAN_FADE' | 'VOLATILE_FADE' | 'CHOP';

export type ProbPath =
  | 'dump'
  | 'fade'
  | 'chop'
  | 'continuation'
  | 'pullback'
  | 'failure';

export type RegimeId =
  | 'OFFERING_SPIKE'
  | 'DEAD_CAT_BOUNCE'
  | 'DILUTION_DUMP'
  | 'LOW_FLOAT_PARABOLIC'
  | 'NEWS_CONTINUATION';

export type TimingBucket =
  | 'D0_INTRADAY'
  | 'D0_AH'
  | 'D1_GAP_OPEN'
  | 'D1_INTRADAY'
  | 'DELAYED';

export interface RegimeStat {
  regime: RegimeId;
  n: number;
  s1_pct: number;   // % of cases that were S1 (fast dump)
  dump_pct: number; // % that dumped at all
  d5_avg: number;   // avg D+5 return (negative = loss for holder)
}

export interface PatternStat {
  pattern: string;
  n: number;
  dump_pct: number;
  d5_avg: number;
  max_dd?: number;  // max drawdown %
}

export interface SectionProb {
  s1_pct: number;
  s2_pct: number;
  basis: string;  // what drove the estimate, e.g. 'borrow (HARD)' or 'offerings (3)'
}

export interface OutcomeProfile {
  d1_avg: number;
  d5_avg: number;
}

export interface ScoreSnapshot {
  timestamp: string;
  score: number;                              // raw weighted sum
  bias: TradeBias;
  confidence: number;                         // 0–1
  signals: SignalTag[];
  reason: string;
  probabilities: { path: ProbPath; pct: number }[];  // top 3, sums to 100
  section: TradeSection | null;               // S1 (D+1) or S2 (D+5) — only when score >= 8
  section_prob: SectionProb | null;           // empirical S1/S2 % from lookup tables
  clean_score: number | null;                 // 0–10, S1 only
  clean_outcome: CleanOutcome | null;         // DUMP/CLEAN_FADE/VOLATILE_FADE/CHOP
  outcome_profile: OutcomeProfile | null;     // D+1/D+5 expected move from clean_outcome
  overrides_fired: string[];                  // display-only override labels
  regime: RegimeStat | null;                  // detected market regime with stats
  pattern_stats: PatternStat[];               // empirical stats for each fired override pattern
  predicted_bucket?: TimingBucket;            // New: predictive timing bucket from framework
}

// ─── Rule 1 — AH Reversal ─────────────────────────────────────────────────────
// Scores positive = short conviction

function ruleAH(ah_move_pct: number | null): { points: number; tag: SignalTag | null; isOverride: boolean } {
  if (ah_move_pct === null) return { points: 0, tag: null, isOverride: false };
  if (ah_move_pct < -80)   return { points: 5.0, tag: 'AH_REVERSAL_TRAP', isOverride: true };
  if (ah_move_pct < -30)   return { points: 3.5, tag: 'AH_REVERSAL_TRAP', isOverride: true };
  return { points: 0, tag: null, isOverride: false };
}

// ─── Rule 2 — STRONG_HOLD_TRAP ───────────────────────────────────────────────

function ruleStrongHoldTrap(
  structure: string | null | undefined,
  borrow: string | null | undefined,
  catalyst_tier: number | null
): { points: number; tag: SignalTag | null; isOverride: boolean } {
  if (
    structure === 'STRONG_HOLD' &&
    (borrow === 'HTB' || borrow === 'NO_LOCATE') &&
    catalyst_tier === null
  ) {
    return { points: 4.5, tag: 'STRONG_HOLD_TRAP', isOverride: true };
  }
  return { points: 0, tag: null, isOverride: false };
}

// ─── Rule 3 — Day of Run ─────────────────────────────────────────────────────

function ruleRunDay(day_of_run: number | null): { points: number; tag: SignalTag | null; isOverride: boolean } {
  if (day_of_run === null) return { points: 0, tag: null, isOverride: false };
  if (day_of_run >= 3)    return { points: 4.0, tag: 'DAY3_EXHAUSTION', isOverride: true };
  if (day_of_run === 1)   return { points: -2.0, tag: 'DAY1_RUN', isOverride: false };
  return { points: 0, tag: null, isOverride: false };
}

// ─── Rule 4 — PM Fade ────────────────────────────────────────────────────────

function rulePMFade(pm_high_reclaimed: boolean | null): { points: number; tag: SignalTag | null } {
  if (pm_high_reclaimed === false) return { points: 3.5, tag: 'PM_FADE' };
  return { points: 0, tag: null };
}

// ─── Rule 5 — Move magnitude (tiered — highest tier fires) ───────────────────

function ruleMove(gap_pct: number | null): { points: number; tag: SignalTag | null } {
  if (gap_pct === null) return { points: 0, tag: null };
  if (gap_pct > 200) return { points: 3.0, tag: 'MOVE_200' };
  if (gap_pct > 100) return { points: 2.5, tag: 'MOVE_100' };
  if (gap_pct > 40)  return { points: 1.5, tag: 'GAP_40' };
  return { points: 0, tag: null };
}

// ─── Rule 6 — PM Sell Pressure ───────────────────────────────────────────────

function rulePMSellPressure(efficiency: number | null): { points: number; tag: SignalTag | null } {
  if (efficiency !== null && efficiency < 0.50) return { points: 3.0, tag: 'PM_SELL_PRESSURE' };
  return { points: 0, tag: null };
}

// ─── Rule 7 — VWAP Held (paradox) ────────────────────────────────────────────
// Big move + VWAP hold → distribution pressure building

function ruleVWAPHeld(vwap_failed: boolean | null, gap_pct: number | null): { points: number; tag: SignalTag | null } {
  if (vwap_failed === false && gap_pct !== null && gap_pct > 40) return { points: 2.5, tag: 'VWAP_HELD' };
  return { points: 0, tag: null };
}

// ─── Rule 8 — Large Print Zone ───────────────────────────────────────────────

function ruleLargePrint(large_print_zone: string | null | undefined): { points: number; tag: SignalTag | null } {
  if (large_print_zone === 'BELOW_VWAP') return { points: 2.0, tag: 'LARGE_PRINT_BELOW' };
  return { points: 0, tag: null };
}

// ─── Rule 9 — Fresh Shelf ────────────────────────────────────────────────────

function ruleFreshShelf(shelf_age_days: number | null): { points: number; tag: SignalTag | null } {
  if (shelf_age_days !== null && shelf_age_days < 30) return { points: 2.0, tag: 'FRESH_SHELF' };
  return { points: 0, tag: null };
}

// ─── Rule 10 — Active 424B ───────────────────────────────────────────────────

function ruleActive424B(same_day_424b: { form: string; filing_url: string }[]): { points: number; tag: SignalTag | null } {
  if (same_day_424b.length > 0) return { points: 1.5, tag: 'ACTIVE_424B' };
  return { points: 0, tag: null };
}

// ─── Rule 11 — Thin AH Spike (negative — manufactured move) ─────────────────

function ruleThinAH(ah_classification: string | null): { points: number; tag: SignalTag | null } {
  if (ah_classification === 'THIN_AH_SPIKE') return { points: -4.0, tag: 'THIN_AH_SPIKE' };
  return { points: 0, tag: null };
}

// ─── Rule 12 — OFFERING_FADE (composite) ─────────────────────────────────────
// BLOW_OFF + PM_FADE + same-session 8-K + 424B → 80% dump, D+5=-25.1% (n=5)

function ruleOfferingFade(
  structure: string | null | undefined,
  pm_high_reclaimed: boolean | null,
  same_day_424b: { form: string; filing_url: string }[],
  eightk_found: boolean
): { points: number; tag: SignalTag | null } {
  if (
    structure === 'BLOW_OFF_TOP' &&
    pm_high_reclaimed === false &&
    same_day_424b.length > 0 &&
    eightk_found
  ) {
    return { points: 5.0, tag: 'OFFERING_FADE' };
  }
  return { points: 0, tag: null };
}

// ─── Rule 13 — LF_BLOWOFF_FADE (composite) ───────────────────────────────────
// BLOW_OFF + PM_FADE + LOW_FLOAT_PARABOLIC regime → 86% dump, D+5=-25.4% (n=7)

function ruleLFBlowoffFade(
  structure: string | null | undefined,
  pm_high_reclaimed: boolean | null,
  regime: RegimeStat | null
): { points: number; tag: SignalTag | null } {
  if (
    structure === 'BLOW_OFF_TOP' &&
    pm_high_reclaimed === false &&
    regime?.regime === 'LOW_FLOAT_PARABOLIC'
  ) {
    return { points: 4.0, tag: 'LF_BLOWOFF_FADE' };
  }
  return { points: 0, tag: null };
}

// ─── Rule 14 — AH Filing Gap ─────────────────────────────────────────────────
// AH price drop leads EDGAR filing by 10–20 min — filing is confirmation.
// Tier 1 (<-30% AH, vol>50×): n=12, 92% dump, D+5=-35.7%
// Tier 2 (-10% to -30%): n=1, 100% dump, D+5=-36.7%
// False positive filter: skip if vol_ratio <= 50× (BJDX case)

function ruleAHFilingGap(
  ah_move_pct: number | null,
  ah_vol_ratio: number | null,
  gap_pct: number | null,
  same_day_424b: { form: string; filing_url: string }[],
  eightk_found: boolean,
  eightk_signals: string[]
): { points: number; tag: SignalTag | null } {
  // Eligibility checks
  if (ah_move_pct === null || ah_move_pct >= -5) return { points: 0, tag: null };
  if (ah_vol_ratio === null || ah_vol_ratio <= 50) return { points: 0, tag: null };
  if (gap_pct === null || gap_pct <= 40) return { points: 0, tag: null };
  if (!same_day_424b.length && !eightk_found) return { points: 0, tag: null };
  if (eightk_signals.includes('ATM_TERMINATED')) return { points: 0, tag: null };

  if (ah_move_pct < -30) return { points: 4.0, tag: 'AH_FILING_GAP_T1' };
  if (ah_move_pct < -10) return { points: 2.0, tag: 'AH_FILING_GAP_T2' };
  return { points: 0, tag: null };
}

// ─── Rule 15 — Insider signals ────────────────────────────────────────────────

function ruleInsiderSignals(
  insider_signals: { form144_presale: boolean; form4_sell: boolean } | null | undefined,
  eightk_signals: string[]
): { points: number; tags: SignalTag[] } {
  let points = 0;
  const tags: SignalTag[] = [];
  if (insider_signals?.form144_presale) { points += 2.5; tags.push('FORM144_PRESALE'); }
  if (insider_signals?.form4_sell)      { points += 2.0; tags.push('FORM4_SELL'); }
  if (eightk_signals.includes('ATM_TERMINATED')) { points -= 2.0; tags.push('ATM_TERMINATED'); }
  return { points, tags };
}

// ─── Timing Bucket Prediction ───────────────────────────────────────────────
// Maps Wall card data to one of 5 predetermined timing states.

function predictTimingBucket(
  structure: string | null | undefined,
  borrow: string | null | undefined,
  day_of_run: number | null,
  gap_pct: number | null,
  ah_move_pct: number | null,
  vwap_failed: boolean | null,
  wick_ratio: number | null,
  signals: SignalTag[]
): TimingBucket {
  // 1. D0_INTRADAY: Spike + Intraday Reversal/VWAP fail
  if (
    (wick_ratio !== null && wick_ratio >= 0.65 && vwap_failed === true) ||
    signals.includes('LF_BLOWOFF_FADE') ||
    signals.includes('DAY3_EXHAUSTION')
  ) {
    return 'D0_INTRADAY';
  }

  // 2. D0_AH: AH price drop precedes filing
  if (
    (ah_move_pct !== null && ah_move_pct < -10) ||
    signals.includes('AH_FILING_GAP_T1') ||
    signals.includes('AH_FILING_GAP_T2') ||
    signals.includes('AH_REVERSAL_TRAP')
  ) {
    return 'D0_AH';
  }

  // 3. D1_INTRADAY: Strong hold D0, breaks D+1 morning
  if (
    structure === 'STRONG_HOLD' &&
    (borrow === 'HTB' || borrow === 'NO_LOCATE') &&
    signals.includes('STRONG_HOLD_TRAP')
  ) {
    return 'D1_INTRADAY';
  }

  // 4. D1_GAP_OPEN: Huge runner + Hard borrow -> Overnight price in
  if (
    gap_pct !== null && gap_pct > 100 &&
    (borrow === 'HARD' || borrow === 'HTB') &&
    structure === 'STRONG_HOLD'
  ) {
    return 'D1_GAP_OPEN';
  }

  // 5. DELAYED: Default / No clear intraday or AH trigger
  return 'DELAYED';
}

// ─── S1/S2 Classifier ────────────────────────────────────────────────────────
// Maps predicted bucket to final trade section.

function classifySection(bucket: TimingBucket): TradeSection {
  switch (bucket) {
    case 'D0_INTRADAY':
    case 'D0_AH':
    case 'D1_INTRADAY':
      return 'S1';
    case 'D1_GAP_OPEN':
    case 'DELAYED':
      return 'S2';
  }
}

// ─── S1 Clean Score (0–10) ───────────────────────────────────────────────────
// Higher = more volatile/choppy path.

function computeCleanScore(
  borrow: string | null | undefined,
  shares_outstanding: number | null,
  w1_imbalance: number | null | undefined,
  gap_pct: number | null,
  wick_ratio: number | null,
  same_day_424b: { form: string; filing_url: string }[],
  day_of_run: number | null,
  efficiency: number | null,
  volume_ratio: number | null
): number {
  let score = 0;
  if (borrow === 'HTB' || borrow === 'NO_LOCATE')                                    score += 3;
  if (shares_outstanding !== null && shares_outstanding < 1_000_000)                  score += 3;
  if (w1_imbalance !== null && w1_imbalance !== undefined && w1_imbalance >= 0.65)    score += 3;
  if (gap_pct !== null && gap_pct > 120)                                              score += 2;
  if (wick_ratio !== null && wick_ratio >= 0.85)                                      score += 2;
  if ((borrow === 'HTB' || borrow === 'NO_LOCATE') && same_day_424b.length === 0)    score += 1;
  if (day_of_run !== null && day_of_run >= 3)                                         score -= 3;
  if (efficiency !== null && efficiency < 0.50)                                       score -= 2;
  if (borrow === 'EASY' && volume_ratio !== null && volume_ratio < 200)               score -= 2;
  return Math.max(0, Math.min(10, score));
}

function cleanScoreToOutcome(score: number): CleanOutcome {
  if (score <= 2) return 'DUMP';
  if (score <= 5) return 'CLEAN_FADE';
  if (score <= 7) return 'VOLATILE_FADE';
  return 'CHOP';
}

// ─── Regime detection ────────────────────────────────────────────────────────
// Priority order: OFFERING_SPIKE → DEAD_CAT_BOUNCE → DILUTION_DUMP → LOW_FLOAT_PARABOLIC → NEWS_CONTINUATION

const REGIME_STATS: Record<RegimeId, RegimeStat> = {
  OFFERING_SPIKE:      { regime: 'OFFERING_SPIKE',      n: 5,  s1_pct: 100, dump_pct: 80, d5_avg: -25.1 },
  DEAD_CAT_BOUNCE:     { regime: 'DEAD_CAT_BOUNCE',     n: 4,  s1_pct: 50,  dump_pct: 100, d5_avg: -31.9 },
  DILUTION_DUMP:       { regime: 'DILUTION_DUMP',       n: 25, s1_pct: 64,  dump_pct: 80, d5_avg: -25.2 },
  LOW_FLOAT_PARABOLIC: { regime: 'LOW_FLOAT_PARABOLIC', n: 16, s1_pct: 63,  dump_pct: 81, d5_avg: -24.6 },
  NEWS_CONTINUATION:   { regime: 'NEWS_CONTINUATION',   n: 28, s1_pct: 57,  dump_pct: 68, d5_avg: -14.1 },
};

function detectRegime(
  same_day_424b: { form: string; filing_url: string }[],
  eightk_signals: string[],
  day_of_run: number | null,
  prior_424b_count: number,
  shelf_type: string | null,
  catalyst_tier: number | null,
  shares_outstanding: number | null,
  efficiency: number | null
): RegimeStat | null {
  // OFFERING_SPIKE: same-day 424B + 8-K filed same session
  if (same_day_424b.length > 0 && eightk_signals.length > 0) {
    return REGIME_STATS.OFFERING_SPIKE;
  }
  // DEAD_CAT_BOUNCE: day 3+ (prior day was spike)
  if (day_of_run !== null && day_of_run >= 3) {
    return REGIME_STATS.DEAD_CAT_BOUNCE;
  }
  // DILUTION_DUMP: active or serial diluter
  if (same_day_424b.length > 0 || prior_424b_count >= 2 || shelf_type) {
    return REGIME_STATS.DILUTION_DUMP;
  }
  // LOW_FLOAT_PARABOLIC: no real catalyst + micro/low float + sell pressure
  if (
    (catalyst_tier === null || catalyst_tier >= 3) &&
    shares_outstanding !== null && shares_outstanding <= 5_000_000 &&
    efficiency !== null && efficiency < 0.50
  ) {
    return REGIME_STATS.LOW_FLOAT_PARABOLIC;
  }
  // NEWS_CONTINUATION: 8-K driven, clean company
  if (eightk_signals.length > 0 && prior_424b_count <= 1) {
    return REGIME_STATS.NEWS_CONTINUATION;
  }
  return null;
}

// ─── Pattern stats lookup ─────────────────────────────────────────────────────

const PATTERN_STATS: Record<string, PatternStat> = {
  AH_REVERSAL_TRAP:  { pattern: 'AH_REVERSAL_TRAP',  n: 15, dump_pct: 93,  d5_avg: -34.1, max_dd: -48   },
  DAY3_EXHAUSTION:   { pattern: 'DAY3_EXHAUSTION',   n: 4,  dump_pct: 100, d5_avg: -42.1, max_dd: -51.4 },
  STRONG_HOLD_TRAP:  { pattern: 'STRONG_HOLD_TRAP',  n: 4,  dump_pct: 100, d5_avg: -48.9               },
  OFFERING_FADE:     { pattern: 'OFFERING_FADE',     n: 5,  dump_pct: 80,  d5_avg: -25.1               },
  LF_BLOWOFF_FADE:   { pattern: 'LF_BLOWOFF_FADE',   n: 7,  dump_pct: 86,  d5_avg: -25.4               },
  AH_FILING_GAP_T1:  { pattern: 'AH_FILING_GAP_T1',  n: 12, dump_pct: 92,  d5_avg: -35.7, max_dd: -48   },
  AH_FILING_GAP_T2:  { pattern: 'AH_FILING_GAP_T2',  n: 1,  dump_pct: 100, d5_avg: -36.7               },
  FORM144_PRESALE:   { pattern: 'FORM144_PRESALE',   n: 4,  dump_pct: 100, d5_avg: -30.0               },
};

// ─── S1/S2 empirical probability ──────────────────────────────────────────────
// Returns the most specific lookup available, in priority order:
// predicted_bucket (timing framework) → borrow → shelf_age → catalyst

function empiricalSectionProb(
  bucket: TimingBucket,
  borrow: string | null | undefined,
  shelf_age_days: number | null,
  prior_424b_count: number,
  same_day_424b: { form: string; filing_url: string }[],
  catalyst_tier: number | null,
  day_of_run: number | null
): SectionProb | null {
  // Priority 1 — Timing Framework Bucket (Predetermined State)
  switch (bucket) {
    case 'D0_INTRADAY': return { s1_pct: 68, s2_pct: 32, basis: 'bucket (D0_INTRADAY)' };
    case 'D0_AH':       return { s1_pct: 38, s2_pct: 62, basis: 'bucket (D0_AH)' };
    case 'D1_GAP_OPEN': return { s1_pct: 40, s2_pct: 60, basis: 'bucket (D1_GAP_OPEN)' };
    case 'D1_INTRADAY': return { s1_pct: 88, s2_pct: 12, basis: 'bucket (D1_INTRADAY)' };
    case 'DELAYED':     return { s1_pct: 58, s2_pct: 42, basis: 'bucket (DELAYED)' };
  }

  // HTB exception: HTB + day 3 → S1 override (100%)
  if (borrow === 'HTB' && day_of_run !== null && day_of_run >= 3) {
    return { s1_pct: 100, s2_pct: 0, basis: 'HTB + day 3 exception' };
  }
  // By borrow (most specific — live IBKR data, n=20)
  if (borrow === 'HARD')      return { s1_pct: 0,   s2_pct: 100, basis: 'borrow (HARD)' };
  if (borrow === 'HTB')       return { s1_pct: 50,  s2_pct: 50,  basis: 'borrow (HTB)' };
  if (borrow === 'EASY')      return { s1_pct: 75,  s2_pct: 25,  basis: 'borrow (EASY)' };
  if (borrow === 'NO_LOCATE') return { s1_pct: 50,  s2_pct: 50,  basis: 'borrow (NO_LOCATE)' };

  // By shelf age
  if (shelf_age_days !== null) {
    if (shelf_age_days < 30)  return { s1_pct: 100, s2_pct: 0,  basis: 'fresh shelf <30d' };
    if (shelf_age_days <= 90) return { s1_pct: 37,  s2_pct: 63, basis: 'shelf 30–90d' };
  }

  // By prior offerings
  if (prior_424b_count === 0) return { s1_pct: 74, s2_pct: 26, basis: '0 prior offerings' };
  if (prior_424b_count === 1) return { s1_pct: 27, s2_pct: 73, basis: '1 prior offering' };
  if (prior_424b_count === 2) return { s1_pct: 50, s2_pct: 50, basis: '2 prior offerings' };
  if (prior_424b_count === 3) return { s1_pct: 20, s2_pct: 80, basis: '3 prior offerings' };
  if (prior_424b_count === 5) return { s1_pct: 33, s2_pct: 67, basis: '5 prior offerings' };
  if (prior_424b_count >= 6)  return { s1_pct: 77, s2_pct: 23, basis: '6+ prior offerings' };

  // By catalyst
  if (same_day_424b.length > 0)                return { s1_pct: 87, s2_pct: 13, basis: 'active 424B' };
  if (catalyst_tier === 1)                      return { s1_pct: 30, s2_pct: 70, basis: 'tier-1 catalyst' };
  if (catalyst_tier !== null && catalyst_tier >= 3) return { s1_pct: 63, s2_pct: 37, basis: 'company PR' };
  if (catalyst_tier === null)                   return { s1_pct: 70, s2_pct: 30, basis: 'no news' };

  return null;
}

// ─── Outcome profiles (D+1 / D+5 expected) ───────────────────────────────────

const OUTCOME_PROFILES: Record<CleanOutcome, OutcomeProfile> = {
  DUMP:          { d1_avg: -25.7, d5_avg: -54.8 },
  CLEAN_FADE:    { d1_avg: -15.5, d5_avg: -25.4 },
  VOLATILE_FADE: { d1_avg: -5.5,  d5_avg: -3.8  },
  CHOP:          { d1_avg: +6.2,  d5_avg: -4.0  },
};

const BUCKET_PROFILES: Record<TimingBucket, OutcomeProfile> = {
  D0_INTRADAY: { d1_avg: -18.6, d5_avg: -22.5 },
  D0_AH:       { d1_avg: -7.7,  d5_avg: -27.3 },
  D1_GAP_OPEN: { d1_avg: -19.5, d5_avg: -42.5 },
  D1_INTRADAY: { d1_avg: -19.9, d5_avg: -33.5 },
  DELAYED:     { d1_avg: +11.5, d5_avg: -1.9  },
};

// ─── Bias ────────────────────────────────────────────────────────────────────

function scoreToBias(score: number): TradeBias {
  if (score >= 15) return 'MAX_CONVICTION';
  if (score >= 12) return 'HIGH_CONVICTION';
  if (score >= 8)  return 'CONFIRMED_SHORT';
  if (score >= 2)  return 'NEUTRAL';
  if (score > -3)  return 'LONG_BIAS';
  return 'LONG_CANDIDATE';
}

// ─── Probability lookup ───────────────────────────────────────────────────────

function computeProbabilities(score: number): ScoreSnapshot['probabilities'] {
  let base: { path: ProbPath; pct: number }[];
  if (score >= 15)      base = [{ path: 'dump', pct: 75 }, { path: 'fade', pct: 15 }, { path: 'chop', pct: 10 }];
  else if (score >= 12) base = [{ path: 'dump', pct: 60 }, { path: 'fade', pct: 25 }, { path: 'chop', pct: 15 }];
  else if (score >= 8)  base = [{ path: 'fade', pct: 55 }, { path: 'dump', pct: 30 }, { path: 'chop', pct: 15 }];
  else if (score >= 2)  base = [{ path: 'chop', pct: 45 }, { path: 'fade', pct: 35 }, { path: 'continuation', pct: 20 }];
  else if (score > -3)  base = [{ path: 'continuation', pct: 50 }, { path: 'chop', pct: 30 }, { path: 'fade', pct: 20 }];
  else                  base = [{ path: 'continuation', pct: 65 }, { path: 'pullback', pct: 25 }, { path: 'failure', pct: 10 }];
  const total = base.reduce((s, p) => s + p.pct, 0);
  return base.map(p => ({ path: p.path, pct: Math.round((p.pct / total) * 100) }));
}

// ─── Confidence ──────────────────────────────────────────────────────────────

function computeConfidence(score: number): number {
  if (score >= 0) return parseFloat(Math.min(score / 20, 1).toFixed(2));
  return parseFloat(Math.min(Math.abs(score) / 6, 1).toFixed(2));
}

// ─── Reason line ─────────────────────────────────────────────────────────────

const TAG_LABELS: Record<SignalTag, string> = {
  AH_REVERSAL_TRAP:  'AH reversal trap',
  STRONG_HOLD_TRAP:  'strong hold trap',
  DAY3_EXHAUSTION:   'day 3 exhaustion',
  DAY1_RUN:          'day 1 of run',
  PM_FADE:           'PM fade',
  PM_SELL_PRESSURE:  'PM sell pressure',
  MOVE_200:          '200%+ move',
  MOVE_100:          '100%+ move',
  GAP_40:            '40%+ gap',
  FRESH_SHELF:       'fresh shelf <30d',
  ACTIVE_424B:       'active 424B',
  THIN_AH_SPIKE:     'thin AH spike',
  LARGE_PRINT_BELOW: 'large print below VWAP',
  VWAP_HELD:         'VWAP holding',
  OFFERING_FADE:     'offering fade pattern',
  LF_BLOWOFF_FADE:   'LF blowoff fade',
  AH_FILING_GAP_T1:  'AH filing gap Tier 1',
  AH_FILING_GAP_T2:  'AH filing gap Tier 2',
  FORM144_PRESALE:   'Form 144 pre-sale',
  FORM4_SELL:        'Form 4 insider sell',
  ATM_TERMINATED:    'ATM terminated',
};

function buildReason(tags: SignalTag[], bias: TradeBias): string {
  const overrideOrder: SignalTag[] = ['AH_REVERSAL_TRAP', 'DAY3_EXHAUSTION', 'STRONG_HOLD_TRAP'];
  const overrideTags = overrideOrder.filter(t => tags.includes(t));
  const otherTags = tags.filter(t => !overrideOrder.includes(t));
  const ordered = [...overrideTags, ...otherTags].slice(0, 2);
  if (ordered.length === 0) return bias === 'NEUTRAL' ? 'Mixed signals — no edge' : 'Insufficient data';
  return ordered.map(t => TAG_LABELS[t]).join(' + ');
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeScoreSnapshot(checklist: SecChecklist): ScoreSnapshot {
  const { phase1, phase1b, phase2, phase3, phase4 } = checklist;

  // phase3 extended with manual fields (may be absent on older records)
  const p3 = phase3 as typeof phase3 & {
    structure?: string | null;
    large_print_zone?: string | null;
    borrow?: string | null;
    w1_imbalance?: number | null;
  };

  const r1  = ruleAH(phase1b?.ah_move_pct ?? null);
  const r2  = ruleStrongHoldTrap(p3?.structure, p3?.borrow, phase2?.catalyst_tier ?? null);
  const r3  = ruleRunDay(p3?.day_of_run ?? null);
  const r4  = rulePMFade(p3?.pm_high_reclaimed ?? null);
  const r5  = ruleMove(phase1b?.gap_pct ?? null);
  const r6  = rulePMSellPressure(p3?.efficiency ?? null);
  const r7  = ruleVWAPHeld(p3?.vwap_failed ?? null, phase1b?.gap_pct ?? null);
  const r8  = ruleLargePrint(p3?.large_print_zone);
  const r9  = ruleFreshShelf(phase1?.shelf_age_days ?? null);
  const r10 = ruleActive424B(phase1?.same_day_424b ?? []);
  const r11 = ruleThinAH(phase1b?.ah_classification ?? null);

  // Detect regime first so composite rules can reference it
  const regime = detectRegime(
    phase1?.same_day_424b ?? [],
    phase1?.eightk?.signals ?? [],
    p3?.day_of_run ?? null,
    phase1?.prior_424b_count_12m ?? 0,
    phase1?.shelf_type ?? null,
    phase2?.catalyst_tier ?? null,
    phase4?.shares_outstanding ?? null,
    p3?.efficiency ?? null
  );

  const eightk_signals: string[] = phase1?.eightk?.signals ?? [];

  const r12 = ruleOfferingFade(p3?.structure, p3?.pm_high_reclaimed ?? null, phase1?.same_day_424b ?? [], phase1?.eightk?.found ?? false);
  const r13 = ruleLFBlowoffFade(p3?.structure, p3?.pm_high_reclaimed ?? null, regime);
  const r14 = ruleAHFilingGap(phase1b?.ah_move_pct ?? null, phase1b?.ah_vol_ratio ?? null, phase1b?.gap_pct ?? null, phase1?.same_day_424b ?? [], phase1?.eightk?.found ?? false, eightk_signals);
  const r15 = ruleInsiderSignals((phase1 as any)?.insider_signals, eightk_signals);

  const rawScore =
    r1.points + r2.points + r3.points + r4.points + r5.points +
    r6.points + r7.points + r8.points + r9.points + r10.points + r11.points +
    r12.points + r13.points + r14.points + r15.points;

  const score = parseFloat(rawScore.toFixed(1));

  const singleTagRules = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14];
  const signals: SignalTag[] = [
    ...singleTagRules.filter(r => r.tag !== null).map(r => r.tag as SignalTag),
    ...r15.tags,
  ];

  // Override labels are display-only — no execution effect
  const overrides_fired: string[] = [r1, r2, r3]
    .filter(r => (r as { isOverride?: boolean }).isOverride && r.tag !== null)
    .map(r => r.tag as string);

  const bias = scoreToBias(score);
  const confidence = computeConfidence(score);
  const probabilities = computeProbabilities(score);
  const reason = buildReason(signals, bias);

  // Predictive Timing Bucket (Framework Bucket)
  const predicted_bucket = predictTimingBucket(
    p3?.structure,
    p3?.borrow,
    p3?.day_of_run ?? null,
    phase1b?.gap_pct ?? null,
    phase1b?.ah_move_pct ?? null,
    p3?.vwap_failed ?? null,
    p3?.wick_ratio ?? null,
    signals
  );

  let section: TradeSection | null = null;
  let clean_score: number | null = null;
  let clean_outcome: CleanOutcome | null = null;
  let outcome_profile: OutcomeProfile | null = null;

  if (score >= 8) {
    section = classifySection(predicted_bucket);

    if (section === 'S1') {
      clean_score = computeCleanScore(
        p3?.borrow,
        phase4?.shares_outstanding ?? null,
        p3?.w1_imbalance,
        phase1b?.gap_pct ?? null,
        p3?.wick_ratio ?? null,
        phase1?.same_day_424b ?? [],
        p3?.day_of_run ?? null,
        p3?.efficiency ?? null,
        p3?.volume_ratio ?? null
      );
      clean_outcome = cleanScoreToOutcome(clean_score);
      outcome_profile = OUTCOME_PROFILES[clean_outcome];
    } else {
      // S2/Delayed — use bucket profile for expected return
      outcome_profile = BUCKET_PROFILES[predicted_bucket];
    }
  }

  // Pattern stats — overrides + composite patterns + AH gap + insider form 144
  const allFiredTags = [...overrides_fired, ...signals.filter(s =>
    ['OFFERING_FADE', 'LF_BLOWOFF_FADE', 'AH_FILING_GAP_T1', 'AH_FILING_GAP_T2', 'FORM144_PRESALE'].includes(s)
  )];
  const pattern_stats: PatternStat[] = allFiredTags
    .filter(o => PATTERN_STATS[o])
    .map(o => PATTERN_STATS[o]);

  // Empirical S1/S2 probability — uses bucket-first priority
  const section_prob = empiricalSectionProb(
    predicted_bucket,
    p3?.borrow,
    phase1?.shelf_age_days ?? null,
    phase1?.prior_424b_count_12m ?? 0,
    phase1?.same_day_424b ?? [],
    phase2?.catalyst_tier ?? null,
    p3?.day_of_run ?? null
  );

  return {
    timestamp: new Date().toISOString(),
    score,
    bias,
    confidence,
    signals,
    reason,
    probabilities,
    section,
    section_prob,
    clean_score,
    clean_outcome,
    outcome_profile,
    overrides_fired,
    regime,
    pattern_stats,
    predicted_bucket,
  };
}
