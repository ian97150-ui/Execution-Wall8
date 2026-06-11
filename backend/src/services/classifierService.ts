import { spawn } from 'child_process';
import path from 'path';

const SCRIPT = path.join(__dirname, '../../../python/cat5ive_classifier.py');
const PYTHON  = process.platform === 'win32' ? 'python' : 'python3';

export interface ClassifierSignal {
  ticker:        string;
  timestamp:     string;
  signal:        string;   // HIGH_VALUE | ENTER_E | ENTER_A | LONG_OPP | WAIT | SKIP
  grade:         string;   // A | B | C | NONE
  strategy:      string;
  regime:        string;
  tier:          string;   // HIGH | MEDIUM | LOW | SKIP
  score:         number;   // 0-150
  section:       string;   // S1 | S2
  confidence:    number;   // 0-100
  active_signals: string[];
  signal_tier:   string;
  power_combo:   string;
  power_lift:    number;
  flips_rth:     number;
  chop:          number;
  velocity:      string;
  vpin:          string;
  price:         number;
  hod:           number;
  lod:           number;
  pct_from_hod:  number;
  entry_zone:    string;
  expected_mae:  string;
  expected_ret:  string;
  stop_pct:      string;
  quality_score: number;   // 0-100
  reasons:       string[];
  warnings:      string[];
  bar_count:     number;
  pm_bars:       number;
  rth_bars:      number;
  pm_move_pct:   number;
  pm_high:       number;
  gap_pct:       number;
  vwap:          number;
  atr:           number;
  price_vs_vwap: number;
  hod_time:      string;
  lod_time:      string;
  hod_bars_ago:  number;
  consec_s1:     number;
  s1_pct:        number;
  vol_spike:     number;
  session_pct:   number;
  all_signals:   string[];
  suggested_size: string;
  next_watch:    string;
  // SEC filing fields (from EDGAR lookup inside the classifier)
  sec_available:      boolean;
  sec_days_424b5:     number;
  sec_offerings_12m:  number;
  sec_score_boost:    number;
  sec_regime_changed: boolean;
  // App integration fields — populated by evaluate_gates() in the classifier
  disqualifiers:   string[];   // structural gate blockers, e.g. ['CHOP_EXTREME:93pct']
  bias:            string;     // MAX_CONVICTION | HIGH_CONVICTION | LOW_CONVICTION | NO_CONVICTION
  confidence_norm: number;     // confidence / 100, 0.0–1.0
  pre_fall_tier:   string;     // alias for tier: HIGH | MEDIUM | LOW | SKIP
  gates_passed:    number;     // 0–5
  gate_detail:     string[];   // per-gate pass/fail strings
  // Optional fields used by live trade capture (may be absent on older classifier versions)
  score_raw?:         number;   // pre-SEC-boost score; falls back to score if absent
  last_bar_time?:     string;   // HH:MM of newest bar processed
  sec_cache_age_hrs?: number;   // hours since EDGAR cache last refreshed
  t2_entry_type?:     string;   // ON_TIME | SLIGHTLY_EARLY | EARLY | VERY_EARLY | PREMATURE_RISK | NOT_QUALIFIED
  // v3 new fields
  vol_above_vwap_pct:     number;
  intraday_gain_pct:      number;
  intraday_gain_bucket:   string;   // SUB10 | 10-20pct | 20-45pct | 45-70pct | SPIKE70+
  session_low_vs_pm_open: number;
  quiet_dump_proxy:       boolean;
  score_trajectory:       string;   // RISING | FLAT | FALLING
  pm_open_price:          number;
  entry_c_fired:          boolean;
  float_shares:           number;
  float_turnover_pct:     number;
  momentum_decay_rate:    number;
  hod_set_pct:            number;
  v3_gate_notes:          string[];
  // v3 gap-fill fields
  near_miss_count?:        number;
  run_day?:                number;
  price_path_efficiency?:  number;
  contested_day?:          boolean;
  margin_lean?:            number;
  score_delta_pre?:        number;
}

/**
 * Spawn cat5ive_classifier.py for a single ticker and return the parsed signal.
 * Returns null if the process fails, times out, or produces no JSON output.
 */
export async function runClassifier(
  ticker: string,
  date?: string
): Promise<ClassifierSignal | null> {
  return new Promise((resolve) => {
    const args: string[] = [SCRIPT, ticker.toUpperCase(), '--json', '--once', '--no-float'];
    if (date) args.push('--date', date);

    const tradierKey = process.env.TRADIER_API_KEY;
    const polygonKey = process.env.POLYGON_API_KEY;
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      ...(tradierKey ? { TRADIER_API_KEY: tradierKey } : {}),
      ...(polygonKey ? { POLYGON_API_KEY: polygonKey } : {}),
    };

    let output = '';
    let resolved = false;
    const done = (val: ClassifierSignal | null) => {
      if (!resolved) { resolved = true; resolve(val); }
    };

    const proc = spawn(PYTHON, args, { env });

    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', () => {});  // suppress stderr noise

    proc.on('close', () => {
      // Pick the last line that looks like a JSON object
      const jsonLine = output.trim().split('\n').reverse().find(l => l.trimStart().startsWith('{'));
      if (!jsonLine) { done(null); return; }
      try { done(JSON.parse(jsonLine) as ClassifierSignal); }
      catch { done(null); }
    });

    proc.on('error', () => done(null));

    // Hard timeout: kill process if it takes longer than 45s
    const timer = setTimeout(() => { proc.kill(); done(null); }, 45_000);
    proc.on('close', () => clearTimeout(timer));
  });
}
