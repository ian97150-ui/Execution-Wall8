import { spawn } from 'child_process';
import path from 'path';

const SCRIPT_V4 = path.join(__dirname, '../../../python/cat5ive_classifier_v4.py');
const PYTHON    = process.platform === 'win32' ? 'python' : 'python3';

export interface TickFeatures {
  ticks_available:    boolean;
  tick_count_pm?:     number;
  tick_count_rth?:    number;
  proxy_vpin?:        number;
  buy_pressure_pct?:  number;
  large_print_count?: number;
  large_print_pct?:   number;
  tick_score_delta?:  number;
  tick_notes?:        string[];
}

export interface AnalysisResult {
  signal:         string;
  ticker:         string;
  score:          number;
  tier:           string;
  bias:           string;
  confidence:     number;
  gates_passed:   number;
  gate_detail:    string[];
  disqualifiers:  string[];
  t2_entry_type?: string;
  v3_gate_notes?: string[];
  tick_features:  TickFeatures;
  [key: string]:  unknown;
}

export async function runAnalysis(
  ticker: string,
  date: string
): Promise<AnalysisResult | null> {
  return new Promise((resolve) => {
    const args: string[] = [
      SCRIPT_V4,
      ticker.toUpperCase(),
      '--json', '--once', '--no-float', '--ticks', '--tick-only-once',
      '--date', date,
    ];

    const tradierKey = process.env.TRADIER_API_KEY;
    const polygonKey = process.env.POLYGON_API_KEY;
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      ...(tradierKey ? { TRADIER_API_KEY: tradierKey } : {}),
      ...(polygonKey ? { POLYGON_API_KEY: polygonKey } : {}),
    };

    let output   = '';
    let resolved = false;
    const done = (val: AnalysisResult | null) => {
      if (!resolved) { resolved = true; resolve(val); }
    };

    const proc = spawn(PYTHON, args, { env });
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', () => {});

    proc.on('close', () => {
      const jsonLine = output.trim().split('\n').reverse().find(l => l.trimStart().startsWith('{'));
      if (!jsonLine) { done(null); return; }
      try { done(JSON.parse(jsonLine) as AnalysisResult); }
      catch { done(null); }
    });

    proc.on('error', () => done(null));

    // 5-minute timeout — tick fetch for full PM window can take 30-60s
    const timer = setTimeout(() => { proc.kill(); done(null); }, 300_000);
    proc.on('close', () => clearTimeout(timer));
  });
}
