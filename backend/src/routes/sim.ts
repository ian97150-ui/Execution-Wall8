import { Router, Request, Response } from 'express';
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { prisma } from '../index';
import path from 'path';
import fs from 'fs';

const router = Router();

const PYTHON_DIR      = path.join(__dirname, '../../..', 'python');
const CLASSIFIER_PATH    = path.join(PYTHON_DIR, 'cat5ive_classifier.py');
const CLASSIFIER_V4_PATH = path.join(PYTHON_DIR, 'cat5ive_classifier_v4.py');

// Resolve python binary: try python3, fall back to python
function getPythonBin(): string {
  try {
    const r = spawnSync('python3', ['--version'], { timeout: 3000 });
    if (r.status === 0) return 'python3';
  } catch {}
  try {
    const r = spawnSync('python', ['--version'], { timeout: 3000 });
    if (r.status === 0) return 'python';
  } catch {}
  return 'python3'; // fallback — error will surface in terminal
}
const PYTHON_BIN = getPythonBin();

// GET /api/sim/health — diagnostic endpoint
router.get('/health', async (_req: Request, res: Response) => {
  const pyVersion = (() => {
    try {
      const r = spawnSync(PYTHON_BIN, ['--version'], { timeout: 3000 });
      return r.status === 0
        ? (r.stdout?.toString().trim() || r.stderr?.toString().trim())
        : `exit ${r.status}: ${r.stderr?.toString().trim()}`;
    } catch (e) { return `error: ${String(e)}`; }
  })();

  const classifierExists   = fs.existsSync(CLASSIFIER_PATH);
  const classifierV4Exists = fs.existsSync(CLASSIFIER_V4_PATH);
  let dbCount = -1;
  try { dbCount = await prisma.simTicker.count(); } catch {}

  res.json({
    python_bin:            PYTHON_BIN,
    python_version:        pyVersion,
    classifier_path:       CLASSIFIER_PATH,
    classifier_exists:     classifierExists,
    classifier_v4_path:    CLASSIFIER_V4_PATH,
    classifier_v4_exists:  classifierV4Exists,
    python_dir:            PYTHON_DIR,
    db_rows:               dbCount,
    __dirname:             __dirname,
  });
});

