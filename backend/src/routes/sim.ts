import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { prisma } from '../index';
import path from 'path';
import fs from 'fs';

const router = Router();

const PYTHON_DIR  = path.join(__dirname, '../../..', 'python');
const SCRIPT_PATH = path.join(PYTHON_DIR, 'cat5ive_sim.py');

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[mGKHJ]/g, '');
}

async function writeCSVFromDB(csvPath: string): Promise<void> {
  const tickers = await prisma.simTicker.findMany({ orderBy: { created_at: 'asc' } });
  if (!tickers.length) {
    fs.writeFileSync(csvPath, 'ticker,spike_date,csv_fields\n');
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const csvPath = `/tmp/sim_run_${Date.now()}.csv`;
  try {
    await writeCSVFromDB(csvPath);
  } catch (e) {
    res.write(`data: ${JSON.stringify('[error] failed to write CSV')}\n\n`);
    res.end();
    return;
  }

  let args: string[] = [SCRIPT_PATH];
  switch (cmd) {
    case 'flips':
      if (!ticker || !date) {
        res.write(`data: ${JSON.stringify('[error] ticker and date required for flips')}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ code: 1 })}\n\n`);
        res.end(); return;
      }
      args.push('--flips', ticker.toUpperCase(), date, '--csv', csvPath);
      break;
    case 'flips-all':
      args.push('--flips', '--csv', csvPath);
      break;
    case 'replay':
      if (!ticker || !date) {
        res.write(`data: ${JSON.stringify('[error] ticker and date required for replay')}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ code: 1 })}\n\n`);
        res.end(); return;
      }
      args.push('--replay', ticker.toUpperCase(), date, '--no-interactive', '--csv', csvPath);
      break;
    case 'patterns':
      args.push('--patterns', '--csv', csvPath);
      break;
    case 'backtest':
      args.push('--backtest', '--csv', csvPath);
      break;
    default:
      res.write(`event: done\ndata: ${JSON.stringify({ code: 0 })}\n\n`);
      res.end();
      try { fs.unlinkSync(csvPath); } catch {}
      return;
  }

  const polygonKey = process.env.POLYGON_API_KEY;
  if (polygonKey) args.push('--polygon-key', polygonKey);

  const proc = spawn('python3', args, { cwd: path.join(__dirname, '../../..') });

  const send = (text: string) => {
    const clean = stripAnsi(text);
    if (clean.trim()) res.write(`data: ${JSON.stringify(clean)}\n\n`);
  };

  proc.stdout.on('data', (c: Buffer) => send(c.toString()));
  proc.stderr.on('data', (c: Buffer) => send('[err] ' + c.toString()));

  proc.on('close', (code: number) => {
    try { fs.unlinkSync(csvPath); } catch {}
    res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
    res.end();
  });

  proc.on('error', (err: Error) => {
    try { fs.unlinkSync(csvPath); } catch {}
    send(`[proc error] ${err.message}`);
    res.write(`event: done\ndata: ${JSON.stringify({ code: -1 })}\n\n`);
    res.end();
  });

  req.on('close', () => {
    proc.kill();
    try { fs.unlinkSync(csvPath); } catch {}
  });
});

export default router;
