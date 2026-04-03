/**
 * Scoring Engine — Cat5ive v4 6-rule weighted scoring system.
 * Deterministic: same inputs → same output. No randomness.
 * Computes once at evaluation time; result stored in score_snapshot (non-repainting).
 */

import type { SecChecklist } from './secChecklistService';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SignalTag =
  | 'AH_BREAKDOWN'
  | 'STRONG_AH'
  | 'LATE_STAGE'
  | 'EXTENDED_RUN'
  | 'BLOWOFF_WICK'
  | 'CLEAN_STRUCTURE'
  | 'LIQUIDITY_TRAP'
  | 'ABSORPTION'
  | 'EXPANSION'
  | 'DILUTION'
  | 'SUPPLY_OVERHANG'
  | 'STRATEGIC_BUYING'
  | 'STRONG_CATALYST'
  | 'NO_DRIVER'
  | 'PM_STRENGTH'
  | 'VWAP_HOLD';

export type TradeBias =
  | 'STRONG_SHORT'
  | 'WEAK_SHORT'
  | 'NO_TRADE'
  | 'WEAK_LONG'
  | 'TRUE_LONG';

export type ProbPath =
  | 'dump'
  | 'fade'
  | 'chop'
  | 'continuation'
  | 'squeeze'
  | 'pullback'
  | 'failure';

export interface ScoreSnapshot {
  timestamp: string;
  score: number;
  bias: TradeBias;
  confidence: number;       // |score| / 120, capped 0–1
  signals: SignalTag[];
  reason: string;
  probabilities: { path: ProbPath; pct: number }[];  // top 3, always sums to 100
}

// ─── Rule 1 — AH Reversal ─────────────────────────────────────────────────────

function scoreAH(ah_move_pct: number | null): { points: number; tags: SignalTag[] } {
  if (ah_move_pct === null) return { points: 0, tags: [] };
  if (ah_move_pct <= -30) return { points: -45, tags: ['AH_BREAKDOWN'] };
  if (ah_move_pct <= -15) return { points: -25, tags: ['AH_BREAKDOWN'] };
  if (ah_move_pct < 15)   return { points: 0, tags: [] };
  if (ah_move_pct < 25)   return { points: 20, tags: ['STRONG_AH'] };
  return                         { points: 40, tags: ['STRONG_AH'] };
}

// ─── Rule 2 — Run Day ────────────────────────────────────────────────────────

function scoreRunDay(day_of_run: number | null): { points: number; tags: SignalTag[] } {
  if (day_of_run === null) return { points: 0, tags: [] };
  if (day_of_run === 1)    return { points: 10, tags: [] };
  if (day_of_run === 2)    return { points: 0, tags: [] };
  if (day_of_run === 3)    return { points: -25, tags: ['LATE_STAGE'] };
  return                          { points: -35, tags: ['LATE_STAGE'] };
}

// ─── Rule 3 — Wick Ratio ─────────────────────────────────────────────────────

function scoreWick(wick_ratio: number | null): { points: number; tags: SignalTag[] } {
  if (wick_ratio === null)  return { points: 0, tags: [] };
  if (wick_ratio >= 0.80)   return { points: -30, tags: ['BLOWOFF_WICK'] };
  if (wick_ratio >= 0.70)   return { points: -15, tags: ['BLOWOFF_WICK'] };
  if (wick_ratio >= 0.50)   return { points: 0, tags: [] };
  return                           { points: 10, tags: ['CLEAN_STRUCTURE'] };
}

// ─── Rule 4 — Dilution / Supply ──────────────────────────────────────────────

function scoreDilution(
  same_day_424b: { form: string; filing_url: string }[],
  prior_424b_count: number,
  shelf_type: string | null,
  eightk_signals: string[],
  catalyst_tier: number | null
): { points: number; tags: SignalTag[] } {
  const hasDistressedOffering =
    same_day_424b.length > 0 ||
    eightk_signals.includes('ATM_TERMINATED') ||
    eightk_signals.includes('UNDERWRITING_DONE');

  if (hasDistressedOffering) return { points: -30, tags: ['DILUTION'] };

  if (prior_424b_count >= 2) return { points: -20, tags: ['SUPPLY_OVERHANG'] };

  if (shelf_type) return { points: 0, tags: ['SUPPLY_OVERHANG'] };

  // Clean profile + tier 1 catalyst = strategic
  if (!shelf_type && prior_424b_count === 0 && catalyst_tier === 1) {
    return { points: 25, tags: ['STRATEGIC_BUYING'] };
  }

  return { points: 0, tags: [] };
}

