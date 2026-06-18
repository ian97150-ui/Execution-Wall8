/**
 * Mode V Short — threshold check + notification / auto-approval service.
 *
 * Signal stack thresholds (dual strategy report, 197-session dataset):
 *
 * AUTO-EXEC (strict) — two-stage gate:
 *   Stage 1 — OHLCV (signals 1-6, always available):
 *     1. disqualifiers.length === 0
 *     2. section === 'S1'
 *     3. auto_signal_count >= 6  (all 6 OHLCV signals fire)
 *     4. confidence >= 0.55
 *   Stage 2 — Tick confirmation (signals 7-8, v4 Tradier layer):
 *     When stage-1 OHLCV count == 6, fetch tick data via runClassifierWithTicks().
 *     Auto-execute only when total auto_signal_count >= 7
 *     (at least 1 of the 2 tick signals confirms).
 *
 * NOTIFICATION (loose):
 *   1. disqualifiers.length === 0
 *   2. section S1 or S2
 *   3. auto_signal_count >= 3  (AUTO ZONE per report, 55%+ win rate)
 *
 * Notification fires in SAFE and FULL mode when loose gates pass.
 * Auto-approval only fires in FULL + auto_sub_mode=mode_v_short when strict gates pass.
 */

import { prisma } from '../index';
import { ScoreSnapshot } from './scoringEngineService';
import type { SecChecklist } from './secChecklistService';
import { runClassifier, runClassifierWithTicks, type ClassifierSignal } from './classifierService';
import { captureSignal } from './liveTradeExportService';
import { recordConsidered } from './liveConsideredService';
import { PushoverNotifications } from './pushoverService';
import { activateScheduler } from './executionScheduler';

/**
 * Strict threshold for auto-execution (stage 2 — tick-confirmed).
 * Requires all 6 OHLCV signals AND at least 1 tick signal (total >= 7).
 */
export function meetsModeVShortThreshold(
  snap: ScoreSnapshot | null | undefined
): boolean {
  if (!snap) return false;
  if ((snap.disqualifiers ?? []).length > 0) return false;
  if (snap.section !== 'S1') return false;
  if ((snap.confidence ?? 0) < 0.55) return false;
  // Tick layer must have run and total signal count must be 7 or 8
  if (!snap.ticks_available) return false;
  if ((snap.auto_signal_count ?? 0) < 7) return false;
  return true;
}

/**
 * Loose threshold for push notifications only.
 * Defaults: S1 ≥3 signals, S2 ≥4 signals, confidence ≥45%.
 * Thresholds are configurable via ExecutionSettings (mode_v_notify_* fields).
 */
