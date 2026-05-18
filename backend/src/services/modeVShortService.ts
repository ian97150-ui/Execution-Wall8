/**
 * Mode V Short — threshold check + notification / auto-approval service.
 *
 * Gates (all must pass):
 *   1. disqualifiers.length === 0   — no structural blockers
 *   2. pre_fall_tier === 'HIGH'     — classifier score ≥ 50 / 150
 *   3. bias MAX_CONVICTION or HIGH_CONVICTION — active entry signal
 *   4. section === 'S1'             — D+1 fast dump expected
 *   5. confidence >= 0.65           — ≥ 65% classifier confidence
 *
 * Notification fires in both SAFE and FULL mode when gates pass.
 * Auto-approval only fires in FULL mode with auto_sub_mode === 'mode_v_short'.
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
 * Called after runChecklist completes.
 *
 * - SAFE mode:  fires Mode V Short Pushover notification (no auto-approval)
 * - FULL mode + auto_sub_mode 'mode_v_short':  fires notification + auto-approves intent
 *
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

  const mode: string = settings.execution_mode;
  if (mode !== 'safe' && mode !== 'full') return false;

  const snap = (checklist as any).score_snapshot as ScoreSnapshot | undefined;
  if (!meetsModeVShortThreshold(snap)) return false;

  // Need intent for ticker regardless of auto-approve path
  let intent: any;
  try {
    intent = await prisma.tradeIntent.findUnique({ where: { id: intentId } });
  } catch {
    return false;
  }
  if (!intent) return false;

  const notifDetails = {
    score:      snap!.pre_fall_score,
    tier:       snap!.pre_fall_tier,
    bias:       snap!.bias,
    confidence: `${Math.round((snap!.confidence ?? 0) * 100)}%`,
    section:    snap!.section,
    signals:    (snap!.overrides_fired ?? []).slice(0, 3).join(', ') || 'none',
  };

  // Always notify when threshold is met (safe or full)
  PushoverNotifications.modeVShortSignal(intent.ticker, notifDetails).catch(() => {});

  // Auto-approve only in FULL mode with mode_v_short sub-mode active
  if (mode !== 'full' || settings.auto_sub_mode !== 'mode_v_short') return false;
  if (intent.status !== 'pending') return false;

  await prisma.tradeIntent.update({
    where: { id: intentId },
    data: { status: 'swiped_on', card_state: 'ELIGIBLE' },
  });

  activateScheduler();

  console.log(
    `⚡ Mode V Short: auto-approved ${intent.ticker} ` +
    `(score ${snap!.pre_fall_score}, ${snap!.pre_fall_tier}, ${snap!.bias}, ` +
    `conf ${Math.round((snap!.confidence ?? 0) * 100)}%)`
  );
  return true;
}
