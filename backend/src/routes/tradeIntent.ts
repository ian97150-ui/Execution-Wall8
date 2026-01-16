import express, { Request, Response } from 'express';
import { prisma } from '../index';

const router = express.Router();

// Get trade intents (with filters)
router.get('/', async (req: Request, res: Response) => {
  try {
    const card_state = req.query.card_state as string | undefined;
    const status = req.query.status as string | undefined;
    const ticker = req.query.ticker as string | undefined;

    const where: any = {};

    // Filter by card_state
    if (card_state) {
      where.card_state = { in: card_state.split(',') };
    }

    // Filter by status
    if (status) {
      where.status = { in: status.split(',') };
    }

    // Filter by ticker
    if (ticker) {
      where.ticker = ticker;
    }

    // Filter out expired intents
    where.expires_at = { gt: new Date() };

    const intents = await prisma.tradeIntent.findMany({
      where,
      orderBy: { created_date: 'desc' },
      take: 50
    });

    res.json(intents);
  } catch (error: any) {
    console.error('Error fetching trade intents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single trade intent by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const intent = await prisma.tradeIntent.findUnique({
      where: { id }
    });

    if (!intent) {
      return res.status(404).json({ error: 'Trade intent not found' });
    }

    res.json(intent);
  } catch (error: any) {
    console.error('Error fetching trade intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Swipe action on trade intent
router.post('/:id/swipe', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { action } = req.body; // 'approve', 'deny', 'off', 'revive'

    const intent = await prisma.tradeIntent.findUnique({
      where: { id }
    });

    if (!intent) {
      return res.status(404).json({ error: 'Trade intent not found' });
    }

    let newStatus: string;
    switch (action) {
      case 'approve':
        newStatus = 'swiped_on';
        break;
      case 'deny':
        newStatus = 'swiped_deny';
        break;
      case 'off':
        newStatus = 'swiped_off';
        break;
      case 'revive':
        newStatus = 'pending'; // Reset to pending so it appears in candidates again
        break;
      default:
        return res.status(400).json({ error: 'Invalid action. Must be: approve, deny, off, or revive' });
    }

    // Update trade intent
    const updatedIntent = await prisma.tradeIntent.update({
      where: { id },
      data: { status: newStatus }
    });

    // Update or create ticker config
    if (action === 'approve' || action === 'revive') {
      await prisma.tickerConfig.upsert({
        where: { ticker: intent.ticker },
        update: { enabled: true, blocked_until: null },
        create: {
          ticker: intent.ticker,
          enabled: true
        }
      });
    } else if (action === 'off') {
      await prisma.tickerConfig.upsert({
        where: { ticker: intent.ticker },
        update: { enabled: false },
        create: {
          ticker: intent.ticker,
          enabled: false
        }
      });

      // Also invalidate any other pending intents for this ticker to prevent duplicates
      const otherIntents = await prisma.tradeIntent.updateMany({
        where: {
          ticker: intent.ticker,
          id: { not: id },
          status: { in: ['pending', 'swiped_on'] }
        },
        data: {
          status: 'cancelled',
          card_state: 'INVALIDATED'
        }
      });

      if (otherIntents.count > 0) {
        console.log(`   ↳ Invalidated ${otherIntents.count} other intents for ${intent.ticker}`);
      }
    }

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: `swiped_${action}`,
        ticker: intent.ticker,
        details: JSON.stringify({
          intent_id: id,
          action,
          previous_status: intent.status,
          new_status: newStatus
        })
      }
    });

    console.log(`✅ Trade intent ${id} swiped: ${action}`);

    res.json(updatedIntent);
  } catch (error: any) {
    console.error('Error processing swipe:', error);
    res.status(500).json({ error: error.message });
  }
});

// Invalidate trade intent
router.post('/:id/invalidate', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const intent = await prisma.tradeIntent.update({
      where: { id },
      data: {
        card_state: 'INVALIDATED',
        status: 'cancelled'
      }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'intent_invalidated',
        ticker: intent.ticker,
        details: JSON.stringify({ intent_id: id })
      }
    });

    console.log(`✅ Trade intent ${id} invalidated`);

    res.json(intent);
  } catch (error: any) {
    console.error('Error invalidating intent:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