export function meetsModeVShortNotifyThreshold(
  snap: ScoreSnapshot | null | undefined,
  settings?: { mode_v_notify_min_signals?: number; mode_v_notify_min_conf?: number; mode_v_notify_s2_min_signals?: number }
): boolean {
  if (!snap) return false;
  const minSig   = settings?.mode_v_notify_min_signals    ?? 3;
  const minConf  = (settings?.mode_v_notify_min_conf      ?? 45) / 100;
  const s2MinSig = settings?.mode_v_notify_s2_min_signals ?? 4;
  if ((snap.disqualifiers ?? []).length > 0) return false;
  if (snap.section !== 'S1' && snap.section !== 'S2') return false;
  if ((snap.confidence ?? 0) < minConf) return false;
  const minSignals = snap.section === 'S2' ? s2MinSig : minSig;
  if ((snap.auto_signal_count ?? 0) < minSignals) return false;
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
  let snap = (checklist as any).score_snapshot as ScoreSnapshot | undefined;

  // Check loose threshold — fires notification in SAFE and FULL mode
  if (!meetsModeVShortNotifyThreshold(snap, settings)) return false;

  const ohlcvCount = snap?.auto_signal_count ?? 0;

  // Stage 2: when all 6 OHLCV signals are active, fetch tick data to evaluate signals 7-8
  let tickSnap: ScoreSnapshot | undefined;
  if (ohlcvCount >= 6 && !snap?.ticks_available) {
    console.log(`[ModeV] ${intent.ticker} OHLCV stack full (${ohlcvCount}/6) — fetching tick data`);
    try {
      const tickDate = (intent as any).created_at
        ? new Date((intent as any).created_at).toISOString().slice(0, 10)
        : undefined;
      const tickCls = await runClassifierWithTicks(intent.ticker, tickDate);
      if (tickCls) {
        const tickActive = (tickCls.ticks_available === true)
          && (tickCls.tick_rate_pm ?? 0) >= 50
          && (tickCls.tick_rate_pm ?? 0) <= 150;
        const sellDom = (tickCls.ticks_available === true)
          && (tickCls.buy_pressure_pct ?? 100) < 35;
        const prevSignals = snap?.auto_signals_active ?? [];
        const newSignals  = [
          ...prevSignals.filter(s => s !== 'TICK_ACTIVE' && s !== 'SELL_DOM'),
          ...(tickActive ? ['TICK_ACTIVE'] : []),
          ...(sellDom    ? ['SELL_DOM']    : []),
        ];
        tickSnap = {
          ...snap!,
          tick_rate_pm:        tickCls.tick_rate_pm,
          buy_pressure_pct:    tickCls.buy_pressure_pct,
          ticks_available:     tickCls.ticks_available ?? false,
          auto_signals_active: newSignals,
          auto_signal_count:   newSignals.length,
        } as ScoreSnapshot;
        console.log(
          `[ModeV] ${intent.ticker} tick check — rate=${tickCls.tick_rate_pm?.toFixed(0) ?? 'n/a'}/min ` +
          `buy=${tickCls.buy_pressure_pct?.toFixed(0) ?? 'n/a'}% ` +
          `stack=${tickSnap.auto_signal_count}/8 [${newSignals.join(',')}]`
        );
        snap = tickSnap;
      }
    } catch (err) {
      console.warn(`[ModeV] tick fetch failed for ${intent.ticker}:`, err instanceof Error ? err.message : err);
    }
  }

  const strictPass = meetsModeVShortThreshold(snap);

  const ncTag = (snap!.regime?.regime === 'NEWS_CONTINUATION') ? ' ⚠️ NC regime (thin edge)' : '';
  const notifDetails = {
    score:      snap!.pre_fall_score,
    tier:       snap!.pre_fall_tier,
    bias:       snap!.bias,
    confidence: `${Math.round((snap!.confidence ?? 0) * 100)}%`,
    section:    snap!.section,
    signals:    (snap!.overrides_fired ?? []).slice(0, 3).join(', ') || 'none',
    strategy:   strategyId || 'N/A',
    auto_stack: `${snap!.auto_signal_count ?? 0}/8${ncTag}`,
    tick_status: snap!.ticks_available ? 'tick-confirmed' : 'ohlcv-only',
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
    `stack=${snap!.auto_signal_count}/8 [${(snap!.auto_signals_active ?? []).join(',')}] ` +
    `conf ${Math.round((snap!.confidence ?? 0) * 100)}%`
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
  const isManualWatch = prevT2Type === 'MANUAL_WATCH';
  const reducedSize   = prevT2Type === 'VERY_EARLY'; // MANUAL_WATCH is always full size

  await prisma.tradeIntent.update({
    where: { id: intentId },
    data:  {
      price: String(cls.price),
      ...(isManualWatch && { manual_watch: false, wait_watch_until: null }),
    },
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
    was_t2:    isManualWatch ? 'MANUAL WATCH' : prevT2Type,
    size_note: reducedSize ? 'REDUCED SIZE (VERY_EARLY)' : 'FULL SIZE',
  }).catch(() => {});

  let settings: any = null;
  try { settings = await prisma.executionSettings.findFirst(); } catch {}

  if (settings?.execution_mode === 'full' && settings?.auto_sub_mode === 'mode_v_short') {
    // Build auto signal stack from the upgraded ClassifierSignal (v3, no ticks)
    const _autoSignals: string[] = [];
    if ((cls.vol_above_vwap_pct    ?? 100)  < 40)  _autoSignals.push('VOL_LT40');
    if ((cls.hod_set_pct           ?? 100)  < 30)  _autoSignals.push('HOD_LT30');
    if (cls.quiet_dump_proxy       === true)        _autoSignals.push('QUIET_DUMP');
    if ((cls.session_low_vs_pm_open ?? 0)   >= 20) _autoSignals.push('DEEP_LOD');
    if (cls.entry_c_fired          === true)        _autoSignals.push('ENTRY_C');
    if ((cls.wc_score              ?? 0)    >= 4)  _autoSignals.push('WC_GTE4');
    const fakeSnap = {
      disqualifiers:       cls.disqualifiers ?? [],
      section:             cls.section,
      confidence:          cls.confidence / 100,
      ticks_available:     false,   // v3 path — tick check not run on wait upgrade
      auto_signal_count:   _autoSignals.length,
      auto_signals_active: _autoSignals,
    };
    // Wait-upgrade auto-exec: require 6/6 OHLCV (tick check not available on upgrade path)
    const waitUpgradePass = (fakeSnap.disqualifiers.length === 0)
      && (fakeSnap.section === 'S1')
      && (fakeSnap.confidence >= 0.55)
      && (fakeSnap.auto_signal_count >= 6);
    if (waitUpgradePass) {
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

// ─── ORDER-Time Re-validation ─────────────────────────────────────────────────

/**
 * Called fire-and-forget when an ORDER arrives for a Mode V-approved intent.
 * Re-evaluates the full 8-signal stack with fresh data. If conditions have
 * degraded below the strict threshold, reverts the intent to 'pending' so the
 * user must manually approve instead of allowing the auto-execute to proceed.
 *
 * Non-blocking — never called with await from the webhook path.
 */
export async function revalidateModeVOnOrder(
  intentId: string,
  ticker:   string,
): Promise<void> {
  let settings: any;
  try { settings = await prisma.executionSettings.findFirst(); } catch { return; }
  if (settings?.auto_sub_mode !== 'mode_v_short') return;
  if (settings?.execution_mode !== 'full') return;

  // Intent may have been manually changed between WALL and ORDER
  const intent = await prisma.tradeIntent
    .findUnique({ where: { id: intentId } })
    .catch(() => null);
  if (!intent || intent.status !== 'swiped_on') return;

  const today = new Date().toISOString().slice(0, 10);

  // Fast OHLCV re-check (no tick layer yet)
  let cls: ClassifierSignal | null = null;
  try {
    cls = await runClassifier(ticker, today);
  } catch (err) {
    console.warn(`[ModeV:Order] ${ticker} OHLCV re-eval failed:`, err instanceof Error ? err.message : err);
  }
  if (!cls) {
    console.log(`[ModeV:Order] ${ticker} — classifier unavailable on re-eval, keeping approval`);
    return;
  }

  // Recompute OHLCV signal stack
  const ohlcvSignals: string[] = [];
  if ((cls.vol_above_vwap_pct    ?? 100) < 40)  ohlcvSignals.push('VOL_LT40');
  if ((cls.hod_set_pct           ?? 100) < 30)  ohlcvSignals.push('HOD_LT30');
  if (cls.quiet_dump_proxy       === true)        ohlcvSignals.push('QUIET_DUMP');
  if ((cls.session_low_vs_pm_open ?? 0)  >= 20) ohlcvSignals.push('DEEP_LOD');
  if (cls.entry_c_fired          === true)        ohlcvSignals.push('ENTRY_C');
  if ((cls.wc_score              ?? 0)   >= 4)  ohlcvSignals.push('WC_GTE4');

  let allSignals     = [...ohlcvSignals];
  let ticks_available = false;

  // If OHLCV count is still healthy (≥5), fetch ticks for the full 8-signal check
  if (ohlcvSignals.length >= 5) {
    try {
      const tickCls = await runClassifierWithTicks(ticker, today);
      if (tickCls?.ticks_available) {
        ticks_available = true;
        const rate = tickCls.tick_rate_pm ?? 0;
        if (rate >= 50 && rate <= 150)               allSignals.push('TICK_ACTIVE');
        if ((tickCls.buy_pressure_pct ?? 100) < 35)  allSignals.push('SELL_DOM');
      }
    } catch (err) {
      console.warn(`[ModeV:Order] ${ticker} tick re-eval failed:`, err instanceof Error ? err.message : err);
    }
  }

  const totalCount    = allSignals.length;
  const disqualifiers = cls.disqualifiers ?? [];
  const section       = cls.section ?? '';
  const confidence    = (cls.confidence ?? 0) / 100;

  const stillPasses = disqualifiers.length === 0
    && section === 'S1'
    && confidence >= 0.55
    && ticks_available
    && totalCount >= 7;

  console.log(
    `[ModeV:Order] ${ticker} re-eval — stack=${totalCount}/8 [${allSignals.join(',')}] ` +
    `ticks=${ticks_available} disq=${disqualifiers.length} section=${section} ` +
    `conf=${Math.round(confidence * 100)}% → ${stillPasses ? 'CONFIRMED ✅' : 'DEGRADED ⚠️'}`
  );

  if (stillPasses) return;

  // Conditions degraded — revoke auto-approval
  await prisma.tradeIntent.update({
    where: { id: intentId },
    data:  { status: 'pending' },
  }).catch(err => console.warn(`[ModeV:Order] ${ticker} revoke update failed:`, err instanceof Error ? err.message : err));

  console.log(`[ModeV:Order] ${ticker} auto-approval REVOKED (${totalCount}/8 signals at ORDER time) — reverted to pending`);

  PushoverNotifications.modeVShortSignal(ticker, {
    score:       cls.score,
    tier:        cls.tier,
    bias:        cls.bias,
    confidence:  `${Math.round(confidence * 100)}%`,
    section,
    signals:     ohlcvSignals.slice(0, 3).join(', ') || 'none',
    strategy:    'N/A',
    auto_stack:  `${totalCount}/8`,
    tick_status: ticks_available ? 'tick-confirmed' : 'ohlcv-only',
    verified:    'REVOKED — manual approval required',
  }).catch(() => {});
}
