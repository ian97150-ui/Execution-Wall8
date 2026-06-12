import { Router, Request, Response } from 'express';
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { prisma } from '../index';
import path from 'path';
import fs from 'fs';
import os from 'os';

const router = Router();

const PYTHON_DIR        = path.join(__dirname, '../../..', 'python');
const SCRIPT_PATH       = path.join(PYTHON_DIR, 'cat5ive_sim.py');
const CLASSIFIER_PATH   = path.join(PYTHON_DIR, 'cat5ive_classifier.py');
const MERGER_PATH       = path.join(PYTHON_DIR, 'csv_merger.py');
const LOCAL_CSV         = path.join(PYTHON_DIR, 'market_conditions.csv');

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

  const scriptExists = fs.existsSync(SCRIPT_PATH);
  let dbCount = -1;
  try { dbCount = await prisma.simTicker.count(); } catch {}

  res.json({
    python_bin:    PYTHON_BIN,
    python_version: pyVersion,
    script_path:   SCRIPT_PATH,
    script_exists: scriptExists,
    python_dir:    PYTHON_DIR,
    db_rows:       dbCount,
    __dirname:     __dirname,
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

function mergeCSV(appCsvPath: string): string {
  const mergedPath = path.join(os.tmpdir(), `cat5_merged_${Date.now()}.csv`);
  if (!fs.existsSync(MERGER_PATH) || !fs.existsSync(LOCAL_CSV)) return appCsvPath;
  const r = spawnSync(PYTHON_BIN, [MERGER_PATH, '--merge', '--app', appCsvPath, '--local', LOCAL_CSV, '--output', mergedPath], {
    timeout: 30000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  if (r.status !== 0 || !fs.existsSync(mergedPath)) return appCsvPath;
  return mergedPath;
}

async function writeCSVFromDB(csvPath: string): Promise<void> {
  const tickers = await prisma.simTicker.findMany({ orderBy: { created_at: 'asc' } });
  if (!tickers.length) {
    fs.writeFileSync(csvPath, 'ticker,spike_date\n');
    return;
  }
  const rows = tickers.map(t => JSON.parse(t.csv_fields) as Record<string, string>);
  const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const lines = [
    keys.join(','),
    ...rows.map(r =>
      keys.map(k => {
        const v = String(r[k] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')
    ),
  ];
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
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
  const cleanup = (csvPath?: string) => {
    if (streamDone) return;
    streamDone = true;
    clearInterval(keepalive);
    if (csvPath) try { fs.unlinkSync(csvPath); } catch {}
  };
  const finish = (csvPath: string | undefined, code: number) => {
    if (streamDone) return;
    cleanup(csvPath);
    res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
    res.end();
  };

  const csvPath = path.join(os.tmpdir(), `sim_run_${Date.now()}.csv`);
  try {
    await writeCSVFromDB(csvPath);
  } catch (e) {
    res.write(`data: ${JSON.stringify('[error] failed to write CSV: ' + String(e))}\n\n`);
    finish(csvPath, 1);
    return;
  }

  // cmd=test: verify SSE works without Python
  if (cmd === 'test') {
    res.write(`data: ${JSON.stringify('SSE connection OK')}\n\n`);
    res.write(`data: ${JSON.stringify(`python_bin: ${PYTHON_BIN}`)}\n\n`);
    res.write(`data: ${JSON.stringify(`script: ${SCRIPT_PATH} (exists: ${fs.existsSync(SCRIPT_PATH)})`)}\n\n`);
    finish('', 0);
    return;
  }

  // Merge app CSV with market_conditions.csv to supply all W1 scoring fields
  const simCsvPath = mergeCSV(csvPath);
  const cleanup2 = () => { if (simCsvPath !== csvPath) try { fs.unlinkSync(simCsvPath); } catch {} };

  // classify command runs cat5ive_classifier.py directly (not cat5ive_sim.py)
  if (cmd === 'classify') {
    if (!ticker || !date) {
      res.write(`data: ${JSON.stringify('[error] ticker and date required for classify')}\n\n`);
      finish(csvPath, 1); return;
    }
    const classArgs = [CLASSIFIER_PATH, ticker.toUpperCase(), '--date', date, '--once'];
    const tradierKey2 = process.env.TRADIER_API_KEY;
    res.write(`data: ${JSON.stringify(`> python3 cat5ive_classifier.py ${ticker.toUpperCase()} --date ${date} --once`)}\n\n`);
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
      finish(csvPath, code ?? 0);
    });
    proc2.on('error', (err) => { res.write(`data: ${JSON.stringify(`[error] ${err.message}`)}\n\n`); finish(csvPath, -1); });
    req.on('close', () => { if (!streamDone) { proc2.kill(); cleanup(csvPath); } });
    return;
  }

  let args: string[] = [SCRIPT_PATH];
  switch (cmd) {
    case 'flips':
      if (!ticker || !date) {
        res.write(`data: ${JSON.stringify('[error] ticker and date required for flips')}\n\n`);
        cleanup2(); finish(csvPath, 1); return;
      }
      args.push('--flips', ticker.toUpperCase(), date, '--csv', simCsvPath);
      break;
    case 'flips-all':
      args.push('--flips', '--csv', simCsvPath);
      break;
    case 'replay':
      if (!ticker || !date) {
        res.write(`data: ${JSON.stringify('[error] ticker and date required for replay')}\n\n`);
        cleanup2(); finish(csvPath, 1); return;
      }
      args.push('--replay', ticker.toUpperCase(), date, '--no-interactive', '--csv', simCsvPath);
      break;
    case 'patterns':
      args.push('--patterns', '--csv', simCsvPath);
      break;
    case 'backtest':
      args.push('--backtest', '--csv', simCsvPath);
      break;
    default:
      cleanup2(); finish(csvPath, 0); return;
  }

  const tradierKey = process.env.TRADIER_API_KEY;
  if (tradierKey) args.push('--tradier-key', tradierKey);

  // Log what we're running so errors are diagnosable
  res.write(`data: ${JSON.stringify(`> python3 ${args.slice(1).join(' ')}`)}\n\n`);

  const proc = spawn(PYTHON_BIN, args, {
    cwd: path.join(__dirname, '../../..'),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  const deco = new StringDecoder('utf8');
  const dece = new StringDecoder('utf8');

  const send = (text: string) => {
    if (streamDone) return;
    res.write(`data: ${JSON.stringify(stripAnsi(text))}\n\n`);
  };

  proc.stdout?.on('data', (c: Buffer) => send(deco.write(c)));
  proc.stderr?.on('data', (c: Buffer) => send(dece.write(c)));

  proc.on('close', (code: number | null) => {
    const tailo = deco.end(); if (tailo) send(tailo);
    const taile = dece.end(); if (taile) send(taile);
    cleanup2();
    finish(csvPath, code ?? 0);
  });

  proc.on('error', (err: Error) => {
    send(`[error] failed to run python3: ${err.message}\nMake sure python3 is installed and cat5ive_sim.py is at ${SCRIPT_PATH}`);
    cleanup2();
    finish(csvPath, -1);
  });

  req.on('close', () => {
    if (!streamDone) { proc.kill(); cleanup2(); cleanup(csvPath); }
  });
});

export default router;
