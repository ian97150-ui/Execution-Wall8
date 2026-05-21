/**
 * Mode V Short — threshold check + notification / auto-approval service.
 *
 * TWO threshold levels:
 *
 * AUTO-EXEC (strict) — all 5 gates:
 *   1. disqualifiers.length === 0
 *   2. pre_fall_tier HIGH or MEDIUM  (score >= 25)
 *   3. bias MAX_CONVICTION (Strat A) or MAX/HIGH_CONVICTION (Strat B)
 *   4. section === 'S1'
 *   5. confidence >= 0.65
 *
 * NOTIFICATION (loose) — same gates, wider windows:
 *   1. disqualifiers.length === 0       (unchanged — structural blockers always disqualify)
 *   2. pre_fall_tier HIGH, MEDIUM or LOW (score >= 10)
 *   3. bias MAX, HIGH, or LOW_CONVICTION (NO_CONVICTION excluded)
 *   4. section S1 or S2                 (includes D+2-D+5 setups, avg 65.9% move)
 *   5. confidence >= 0.50
 *
 * Notification fires in SAFE and FULL mode when loose gates pass.
 * Auto-approval only fires in FULL + auto_sub_mode=mode_v_short when strict gates pass.
 */

import { prisma } from '../index';
import { ScoreSnapshot } from './scoringEngineService';
import type { SecChecklist } from './secChecklistService';
import type { ClassifierSignal } from './classifierService';
import { captureSignal } from './liveTradeExportService';
import { recordConsidered } from './liveConsideredService';
import { PushoverNotifications } from './pushoverService';
import { activateScheduler } from './executionScheduler';

const EXEC_BIAS   = new Set(['MAX_CONVICTION', 'HIGH_CONVICTION']);
const NOTIFY_BIAS = new Set(['MAX_CONVICTION', 'HIGH_CONVICTION', 'LOW_CONVICTION']);

/**
 * Strict threshold for auto-execution.
 * strategyId: 'Strat A' | 'Strat B' | ...
 */
export function meetsModeVShortThreshold(
  snap: ScoreSnapshot | null | undefined,
  strategyId?: string
): boolean {
  if (!snap) return false;
  if ((snap.disqualifiers ?? []).length > 0) return false;
  if (snap.pre_fall_tier !== 'HIGH' && snap.pre_fall_tier !== 'MEDIUM') return false;

  const isStratA = strategyId === 'Strat A';
  if (isStratA) {
    if (snap.bias !== 'MAX_CONVICTION') return false;
  } else {
    if (!EXEC_BIAS.has(snap.bias)) return false;
  }

  if (snap.section !== 'S1') return false;
  const conf = snap.confidence ?? 0;
  const tier = snap.signal_tier as string | undefined;
  const SLIGHTLY_EARLY_TIERS = new Set(['TIER_1', 'TIER_2']);
  const g5Standard      = conf >= 0.65;
  const g5SlightlyEarly = conf >= 0.55 && conf < 0.65 && !!tier && SLIGHTLY_EARLY_TIERS.has(tier);
  if (!g5Standard && !g5SlightlyEarly) return false;
  return true;
}

/**
 * Loose threshold for push notifications only.
 * Catches borderline setups worth manual review — does NOT trigger auto-execution.
 */
export function meetsModeVShortNotifyThreshold(
  snap: ScoreSnapshot | null | undefined
): boolean {
  if (!snap) return false;
  if ((snap.disqualifiers ?? []).length > 0) return false;
  if (snap.pre_fall_tier !== 'HIGH' && snap.pre_fall_tier !== 'MEDIUM' && snap.pre_fall_tier !== 'LOW') return false;
  if (!NOTIFY_BIAS.has(snap.bias)) return false;
  if (snap.section !== 'S1' && snap.section !== 'S2') return false;
  if ((snap.confidence ?? 0) < 0.50) return false;
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

  // Load intent early — needed for strategy_id and ticker
  let intent: any;
  try {
    intent = await prisma.tradeIntent.findUnique({ where: { id: intentId } });
  } catch {
    return false;
  }
  if (!intent) return false;

  const strategyId: string = (intent as any).strategy_id ?? '';
  const snap = (checklist as any).score_snapshot as ScoreSnapshot | undefined;

  // Check loose threshold first — fires notification in both SAFE and FULL mode
  if (!meetsModeVShortNotifyThreshold(snap)) return false;

  const strictPass = meetsModeVShortThreshold(snap, strategyId);

  const notifDetails = {
    score:      snap!.pre_fall_score,
    tier:       snap!.pre_fall_tier,
    bias:       snap!.bias,
    confidence: `${Math.round((snap!.confidence ?? 0) * 100)}%`,
    section:    snap!.section,
    signals:    (snap!.overrides_fired ?? []).slice(0, 3).join(', ') || 'none',
    strategy:   strategyId || 'N/A',
    // Flag whether this also met the strict (auto-exec) bar
    verified:   strictPass ? 'AUTO-EXEC GRADE' : 'REVIEW NEEDED',
  };

  PushoverNotifications.modeVShortSignal(intent.ticker, notifDetails).catch(() => {});

  // Auto-approve only when strict gates pass + FULL mode + mode_v_short sub-mode
  if (!strictPass) return false;
  if (mode !== 'full' || settings.auto_sub_mode !== 'mode_v_short') return false;
  if (intent.status !== 'pending') return false;

  await prisma.tradeIntent.update({
    where: { id: intentId },
    data: { status: 'swiped_on', card_state: 'ELIGIBLE' },
  });

  activateScheduler();

  console.log(
    `⚡ Mode V Short: auto-approved ${intent.ticker} ` +
    `[${strategyId || 'unknown'}] ` +
    `(score ${snap!.pre_fall_score}, ${snap!.pre_fall_tier}, ${snap!.bias}, ` +
    `conf ${Math.round((snap!.confidence ?? 0) * 100)}%)`
  );
  return true;
}