// ─── Rule 5 — Efficiency ─────────────────────────────────────────────────────

function scoreEfficiency(efficiency: number | null): { points: number; tags: SignalTag[] } {
  if (efficiency === null) return { points: 0, tags: [] };
  if (efficiency < 0.30)   return { points: -35, tags: ['LIQUIDITY_TRAP'] };
  if (efficiency < 0.50)   return { points: -25, tags: ['ABSORPTION'] };
  if (efficiency < 0.70)   return { points: 0, tags: [] };
  return                          { points: 20, tags: ['EXPANSION'] };
}

// ─── Rule 6 — Catalyst ───────────────────────────────────────────────────────

function scoreCatalyst(catalyst_tier: number | null): { points: number; tags: SignalTag[] } {
  if (catalyst_tier === null) return { points: -10, tags: ['NO_DRIVER'] };
  if (catalyst_tier === 1)    return { points: 25, tags: ['STRONG_CATALYST'] };
  if (catalyst_tier === 2)    return { points: 0, tags: [] };
  return                             { points: 0, tags: [] };  // tier 3/4: vague PR, score via dilution
}

// ─── Bonus Signals ────────────────────────────────────────────────────────────

function scoreBonuses(
  gap_pct: number | null,
  vwap_failed: boolean | null
): { points: number; tags: SignalTag[] } {
  let points = 0;
  const tags: SignalTag[] = [];
  if (gap_pct !== null && gap_pct > 20) { points += 20; tags.push('PM_STRENGTH'); }
  if (vwap_failed === false)             { points += 15; tags.push('VWAP_HOLD'); }
  return { points, tags };
}

// ─── Correlated cap ──────────────────────────────────────────────────────────
// AH_BREAKDOWN + LATE_STAGE together: cap combined penalty at -55 to avoid double-counting
function applyCorrelatedCap(
  rawScore: number,
  tags: SignalTag[]
): number {
  const hasAHBreakdown = tags.includes('AH_BREAKDOWN');
  const hasLateStage   = tags.includes('LATE_STAGE');
  if (hasAHBreakdown && hasLateStage) {
    // Find their individual contributions and cap
    const ahContrib   = rawScore <= -70 ? rawScore + 35 : 0; // rough cap adjustment
    const cappedScore = Math.max(rawScore, rawScore + Math.max(0, (-rawScore) - 55 - Math.abs(ahContrib)));
    return Math.max(rawScore, -120); // just enforce floor
  }
  return rawScore;
}

// ─── Bias ────────────────────────────────────────────────────────────────────

function scoreToBias(score: number): TradeBias {
  if (score <= -40) return 'STRONG_SHORT';
  if (score <= -20) return 'WEAK_SHORT';
  if (score >= 40)  return 'TRUE_LONG';
  if (score >= 20)  return 'WEAK_LONG';
  return 'NO_TRADE';
}

// ─── Probability lookup ───────────────────────────────────────────────────────

