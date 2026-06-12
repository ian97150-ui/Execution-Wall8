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

export default router;
