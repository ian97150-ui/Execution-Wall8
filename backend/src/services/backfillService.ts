import { prisma } from '../index';
import type { ScoreSnapshot } from './scoringEngineService';
import { buildRecordFromSnapshot } from './liveTradeExportService';
import { recordConsidered } from './liveConsideredService';

const ENTRY_SIGNALS = new Set(['ENTER_E', 'ENTER_A', 'HIGH_VALUE', 'LONG_OPP']);
const WATCHABLE_T2  = new Set(['EARLY', 'VERY_EARLY']);

function classifySnap(snap: ScoreSnapshot): 'entry' | 'wait' {
  const raw = (snap as any).raw_signal as string | undefined;
  if (raw) return ENTRY_SIGNALS.has(raw) ? 'entry' : 'wait';
  // Older records without raw_signal: infer conservatively from grade + tier
  if (snap.grade !== 'NONE' && snap.grade !== 'C' &&
      (snap.pre_fall_tier === 'HIGH' || snap.pre_fall_tier === 'MEDIUM'))
    return 'entry';
  return 'wait';
}

function inferConsideredOutcome(
  snap: ScoreSnapshot,
  waitWatchUntil: Date | null
): 'NOT_ELIGIBLE' | 'NEVER_UPGRADED' {
  // Intent was registered for watching and window has passed → NEVER_UPGRADED
  if (waitWatchUntil && new Date() > waitWatchUntil) return 'NEVER_UPGRADED';
  // Retroactively apply eligibility rules for pre-watcher intents
  const t2 = snap.t2_entry_type;
  const isWatchable = WATCHABLE_T2.has(t2 ?? '')
    && (snap.disqualifiers ?? []).length === 0
    && (snap.gates_passed ?? 0) >= 3;
  return isWatchable ? 'NEVER_UPGRADED' : 'NOT_ELIGIBLE';
}

export interface BackfillResult {
  trades:     { created: number; skipped: number };
  considered: { created: number; skipped: number };
  errors:     string[];
}

export async function backfillAll(dryRun = false): Promise<BackfillResult> {
  const result: BackfillResult = {
    trades:     { created: 0, skipped: 0 },
    considered: { created: 0, skipped: 0 },
    errors:     [],
  };

  const intents = await prisma.tradeIntent.findMany({
    where:   { sec_checklist: { not: null } },
    orderBy: { created_date: 'asc' },
    select:  { id: true, ticker: true, price: true, created_date: true,
               sec_checklist: true, wait_watch_until: true },
  });

  for (const intent of intents) {
    let snap: ScoreSnapshot | undefined;
    try {
      snap = JSON.parse(intent.sec_checklist!).score_snapshot as ScoreSnapshot | undefined;
    } catch {
      result.errors.push(`${intent.ticker} (${intent.id.slice(0, 8)}): invalid JSON`);
      continue;
    }
    if (!snap) continue;

    const type = classifySnap(snap);

    if (type === 'entry') {
      // Skip if live_trades already has a record for this intent
      const existing = await prisma.liveTrade.findFirst({ where: { intent_id: intent.id } });
      if (existing) { result.trades.skipped++; continue; }

      try {
        const record = buildRecordFromSnapshot(
          snap, intent.ticker, intent.id, intent.price, intent.created_date
        );
        if (!dryRun) {
          await prisma.liveTrade.upsert({
            where:  { record_id: record.record_id },
            update: { record_json: JSON.stringify(record) },
            create: {
              record_id:   record.record_id,
              ticker:      intent.ticker,
              date:        record.date,
              signal:      record.signal,
              strategy:    record.strategy,
              intent_id:   intent.id,
              record_json: JSON.stringify(record),
              captured_at: intent.created_date,
            },
          });
        }
        result.trades.created++;
      } catch (err: any) {
        result.errors.push(`trade ${intent.ticker} (${intent.id.slice(0, 8)}): ${err.message}`);
      }

    } else {
      // WAIT/SKIP → live_considered
      // Skip if already recorded (record_id is deterministic from intentId)
      const etDate  = new Date(intent.created_date.getTime() + (-4 * 60 * 60 * 1000));
      const dateStr = etDate.toISOString().slice(0, 10);
      const record_id = `${intent.ticker}_${dateStr.replace(/-/g, '')}_WAIT_${intent.id.slice(0, 8)}`;
      const existing = await prisma.liveConsidered.findUnique({ where: { record_id } });
      if (existing) { result.considered.skipped++; continue; }

      try {
        const outcome = inferConsideredOutcome(snap, intent.wait_watch_until as Date | null);
        if (!dryRun) {
          await recordConsidered(intent.id, intent.ticker, snap, outcome, intent.created_date);
        }
        result.considered.created++;
      } catch (err: any) {
        result.errors.push(`considered ${intent.ticker} (${intent.id.slice(0, 8)}): ${err.message}`);
      }
    }
  }

  console.log(
    `[Backfill] ${dryRun ? 'DRY RUN ' : ''}` +
    `trades: ${result.trades.created} created, ${result.trades.skipped} skipped | ` +
    `considered: ${result.considered.created} created, ${result.considered.skipped} skipped | ` +
    `errors: ${result.errors.length}`
  );

  return result;
}
