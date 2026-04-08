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
  | 'VWAP_HELD';

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

export interface ScoreSnapshot {
  timestamp: string;
  score: number;                              // raw weighted sum
  bias: TradeBias;
  confidence: number;                         // 0–1
  signals: SignalTag[];
  reason: string;
  probabilities: { path: ProbPath; pct: number }[];  // top 3, sums to 100
  section: TradeSection | null;               // S1 (D+1) or S2 (D+5) — only when score >= 8
  clean_score: number | null;                 // 0–10, S1 only
  clean_outcome: CleanOutcome | null;         // DUMP/CLEAN_FADE/VOLATILE_FADE/CHOP
  overrides_fired: string[];                  // display-only override labels
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

// ─── S1/S2 Classifier ────────────────────────────────────────────────────────
// Only run when short score >= 8. Tie → S1 (lower risk).

function classifySection(
  vwap_failed: boolean | null,
  day_of_run: number | null,
  gap_pct: number | null,
  borrow: string | null | undefined,
  prior_424b_count: number,
  volume_ratio: number | null,
  w1_imbalance: number | null | undefined,
  ah_move_pct: number | null,
  shares_outstanding: number | null,
  structure: string | null | undefined,
  wick_ratio: number | null,
  efficiency: number | null
): TradeSection {
  let s1 = 0;
  let s2 = 0;

  // S1 signals
  if (vwap_failed === true)                                               s1 += 3;
  if (day_of_run !== null && day_of_run >= 3)                            s1 += 4;
  if (structure === 'BLOW_OFF_TOP')                                       s1 += 2;
  if (efficiency !== null && efficiency < 0.50)                          s1 += 1;
  if (wick_ratio !== null && wick_ratio >= 0.65)                         s1 += 2;
  if (gap_pct !== null && gap_pct >= 50 && gap_pct < 200)                s1 += 2;
  if (prior_424b_count > 0)                                              s1 += 1;
  if (volume_ratio !== null && volume_ratio < 200)                       s1 += 1;
  if (borrow === 'EASY')                                                  s1 += 2;
  if (ah_move_pct !== null && ah_move_pct < -30 && ah_move_pct >= -80)  s1 += 3.5;
  if (ah_move_pct !== null && ah_move_pct < -80)                        s1 += 5;

  // S2 signals
  if (vwap_failed === false)                                              s2 += 5;
  if (volume_ratio !== null && volume_ratio >= 200)                      s2 += 3;
  if (gap_pct !== null && gap_pct >= 200 && structure === 'BLOW_OFF_TOP') s2 += 2;
  else if (gap_pct !== null && gap_pct >= 200)                           s2 += 2;
  if (structure === 'WEAK_HOLD' || structure === 'STRONG_HOLD')          s2 += 2;
  if (wick_ratio !== null && wick_ratio < 0.40)                          s2 += 1;
  if (gap_pct !== null && gap_pct >= 100)                                s2 += 1;
  if (borrow === 'NO_LOCATE')                                             s2 += 4;
  if (borrow === 'HTB')                                                   s2 += 3;
  if (borrow === 'HARD')                                                  s2 += 1;
  if (w1_imbalance !== null && w1_imbalance !== undefined && w1_imbalance >= 0.65) s2 += 3;
  if (shares_outstanding !== null && shares_outstanding >= 1_000_000 && shares_outstanding <= 5_000_000) s2 += 1;

  // HTB exception: HTB + day 3+ → override to S1
  if (borrow === 'HTB' && day_of_run !== null && day_of_run >= 3) {
    return 'S1';
  }

  return s1 >= s2 ? 'S1' : 'S2';
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

  const rawScore =
    r1.points + r2.points + r3.points + r4.points + r5.points +
    r6.points + r7.points + r8.points + r9.points + r10.points + r11.points;

  const score = parseFloat(rawScore.toFixed(1));

  const signals: SignalTag[] = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11]
    .filter(r => r.tag !== null)
    .map(r => r.tag as SignalTag);

  // Override labels are display-only — no execution effect
  const overrides_fired: string[] = [r1, r2, r3]
    .filter(r => (r as { isOverride?: boolean }).isOverride && r.tag !== null)
    .map(r => r.tag as string);

  const bias = scoreToBias(score);
  const confidence = computeConfidence(score);
  const probabilities = computeProbabilities(score);
  const reason = buildReason(signals, bias);

  let section: TradeSection | null = null;
  let clean_score: number | null = null;
  let clean_outcome: CleanOutcome | null = null;

  if (score >= 8) {
    section = classifySection(
      p3?.vwap_failed ?? null,
      p3?.day_of_run ?? null,
      phase1b?.gap_pct ?? null,
      p3?.borrow,
      phase1?.prior_424b_count_12m ?? 0,
      p3?.volume_ratio ?? null,
      p3?.w1_imbalance,
      phase1b?.ah_move_pct ?? null,
      phase4?.shares_outstanding ?? null,
      p3?.structure,
      p3?.wick_ratio ?? null,
      p3?.efficiency ?? null
    );

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
    }
  }

  return {
    timestamp: new Date().toISOString(),
    score,
    bias,
    confidence,
    signals,
    reason,
    probabilities,
    section,
    clean_score,
    clean_outcome,
    overrides_fired,
  };
}
