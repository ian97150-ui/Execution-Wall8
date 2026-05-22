import { prisma } from '../index';
import type { ScoreSnapshot } from './scoringEngineService';

const ET_OFFSET_MS = -4 * 60 * 60 * 1000;

export async function recordConsidered(
  intentId: string,
  ticker: string,
  snap: ScoreSnapshot,
  outcome: 'NOT_ELIGIBLE' | 'NEVER_UPGRADED',
  capturedAt?: Date
): Promise<void> {
  const now    = capturedAt ?? new Date();
  const etDate = new Date(now.getTime() + ET_OFFSET_MS);
  const date   = etDate.toISOString().slice(0, 10);
  const time   = etDate.toISOString().slice(11, 16);

  // Deterministic key — one record per intent, upserted so repeated poll ticks don't duplicate
  const record_id = `${ticker}_${date.replace(/-/g, '')}_WAIT_${intentId.slice(0, 8)}`;

  const record = {
    record_id,
    ticker,
    date,
    time,
    outcome,
    peak_quality:        snap.pre_fall_score   ?? 0,
    peak_signal:         (snap as any).raw_signal ?? 'WAIT',
    peak_gates:          snap.gates_passed     ?? 0,
    peak_confidence:     snap.confidence       ?? 0,
    blocking_conditions: snap.disqualifiers    ?? [],
    t2_entry_type:       snap.t2_entry_type    ?? null,
  };

  await prisma.liveConsidered.upsert({
    where:  { record_id },
    update: { outcome, record_json: JSON.stringify(record) },
    create: {
      record_id,
      ticker,
      date,
      outcome,
      record_json: JSON.stringify(record),
      captured_at: now,
    },
  });

  console.log(
    `[LiveConsidered] ${outcome} ${ticker} ` +
    `(gates ${record.peak_gates}/5, conf ${Math.round(record.peak_confidence * 100)}%, ` +
    `t2=${record.t2_entry_type ?? 'N/A'}, dqs=${record.blocking_conditions.length})`
  );
}

export async function getLiveConsideredForDate(date: string): Promise<object[]> {
  const rows = await prisma.liveConsidered.findMany({
    where:   { date },
    orderBy: { captured_at: 'asc' },
  });
  return rows.map(r => JSON.parse(r.record_json));
}
