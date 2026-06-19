import express, { Request, Response } from 'express';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { prisma } from '../index';

const router = express.Router();

const PYTHON_DIR = path.join(__dirname, '../../..', 'python');
const STATUS_INQUISIT_PATH = path.join(PYTHON_DIR, 'status_inquisit.py');

function getPythonBin(): string {
  try {
    const r = spawnSync('python3', ['--version'], { timeout: 3000 });
    if (r.status === 0) return 'python3';
  } catch {}
  try {
    const r = spawnSync('python', ['--version'], { timeout: 3000 });
    if (r.status === 0) return 'python';
  } catch {}
  return 'python3';
}
const PYTHON_BIN = getPythonBin();

/**
 * Helper to safely get positions without failing on missing columns
 */
async function getPositionsSafe(where: any = {}, orderBy: any = { opened_at: 'desc' }) {
  try {
    return await prisma.position.findMany({ where, orderBy });
  } catch (e: any) {
    // If column doesn't exist (schema mismatch), use raw query
    if (e.message?.includes('does not exist') || e.message?.includes('Unknown argument')) {
      console.warn('⚠️ Position query failed, using raw SQL fallback');
      try {
        // Build WHERE clause
        const conditions: string[] = [];
        if (where.ticker) conditions.push(`ticker = '${where.ticker}'`);
        if (where.closed_at === null) conditions.push('closed_at IS NULL');

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const results = await prisma.$queryRawUnsafe(`
          SELECT * FROM positions ${whereClause} ORDER BY opened_at DESC
        `) as any[];
        return results || [];
      } catch (rawError: any) {
        console.error('Raw position query also failed:', rawError.message);
        return [];
      }
    }
    throw e;
  }
}

/**
 * Normalize position data for frontend compatibility
 * Maps backend field names to what frontend expects
 */
function normalizePosition(position: any) {
  return {
    ...position,
    // Frontend expects these field names
    created_date: position.opened_at || position.created_date,
    avg_entry_price: position.entry_price || position.avg_entry_price,
    // Normalize side to lowercase for frontend
    side: position.side?.toLowerCase() || position.side,
    // TTP Exit SL threshold
    ttp_exit_price: position.ttp_exit_price != null ? Number(position.ttp_exit_price) : null,
  };
}

