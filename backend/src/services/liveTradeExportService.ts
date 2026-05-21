import { prisma } from '../index';
import type { ClassifierSignal } from './classifierService';

const ET_OFFSET_MS = -4 * 60 * 60 * 1000; // EDT -4h (intraday market hours)

function signalToStrategy(cls: ClassifierSignal): string {
  if (cls.signal === 'ENTER_A')  return 'A';
  if (cls.signal === 'LONG_OPP') return 'LONG';
  return cls.strategy ?? 'E';
}

function computeFlags(cls: ClassifierSignal, capturedAt: Date) {
  const etDate = new Date(capturedAt.getTime() + ET_OFFSET_MS);
  const etHour = etDate.getUTCHours();

  let lagMinutes = 0;
  const lastBarTime = cls.last_bar_time ?? '';
  if (lastBarTime) {
    const [hh, mm] = lastBarTime.split(':').map(Number);
    if (!isNaN(hh) && !isNaN(mm)) {
      const barUtcMs = Date.UTC(
        etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(), hh, mm
      ) - ET_OFFSET_MS;
      lagMinutes = (capturedAt.getTime() - barUtcMs) / 60_000;
    }
  }

  const dead_zone_entry         = cls.entry_zone === 'DEAD_ZONE';
  const sec_heavy               = (cls.sec_score_boost ?? 0) > 30;
  const sec_cache_stale         = (cls.sec_cache_age_hrs ?? 0) > 12;
  const data_lag                = lagMinutes > 3;
  const pre_market_early        = etHour < 4;
  const regime_likely_changing  =
    cls.regime === 'NEWS_CONTINUATION' &&
    cls.sec_available === true &&
    cls.sec_days_424b5 != null &&
    cls.sec_days_424b5 <= 30;
  const chop_override           = cls.chop >= 80 && cls.chop < 90 && cls.score >= 75 && cls.flips_rth <= 3;
  const velocity_unknown        = cls.velocity === 'UNKNOWN';

  const warnings: string[] = [];
  if (dead_zone_entry && sec_heavy)          warnings.push('DEAD_ZONE_SEC_HEAVY');
  if (regime_likely_changing)                warnings.push('REGIME_UNCONFIRMED');
  if ((cls.gates_passed ?? 5) < 5 && cls.score > 75) warnings.push('LOW_GATES_HIGH_SCORE');
  if (data_lag)                              warnings.push('DATA_LAG_DETECTED');
  if (sec_cache_stale)                       warnings.push('SEC_CACHE_STALE');
  if (pre_market_early)                      warnings.push('EARLY_SESSION');
  if (chop_override)                         warnings.push('CHOP_OVERRIDE');
  if (velocity_unknown)                      warnings.push('VELOCITY_UNKNOWN');

  return {
    data_lag, sec_cache_stale, sec_heavy, pre_market_early,
    regime_likely_changing, dead_zone_entry, chop_override, velocity_unknown, warnings,
  };
}

function buildRecord(cls: ClassifierSignal, capturedAt: Date, intentId: string | null) {
  const etDate   = new Date(capturedAt.getTime() + ET_OFFSET_MS);
  const date     = etDate.toISOString().slice(0, 10);
  const timeHHMM = etDate.toISOString().slice(11, 16);
  const strategy = signalToStrategy(cls);
  const record_id = `${cls.ticker}_${date.replace(/-/g, '')}_${strategy}_` +
    capturedAt.toISOString().slice(11, 23).replace(/[:.]/g, '');
  const captured_at = capturedAt.toISOString().replace('Z', '-04:00');

  return {
    record_id,
    ticker:      cls.ticker,
    date,
    time:        timeHHMM,
    strategy,
    signal:      cls.signal,
    t2_entry_type: cls.t2_entry_type ?? null,
    price:       cls.price,
    captured_at,
    gates: {
      passed:        cls.gates_passed  ?? 0,
      bias:          cls.bias          ?? 'NO_CONVICTION',
      disqualifiers: cls.disqualifiers ?? [],
      detail:        cls.gate_detail   ?? [],
    },
    snapshot: {
      score_raw:           cls.score_raw ?? cls.score,
      score_final:         cls.score,
      sec_score_boost:     cls.sec_score_boost   ?? 0,
      tier:                cls.tier,
      section:             cls.section,
      confidence_norm:     cls.confidence_norm   ?? (cls.confidence / 100),
      regime_at_capture:   cls.regime,
      velocity:            cls.velocity,
      flips:               cls.flips_rth,
      chop:                cls.chop,
      hod:                 cls.hod,
      pct_from_hod:        cls.pct_from_hod,
      entry_zone:          cls.entry_zone,
      active_signals:      cls.active_signals,
      last_bar_time:       cls.last_bar_time      ?? null,
      sec_available:       cls.sec_available,
      sec_days_424b5:      cls.sec_days_424b5,
      sec_cache_age_hours: cls.sec_cache_age_hrs  ?? null,
      signal_tier:         cls.signal_tier         ?? null,
      hod_bars_ago:        cls.hod_bars_ago         ?? null,
    },
    flags: computeFlags(cls, capturedAt),
    backtest_entry: {
      strategy_e_time:    strategy === 'E' ? timeHHMM : null,
      strategy_a_time:    strategy === 'A' ? timeHHMM : null,
      strategy_b_time:    strategy === 'B' ? timeHHMM : null,
      manually_overridden: false,
    },
  };
}

export async function captureSignal(cls: ClassifierSignal, intentId: string | null): Promise<void> {
  const capturedAt = new Date();
  const record     = buildRecord(cls, capturedAt, intentId);

  await prisma.liveTrade.upsert({
    where:  { record_id: record.record_id },
    update: { record_json: JSON.stringify(record) },
    create: {
      record_id:   record.record_id,
      ticker:      cls.ticker,
      date:        record.date,
      signal:      cls.signal,
      strategy:    record.strategy,
      intent_id:   intentId ?? undefined,
      record_json: JSON.stringify(record),
      captured_at: capturedAt,
    },
  });

  console.log(`[LiveTrade] captured ${record.record_id}`);
}

export async function getLiveTradesForDate(date: string): Promise<object[]> {
  const rows = await prisma.liveTrade.findMany({
    where:   { date },
    orderBy: { captured_at: 'asc' },
  });
  return rows.map(r => JSON.parse(r.record_json));
}