// ─── WAIT Upgrade Watcher ─────────────────────────────────────────────────────

const WAIT_WATCH_WINDOWS_MS: Record<string, number> = {
  EARLY:      20 * 60_000,   // 20 min — confirms 6–15 min after entry
  VERY_EARLY: 40 * 60_000,   // 40 min — confirms 16–30 min after entry
};
const WATCHABLE_T2 = new Set(['EARLY', 'VERY_EARLY']);

/**
 * Called after runChecklist completes when signal is WAIT.
 * Writes wait_watch_until when eligibility conditions are met.
 */
export async function registerWaitWatch(
  intentId: string,
  ticker: string,
  checklist: SecChecklist
): Promise<void> {
  const snap = (checklist as any).score_snapshot as ScoreSnapshot | undefined;
  if (!snap) return;

  const rawSignal     = (snap as any).raw_signal as string   | undefined;
  const t2Type        = snap.t2_entry_type       as string   | undefined;
  const disqualifiers = snap.disqualifiers        as string[] | undefined;
  const gatesPassed   = snap.gates_passed         as number   | undefined;

  if (rawSignal !== 'WAIT' && rawSignal !== 'SKIP') return;

  const isWatchable = WATCHABLE_T2.has(t2Type ?? '')
    && (disqualifiers ?? []).length === 0
    && (gatesPassed ?? 0) >= 3;

  if (!isWatchable) {
    recordConsidered(intentId, ticker, snap, 'NOT_ELIGIBLE')
      .catch(err => console.warn(`[LiveConsidered] NOT_ELIGIBLE ${ticker}:`,
        err instanceof Error ? err.message : err));
    return;
  }

  const windowMs   = WAIT_WATCH_WINDOWS_MS[t2Type!] ?? WAIT_WATCH_WINDOWS_MS.EARLY;
  const watchUntil = new Date(Date.now() + windowMs);

  await prisma.tradeIntent.update({
    where: { id: intentId },
    data:  { wait_watch_until: watchUntil },
  });

  console.log(`[WaitWatch] ${t2Type} registered intent ${intentId} — watching until ${watchUntil.toISOString()}`);
}

/**
 * Called from refreshLiveScore when a WAIT ticker upgrades to an entry signal.
 * Updates price, captures live trade, sends notification, optionally auto-approves.
 */
export async function handleWaitUpgrade(
  intentId: string,
  cls: ClassifierSignal,
  prevT2Type: string
): Promise<void> {
  const reducedSize = prevT2Type === 'VERY_EARLY';

  await prisma.tradeIntent.update({
    where: { id: intentId },
    data:  { price: String(cls.price) },
  });

  await captureSignal(cls, intentId).catch(err =>
    console.warn(`[WaitUpgrade] capture failed for ${cls.ticker}:`,
      err instanceof Error ? err.message : err));

  PushoverNotifications.waitUpgradeSignal(cls.ticker, {
    signal:    cls.signal,
    score:     cls.score,
    tier:      cls.tier,
    bias:      cls.bias,
    confidence:`${cls.confidence}%`,
    price:     cls.price,
    gates:     cls.gates_passed ?? 0,
    was_t2:    prevT2Type,
    size_note: reducedSize ? 'REDUCED SIZE (VERY_EARLY)' : 'FULL SIZE',
  }).catch(() => {});

  let settings: any = null;
  try { settings = await prisma.executionSettings.findFirst(); } catch {}

  if (settings?.execution_mode === 'full' && settings?.auto_sub_mode === 'mode_v_short') {
    const fakeSnap = {
      disqualifiers: cls.disqualifiers ?? [],
      pre_fall_tier: cls.tier,
      bias:          cls.bias,
      section:       cls.section,
      confidence:    cls.confidence / 100,
      signal_tier:   cls.signal_tier,
    };
    if (meetsModeVShortThreshold(fakeSnap as any)) {
      const intent = await prisma.tradeIntent
        .findUnique({ where: { id: intentId } }).catch(() => null);
      if (intent?.status === 'pending') {
        await prisma.tradeIntent.update({
          where: { id: intentId },
          data:  { status: 'swiped_on', card_state: 'ELIGIBLE' },
        });
        activateScheduler();
        console.log(`⚡ WaitUpgrade: auto-approved ${cls.ticker} [was ${prevT2Type}] (${cls.signal}, score ${cls.score})`);
      }
    }
  }

  console.log(`[WaitUpgrade] ${cls.ticker} WAIT→${cls.signal} (was ${prevT2Type}, score ${cls.score}, gates ${cls.gates_passed ?? 0}/5, $${cls.price})`);
}
