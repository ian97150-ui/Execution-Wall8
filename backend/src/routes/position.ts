import express, { Request, Response } from 'express';
import { prisma } from '../index';

const router = express.Router();

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
    side: position.side?.toLowerCase() || position.side
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

export default router;