// Get all positions (open and closed)
router.get('/', async (req: Request, res: Response) => {
  try {
    const open_only = req.query.open_only as string | undefined;
    const ticker = req.query.ticker as string | undefined;

    const where: any = {};
    if (ticker) where.ticker = ticker;
    if (open_only === 'true') where.closed_at = null;

    const positions = await getPositionsSafe(where);

    // Normalize positions for frontend compatibility
    const normalizedPositions = positions.map(normalizePosition);

    res.json(normalizedPositions);
  } catch (error: any) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper to safely get a single position by ID
 */
async function getPositionByIdSafe(id: string) {
  try {
    return await prisma.position.findUnique({ where: { id } });
  } catch (e: any) {
    if (e.message?.includes('does not exist') || e.message?.includes('Unknown argument')) {
      console.warn('⚠️ Position findUnique failed, using raw SQL fallback');
      try {
        const results = await prisma.$queryRawUnsafe(`
          SELECT * FROM positions WHERE id = ? LIMIT 1
        `, id) as any[];
        return results[0] || null;
      } catch {
        return null;
      }
    }
    throw e;
  }
}

// Get single position
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const position = await getPositionByIdSafe(id);

    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    res.json(normalizePosition(position));
  } catch (error: any) {
    console.error('Error fetching position:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark position as flat (close it)
router.post('/:id/mark-flat', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const position = await getPositionByIdSafe(id);

    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    if (position.closed_at) {
      return res.status(400).json({ error: 'Position already closed' });
    }

    // Close the position
    const updatedPosition = await prisma.position.update({
      where: { id },
      data: { closed_at: new Date() }
    });

    // Block signals for this ticker until next day 1am (5-minute cooldown for simplicity)
    const blockUntil = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.tickerConfig.upsert({
      where: { ticker: position.ticker },
      update: { blocked_until: blockUntil },
      create: {
        ticker: position.ticker,
        enabled: true,
        blocked_until: blockUntil
      }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: 'position_closed',
        ticker: position.ticker,
        details: JSON.stringify({
          position_id: id,
          quantity: position.quantity,
          side: position.side,
          blocked_until: blockUntil.toISOString()
        })
      }
    });

    console.log(`✅ Position marked flat: ${position.ticker}`);

    res.json(normalizePosition(updatedPosition));
  } catch (error: any) {
    console.error('Error marking position flat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set or clear TTP Exit SL price threshold
// When set, EXIT webhooks with limit_price >= ttp_exit_price are blocked
// (broker stop loss already handles the close at that level)
router.post('/:id/ttp', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { price } = req.body; // number | null

    const position = await getPositionByIdSafe(id);

    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    if (position.closed_at) {
      return res.status(400).json({ error: 'Position already closed' });
    }

    const updatedPosition = await prisma.position.update({
      where: { id },
      data: { ttp_exit_price: price != null ? price : null },
    });

    await prisma.auditLog.create({
      data: {
        event_type: price != null ? 'ttp_set' : 'ttp_cleared',
        ticker: position.ticker,
        details: JSON.stringify({ ttp_exit_price: price ?? null }),
      },
    });

    console.log(`${price != null ? '🎯 TTP set' : '❌ TTP cleared'}: ${position.ticker} @ ${price ?? 'N/A'}`);

    res.json(normalizePosition(updatedPosition));
  } catch (error: any) {
    console.error('Error setting TTP exit price:', error);
    res.status(500).json({ error: error.message });
  }
});

// Live spike-state monitor (SSE) — polls status_inquisit.py on an interval
// for an open short position and streams tier/state/HWM/momentum/action.
router.get('/:id/monitor', async (req: Request, res: Response) => {
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

  const finish = () => {
    clearInterval(keepalive);
    try { res.write(`event: done\ndata: {}\n\n`); res.end(); } catch {}
  };

  const id = req.params.id as string;
  const position = await getPositionByIdSafe(id).catch(() => null);

  if (!position) {
    send('error', { message: 'Position not found' });
    finish();
    return;
  }
  if (position.closed_at) {
    send('error', { message: 'Position is closed — nothing to monitor' });
    finish();
    return;
  }

  const tradierKey = process.env.TRADIER_API_KEY;
  if (!tradierKey) {
    send('error', { message: 'TRADIER_API_KEY not configured on server' });
    finish();
    return;
  }

  const ticker = position.ticker as string;
  const entryPrice = Number(position.entry_price);
  // Derive entry time HH:MM in ET from opened_at — status_inquisit.py needs
  // a clock time to anchor "bars since entry", not just a date.
  const entryTime = new Date(position.opened_at).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });

  let aborted = false;
  let loop: NodeJS.Timeout | null = null;
  req.on('close', () => {
    aborted = true;
    if (loop) clearInterval(loop);
    finish();
  });

  const POLL_INTERVAL_MS = 20_000; // matches status_inquisit.py's own --interval default of ~20-30s
  const SPAWN_TIMEOUT_MS = 25_000;

  const pollOnce = async () => {
    if (aborted) return;

    const args = [
      STATUS_INQUISIT_PATH,
      '--ticker', ticker,
      '--entry', String(entryPrice),
      '--entry-time', entryTime,
      '--once', '--json',
    ];

    const output = await new Promise<string>((resolve) => {
      let buf = '';
      const proc = spawn(PYTHON_BIN, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
               TRADIER_API_KEY: tradierKey },
      });
      proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => resolve(buf));
      setTimeout(() => { proc.kill(); resolve(buf); }, SPAWN_TIMEOUT_MS);
    });

    if (aborted) return;

    const jsonLine = output.trim().split('\n').reverse().find((l: string) => l.trimStart().startsWith('{'));
    if (!jsonLine) {
      send('error', { message: 'No data returned for this poll' });
      return;
    }
    try {
      const parsed = JSON.parse(jsonLine);
      send('update', parsed);
    } catch {
      send('error', { message: 'Failed to parse classifier output' });
    }
  };

  await pollOnce();
  if (!aborted) {
    loop = setInterval(() => {
      if (aborted) return;
      pollOnce();
    }, POLL_INTERVAL_MS);
  }
});

export default router;
