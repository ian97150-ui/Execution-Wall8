/**
 * Mode V Short — auto-approval service.
 *
 * Defines the 5-gate threshold for a "verified high-conviction short" and
 * auto-approves TradeIntent cards when execution_mode is 'auto' + auto_sub_mode
 * is 'mode_v_short' and the classifier score_snapshot passes all gates.
 *
 * Gates (all must pass):
 *   1. disqualifiers.length === 0   — no structural blockers
 *   2. pre_fall_tier === 'HIGH'     — classifier score ≥ 50 / 150
 *   3. bias MAX_CONVICTION or HIGH_CONVICTION — active entry signal
 *   4. section === 'S1'             — D+1 fast dump expected
 *   5. confidence >= 0.65           — ≥ 65% classifier confidence
 */

import { prisma } from '../index';
import { ScoreSnapshot } from './scoringEngineService';
import { SecChecklist } from './secChecklistService';
import { PushoverNotifications } from './pushoverService';
import { activateScheduler } from './executionScheduler';

const MODE_V_SHORT_BIAS = new Set(['MAX_CONVICTION', 'HIGH_CONVICTION']);

/** Returns true if score_snapshot meets the Mode V Short threshold. */
export function meetsModeVShortThreshold(snap: ScoreSnapshot | null | undefined): boolean {
  if (!snap) return false;
  if ((snap.disqualifiers ?? []).length > 0) return false;
  if (snap.pre_fall_tier !== 'HIGH') return false;
  if (!MODE_V_SHORT_BIAS.has(snap.bias)) return false;
  if (snap.section !== 'S1') return false;
  if ((snap.confidence ?? 0) < 0.65) return false;
  return true;
}

/**
 * Called after runChecklist completes. If execution_mode is 'auto' with
 * auto_sub_mode 'mode_v_short' and the checklist score passes all gates,
 * auto-approves the intent and fires a Pushover notification.
 * Returns true if the intent was auto-approved.
 */
export async function tryAutoApproveForModeVShort(
  intentId: string,
  checklist: SecChecklist
): Promise<boolean> {
  let settings: any;
  try {
    settings = await prisma.executionSettings.findFirst();
  } catch {
    return false;
  }
  if (!settings) return false;
  if (settings.execution_mode !== 'auto') return false;
  if (settings.auto_sub_mode !== 'mode_v_short') return false;

  const snap = (checklist as any).score_snapshot as ScoreSnapshot | undefined;
  if (!meetsModeVShortThreshold(snap)) return false;

  // Only approve intents still pending — skip if already approved/denied
  let intent: any;
  try {
    intent = await prisma.tradeIntent.findUnique({ where: { id: intentId } });
  } catch {
    return false;
  }
  if (!intent || intent.status !== 'pending') return false;

  await prisma.tradeIntent.update({
    where: { id: intentId },
    data: { status: 'swiped_on', card_state: 'ELIGIBLE' },
  });

  activateScheduler();

  PushoverNotifications.modeVShortSignal(intent.ticker, {
    score:      snap!.pre_fall_score,
    tier:       snap!.pre_fall_tier,
    bias:       snap!.bias,
    confidence: `${Math.round((snap!.confidence ?? 0) * 100)}%`,
    section:    snap!.section,
    signals:    (snap!.overrides_fired ?? []).slice(0, 3).join(', ') || 'none',
  }).catch(() => {});

  console.log(
    `⚡ Mode V Short: auto-approved ${intent.ticker} ` +
    `(score ${snap!.pre_fall_score}, ${snap!.pre_fall_tier}, ${snap!.bias}, ` +
    `conf ${Math.round((snap!.confidence ?? 0) * 100)}%)`
  );
  return true;
}