function computeProbabilities(
  score: number,
  tags: SignalTag[]
): ScoreSnapshot['probabilities'] {
  let base: { path: ProbPath; pct: number }[];

  if (score <= -60)      base = [{ path: 'dump', pct: 75 }, { path: 'chop', pct: 15 }, { path: 'squeeze', pct: 10 }];
  else if (score <= -40) base = [{ path: 'dump', pct: 60 }, { path: 'fade', pct: 25 }, { path: 'squeeze', pct: 15 }];
  else if (score <= -20) base = [{ path: 'fade', pct: 55 }, { path: 'chop', pct: 30 }, { path: 'continuation', pct: 15 }];
  else if (score < 20)   base = [{ path: 'chop', pct: 45 }, { path: 'fade', pct: 30 }, { path: 'continuation', pct: 25 }];
  else if (score < 40)   base = [{ path: 'continuation', pct: 55 }, { path: 'pullback', pct: 30 }, { path: 'failure', pct: 15 }];
  else                   base = [{ path: 'continuation', pct: 65 }, { path: 'pullback', pct: 25 }, { path: 'failure', pct: 10 }];

  // Signal-based adjustments (always re-normalize to 100)
  if (tags.includes('AH_BREAKDOWN') && base[0].path !== 'continuation') {
    base[0].pct = Math.min(base[0].pct + 10, 85);
    base[1].pct = Math.max(base[1].pct - 10, 5);
  }
  if (tags.includes('STRONG_AH') && tags.includes('EXPANSION')) {
    const contIdx = base.findIndex(p => p.path === 'continuation');
    if (contIdx >= 0) {
      base[contIdx].pct = Math.min(base[contIdx].pct + 10, 85);
      base[base.length - 1].pct = Math.max(base[base.length - 1].pct - 10, 5);
    }
  }

  // Normalize to exactly 100
  const total = base.reduce((s, p) => s + p.pct, 0);
  return base.map(p => ({ path: p.path, pct: Math.round((p.pct / total) * 100) }));
}

// ─── Reason line ─────────────────────────────────────────────────────────────

const TAG_LABELS: Partial<Record<SignalTag, string>> = {
  AH_BREAKDOWN:    'AH breakdown',
  STRONG_AH:       'strong AH build',
  LATE_STAGE:      'late-stage run',
  BLOWOFF_WICK:    'blowoff wick',
  CLEAN_STRUCTURE: 'clean structure',
  LIQUIDITY_TRAP:  'liquidity trap',
  ABSORPTION:      'volume absorption',
  EXPANSION:       'volume expansion',
  DILUTION:        'live dilution',
  SUPPLY_OVERHANG: 'supply overhang',
  STRATEGIC_BUYING:'strategic buying',
  STRONG_CATALYST: 'tier-1 catalyst',
  NO_DRIVER:       'no catalyst',
  PM_STRENGTH:     'PM strength',
  VWAP_HOLD:       'VWAP holding',
};

function buildReason(tags: SignalTag[], bias: TradeBias): string {
  const top = tags.slice(0, 2).map(t => TAG_LABELS[t] ?? t.toLowerCase().replace(/_/g, ' '));
  if (top.length === 0) return bias === 'NO_TRADE' ? 'Mixed signals — no edge' : 'Insufficient data';
  return top.join(' + ');
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeScoreSnapshot(checklist: SecChecklist): ScoreSnapshot {
  const { phase1, phase1b, phase2, phase3 } = checklist;

  const r1 = scoreAH(phase1b?.ah_move_pct ?? null);
  const r2 = scoreRunDay(phase3?.day_of_run ?? null);
  const r3 = scoreWick(phase3?.wick_ratio ?? null);
  const r4 = scoreDilution(
    phase1?.same_day_424b ?? [],
    phase1?.prior_424b_count_12m ?? 0,
    phase1?.shelf_type ?? null,
    phase1?.eightk?.signals ?? [],
    phase2?.catalyst_tier ?? null
  );
  const r5 = scoreEfficiency((phase3 as any)?.efficiency ?? null);
  const r6 = scoreCatalyst(phase2?.catalyst_tier ?? null);
  const rb = scoreBonuses(phase1b?.gap_pct ?? null, phase3?.vwap_failed ?? null);

  const rawScore = r1.points + r2.points + r3.points + r4.points + r5.points + r6.points + rb.points;
  const allTags: SignalTag[] = [
    ...r1.tags, ...r2.tags, ...r3.tags, ...r4.tags, ...r5.tags, ...r6.tags, ...rb.tags
  ];

  const score = Math.max(-120, Math.min(120, applyCorrelatedCap(rawScore, allTags)));
  const bias = scoreToBias(score);
  const confidence = parseFloat((Math.min(Math.abs(score) / 120, 1)).toFixed(2));
  const probabilities = computeProbabilities(score, allTags);
  const reason = buildReason(allTags, bias);

  return {
    timestamp: new Date().toISOString(),
    score,
    bias,
    confidence,
    signals: allTags,
    reason,
    probabilities
  };
}