function stripAnsi(str: string): string {
  return str
    .replace(/﻿/g, '')                                // strip BOM
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')            // strip ANSI escape sequences (colors, cursor)
    .replace(/\x1b[^[]/g, '')                          // strip other ESC sequences (e.g. ESC=, ESC>)
    // Normalize common Unicode output chars to readable ASCII
    .replace(/[═╒╕╘╛╞╡╤╧╪]/g, '=')                   // double-line box chars → =
    .replace(/[─━┄┅┈┉┼┤├┬┴┼╫╪]/g, '-')               // single-line horizontal box chars → -
    .replace(/[│┃┆┇┊┋]/g, '|')                        // vertical box chars → |
    .replace(/[╔╗╚╝╠╣╦╩╬]/g, '+')                    // corner box chars → +
    .replace(/→/g, '->')                               // rightwards arrow
    .replace(/←/g, '<-')                               // leftwards arrow
    .replace(/↑/g, '^')                                // upwards arrow
    .replace(/↓/g, 'v')                                // downwards arrow
    .replace(/✓/g, 'Y')                                // check mark
    .replace(/✗/g, 'N')                                // ballot x
    .replace(/⚠/g, '!')                               // warning sign (traj/warnings row)
    .replace(/Δ/g, 'D')                               // delta (score trajectory delta)
    .replace(/—/g, '-')                                // em dash
    .replace(/–/g, '-')                                // en dash
    .replace(/•/g, '*')                                // bullet
    .replace(/△/g, '^')                                // triangle
    .replace(/▼/g, 'v')                               // inverted triangle
    .replace(/[^\x00-\x7F]/g, '');                    // strip any remaining non-ASCII (garbled UTF-8 bytes)
}


// GET /api/sim/tickers
router.get('/tickers', async (_req: Request, res: Response) => {
  try {
    const tickers = await prisma.simTicker.findMany({ orderBy: { created_at: 'asc' } });
    res.json(tickers.map(t => ({
      id:         t.id,
      ticker:     t.ticker,
      spike_date: t.spike_date,
      fields:     JSON.parse(t.csv_fields),
    })));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /api/sim/tickers/:ticker/:date
router.delete('/tickers/:ticker/:date', async (req: Request, res: Response) => {
  const { ticker, date } = req.params as { ticker: string; date: string };
  try {
    await prisma.simTicker.deleteMany({
      where: { ticker: ticker.toUpperCase(), spike_date: date },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/sim/tickers  { ticker, date }
// Saves ticker+date directly to DB. Bars are fetched live when running commands.
router.post('/tickers', async (req: Request, res: Response) => {
  const { ticker, date } = req.body as { ticker?: string; date?: string };
  if (!ticker || !date) {
    return res.status(400).json({ error: 'ticker and date required' });
  }

  // Basic date validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const t = ticker.trim().toUpperCase();

  try {
    await prisma.simTicker.upsert({
      where:  { ticker_spike_date: { ticker: t, spike_date: date } },
      create: { ticker: t, spike_date: date, csv_fields: JSON.stringify({ ticker: t, spike_date: date }) },
      update: {},  // don't overwrite existing enriched data
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[sim] add ticker error', e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/sim/run?cmd=flips&ticker=SKYQ&date=2026-04-13  (SSE stream)
router.get('/run', async (req: Request, res: Response) => {
  const { cmd, ticker, date } = req.query as Record<string, string>;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/Railway proxy buffering
  res.flushHeaders();

  // Keepalive: send a comment line every 15s so Railway doesn't close idle connections
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  // Guard against writing after the stream is done (proc error + close both fire)
  let streamDone = false;
  const cleanup = () => {
    if (streamDone) return;
    streamDone = true;
    clearInterval(keepalive);
  };
  const finish = (_: undefined, code: number) => {
    if (streamDone) return;
    cleanup();
    res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
    res.end();
  };

  // cmd=test: verify SSE works without Python
  if (cmd === 'test') {
    res.write(`data: ${JSON.stringify('SSE connection OK')}\n\n`);
    res.write(`data: ${JSON.stringify(`python_bin: ${PYTHON_BIN}`)}\n\n`);
    res.write(`data: ${JSON.stringify(`classifier: ${CLASSIFIER_PATH} (exists: ${fs.existsSync(CLASSIFIER_PATH)})`)}\n\n`);
    finish(undefined, 0);
    return;
  }

  // classify command runs cat5ive_classifier.py directly
  if (cmd === 'classify') {
    if (!ticker || !date) {
      res.write(`data: ${JSON.stringify('[error] ticker and date required for classify')}\n\n`);
      finish(undefined, 1); return;
    }
    // Support space-separated multiple tickers (batch mode)
    const tickerList = (ticker as string).trim().split(/\s+/).map(t => t.toUpperCase()).filter(Boolean);
    // Use v4 — auto-fetches Tradier tick layer when TRADIER_API_KEY is present.
    // --tick-only-once: prefetch all PM ticks before classification (one call per ticker).
    const useV4 = fs.existsSync(CLASSIFIER_V4_PATH);
    const classifierScript = useV4 ? CLASSIFIER_V4_PATH : CLASSIFIER_PATH;
    const classArgs = [classifierScript, ...tickerList, '--date', date, '--once', '--no-float'];
    if (useV4) classArgs.push('--tick-only-once');
    if (req.query.highValueOnly === 'true') classArgs.push('--high-value-only');
    if (req.query.noSec === 'true') classArgs.push('--no-sec');
    if (req.query.time) classArgs.push('--time', req.query.time as string);
    const tradierKey2 = process.env.TRADIER_API_KEY;
    const scriptLabel = useV4 ? 'cat5ive_classifier_v4.py' : 'cat5ive_classifier.py';
    res.write(`data: ${JSON.stringify(`> python3 ${scriptLabel} ${classArgs.slice(1).join(' ')}`)}\n\n`);
    const proc2 = spawn(PYTHON_BIN, classArgs, {
      cwd: path.join(__dirname, '../../..'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
             ...(tradierKey2 ? { TRADIER_API_KEY: tradierKey2 } : {}) },
    });
    const dec2o = new StringDecoder('utf8');
    const dec2e = new StringDecoder('utf8');
    proc2.stdout?.on('data', (c: Buffer) => { if (!streamDone) res.write(`data: ${JSON.stringify(stripAnsi(dec2o.write(c)))}\n\n`); });
    proc2.stderr?.on('data', (c: Buffer) => { if (!streamDone) res.write(`data: ${JSON.stringify(stripAnsi(dec2e.write(c)))}\n\n`); });
    proc2.on('close', (code) => {
      const tail2o = dec2o.end(); if (tail2o && !streamDone) res.write(`data: ${JSON.stringify(stripAnsi(tail2o))}\n\n`);
      const tail2e = dec2e.end(); if (tail2e && !streamDone) res.write(`data: ${JSON.stringify(stripAnsi(tail2e))}\n\n`);
      finish(undefined, code ?? 0);
    });
    proc2.on('error', (err) => { res.write(`data: ${JSON.stringify(`[error] ${err.message}`)}\n\n`); finish(undefined, -1); });
    req.on('close', () => { if (!streamDone) { proc2.kill(); cleanup(); } });
    return;
  }

  // Unknown cmd — nothing to run
  finish(undefined, 0);
});

// ─── Mode V Gates Test ────────────────────────────────────────────────────────
// GET /api/sim/signal-stack-report?ticker=MULN&date=2024-01-15[&time=HH:MM]
// Runs the v4 classifier on a single ticker+date, computes the 8-signal auto
// stack, and streams a single row result.
// Optional ?time=HH:MM truncates bars to that snapshot point (same as Classify).
// Final event: summary stats { total, by_count, would_exec_n }

function computeAutoStack(sig: Record<string, unknown>): { count: number; signals: string[] } {
  const active: string[] = [];
  if (((sig.vol_above_vwap_pct   as number) ?? 100)  < 40)  active.push('VOL_LT40');
  if (((sig.hod_set_pct          as number) ?? 100)  < 30)  active.push('HOD_LT30');
  if (sig.quiet_dump_proxy       === true)                   active.push('QUIET_DUMP');
  if (((sig.session_low_vs_pm_open as number) ?? 0)  >= 20) active.push('DEEP_LOD');
  if (sig.entry_c_fired          === true)                   active.push('ENTRY_C');
  if (((sig.wc_score             as number) ?? 0)    >= 4)  active.push('WC_GTE4');

  const tf = (sig.tick_features as Record<string, unknown>) ?? {};
  if (tf.ticks_available === true) {
    const rate = (tf.tick_rate_pm as number) ?? 0;
    if (rate >= 50 && rate <= 150) active.push('TICK_ACTIVE');
    if (((tf.buy_pressure_pct as number) ?? 100) < 35) active.push('SELL_DOM');
  }
  return { count: active.length, signals: active };
}

router.get('/signal-stack-report', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  const send = (type: string, data: unknown) => {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const ticker   = (req.query.ticker as string | undefined)?.trim().toUpperCase();
  const date     = (req.query.date   as string | undefined)?.trim();
  const snapTime = (req.query.time   as string | undefined)?.trim();

  if (!ticker || !date) {
    send('error', { message: 'ticker and date query params are required' });
    clearInterval(keepalive);
    try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
    return;
  }

  try {
    const label = snapTime ? `${ticker} ${date} @ ${snapTime}` : `${ticker} ${date}`;
    send('progress', { message: `Running Mode V Gates Test — ${label}` });

    if (!fs.existsSync(CLASSIFIER_V4_PATH)) {
      send('error', { message: 'cat5ive_classifier_v4.py not found' });
      clearInterval(keepalive);
      try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
      return;
    }

    const tradierKey = process.env.TRADIER_API_KEY;

    const args = [
      CLASSIFIER_V4_PATH, ticker,
      '--date', date,
      '--json', '--once', '--no-float', '--tick-only-once',
    ];
    if (snapTime) args.push('--time', snapTime);

    const output = await new Promise<string>((resolve) => {
      let buf = '';
      const proc = spawn(PYTHON_BIN, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
               ...(tradierKey ? { TRADIER_API_KEY: tradierKey } : {}) },
      });
      proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => resolve(buf));
      setTimeout(() => { proc.kill(); resolve(buf); }, 90_000);
    });

    const jsonLine = output.trim().split('\n').reverse().find((l: string) => l.trimStart().startsWith('{'));
    if (!jsonLine) {
      send('row', { ticker, date, snap_time: snapTime ?? null, error: 'no classifier output' });
    } else {
      const sig = JSON.parse(jsonLine) as Record<string, unknown>;
      const { count, signals } = computeAutoStack(sig);
      const ohlcv_count = signals.filter(s => !['TICK_ACTIVE','SELL_DOM'].includes(s)).length;
      const tick_count  = signals.filter(s =>  ['TICK_ACTIVE','SELL_DOM'].includes(s)).length;
      const tf = (sig.tick_features as Record<string, unknown>) ?? {};
      const ticks_avail = tf.ticks_available === true;
      const would_exec  = ticks_avail && count >= 7
        && (sig.section === 'S1')
        && (((sig.confidence_norm as number) ?? 0) >= 0.55)
        && (((sig.disqualifiers as string[])?.length) ?? 0) === 0;

      const row = {
        ticker,
        date,
        snap_time:         snapTime ?? null,
        signal_count:      count,
        signals,
        ohlcv_count,
        tick_count,
        would_exec,
        wc_tier:           (sig.wc_tier as string) ?? 'N/A',
        classifier_signal: (sig.signal  as string) ?? 'N/A',
        confidence:        Math.round(((sig.confidence_norm as number) ?? 0) * 100),
      };
      send('row', row);
      send('summary', {
        total:        1,
        would_exec_n: would_exec ? 1 : 0,
        by_count:     { [count]: 1 },
      });
    }
  } catch (err) {
    send('error', { message: String(err) });
  }

  clearInterval(keepalive);
  try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
});

// ─── Mode V Notify Threshold Scanner ─────────────────────────────────────────
// GET /api/sim/notify-scan?ticker=MULN&date=2024-01-15
// Scans bar-by-bar from 09:31 in 5-min steps, finds the first bar where the
// Mode V notify threshold would have been crossed with current DB settings.

router.get('/notify-scan', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  const send = (type: string, data: unknown) => {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const ticker = (req.query.ticker as string | undefined)?.trim().toUpperCase();
  const date   = (req.query.date   as string | undefined)?.trim();

  if (!ticker || !date) {
    send('error', { message: 'ticker and date query params are required' });
    clearInterval(keepalive);
    try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
    return;
  }

  if (!fs.existsSync(CLASSIFIER_V4_PATH)) {
    send('error', { message: 'cat5ive_classifier_v4.py not found' });
    clearInterval(keepalive);
    try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
    return;
  }

  // Load notify threshold settings from DB (fall back to defaults)
  let notifySettings = { mode_v_notify_min_signals: 3, mode_v_notify_min_conf: 45, mode_v_notify_s2_min_signals: 4 };
  try {
    const dbSettings = await prisma.executionSettings.findFirst();
    if (dbSettings) {
      notifySettings = {
        mode_v_notify_min_signals:    (dbSettings as any).mode_v_notify_min_signals    ?? 3,
        mode_v_notify_min_conf:       (dbSettings as any).mode_v_notify_min_conf       ?? 45,
        mode_v_notify_s2_min_signals: (dbSettings as any).mode_v_notify_s2_min_signals ?? 4,
      };
    }
  } catch {}

  const tradierKey = process.env.TRADIER_API_KEY;
  const minConf    = notifySettings.mode_v_notify_min_conf / 100;

  // Build list of bar times: 09:31 to 16:00 in 5-minute steps
  const times: string[] = [];
  for (let h = 9; h <= 16; h++) {
    const startMin = h === 9 ? 31 : 0;
    const endMin   = h === 16 ? 1 : 60; // only 16:00
    for (let m = startMin; m < endMin; m += 5) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }

  let firstCrossing: string | null = null;
  let barsCanned = 0;
  let aborted = false;
  req.on('close', () => { aborted = true; });

  for (const snapTime of times) {
    if (aborted) break;

    send('progress', { message: `Scanning ${ticker} @ ${snapTime}…` });

    const args = [
      CLASSIFIER_V4_PATH, ticker,
      '--date', date,
      '--time', snapTime,
      '--json', '--once', '--no-float', '--tick-only-once',
    ];

    const output = await new Promise<string>((resolve) => {
      let buf = '';
      const proc = spawn(PYTHON_BIN, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
               ...(tradierKey ? { TRADIER_API_KEY: tradierKey } : {}) },
      });
      proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => resolve(buf));
      setTimeout(() => { proc.kill(); resolve(buf); }, 30_000);
    });

    barsCanned++;

    const jsonLine = output.trim().split('\n').reverse().find((l: string) => l.trimStart().startsWith('{'));
    if (!jsonLine) continue;

    let sig: Record<string, unknown>;
    try { sig = JSON.parse(jsonLine); } catch { continue; }

    const { count, signals } = computeAutoStack(sig);
    const section    = (sig.section    as string) ?? '';
    const confidence = (sig.confidence_norm as number) ?? 0;
    const disq       = (sig.disqualifiers  as string[]) ?? [];

    // Evaluate notify threshold using DB settings
    const minSignals = section === 'S2'
      ? notifySettings.mode_v_notify_s2_min_signals
      : notifySettings.mode_v_notify_min_signals;
    const wouldNotify = disq.length === 0
      && (section === 'S1' || section === 'S2')
      && confidence >= minConf
      && count >= minSignals;

    const barEvent = {
      time:             snapTime,
      signal_count:     count,
      signals,
      confidence:       Math.round(confidence * 100),
      section,
      classifier_signal: (sig.signal as string) ?? 'N/A',
      would_notify:     wouldNotify,
    };

    send('bar', barEvent);

    if (wouldNotify && !firstCrossing) {
      firstCrossing = snapTime;
      send('crossing', barEvent);
      break;
    }
  }

  send('done', { first_crossing: firstCrossing, bars_scanned: barsCanned });
  clearInterval(keepalive);
  try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
});

export default router;
