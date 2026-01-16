import express, { Request, Response } from 'express';
import { prisma } from '../index';

const router = express.Router();

// Get all positions (open and closed)
router.get('/', async (req: Request, res: Response) => {
  try {
    const open_only = req.query.open_only as string | undefined;
    const ticker = req.query.ticker as string | undefined;

    const where: any = {};
    if (ticker) where.ticker = ticker;
    if (open_only === 'true') where.closed_at = null;

    const positions = await prisma.position.findMany({
      where,
      orderBy: { opened_at: 'desc' }
    });

    res.json(positions);
  } catch (error: any) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single position
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const position = await prisma.position.findUnique({
      where: { id }
    });

    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    res.json(position);
  } catch (error: any) {
    console.error('Error fetching position:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark position as flat (close it)
router.post('/:id/mark-flat', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const position = await prisma.position.findUnique({
      where: { id }
    });

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

    res.json(updatedPosition);
  } catch (error: any) {
    console.error('Error marking position flat:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
