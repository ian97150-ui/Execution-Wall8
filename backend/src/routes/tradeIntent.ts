import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { EmailNotifications } from '../services/emailService';
import { PushoverNotifications } from '../services/pushoverService';

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

    // Filter out expired intents - but skip for blocked cards (swiped_off)
    // so they can still be shown in the blocked list for revival
    const isBlockedQuery = status === 'swiped_off';
    if (!isBlockedQuery) {
      where.expires_at = { gt: new Date() };
    } else {
      // For blocked cards, only show from last 24 hours
      where.created_date = { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    }

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
    // If blocking (off/deny), expire immediately so it doesn't show up next session
    // If reviving, give a fresh 24-hour window
    const shouldExpireNow = action === 'off' || action === 'deny';
    const shouldResetExpiry = action === 'revive';
    const freshExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

    const updatedIntent = await prisma.tradeIntent.update({
      where: { id },
      data: {
        status: newStatus,
        ...(shouldExpireNow && { expires_at: new Date() }),
        ...(shouldResetExpiry && { expires_at: freshExpiry })
      }
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
      // Block ticker until next daily reset (no timer needed - daily reset handles unblocking)
      await prisma.tickerConfig.upsert({
        where: { ticker: intent.ticker },
        update: { enabled: false, blocked_until: null },
        create: {
          ticker: intent.ticker,
          enabled: false,
          blocked_until: null
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

    // Send notifications for signal approval
    if (action === 'approve') {
      const approvalNotificationData = {
        action: 'approved',
        side: intent.dir,
        price: intent.price,
        quality_tier: intent.quality_tier,
        quality_score: intent.quality_score
      };
      EmailNotifications.signalApproved(intent.ticker, approvalNotificationData).catch(err => console.error('Email notification error:', err));
      PushoverNotifications.signalApproved(intent.ticker, approvalNotificationData).catch(err => console.error('Pushover notification error:', err));
    }

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

// Create demo WALL card (for testing)
router.post('/demo', async (req: Request, res: Response) => {
  try {
    // Sample tickers for demo
    const demoTickers = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META'];
    const randomTicker = demoTickers[Math.floor(Math.random() * demoTickers.length)];
    const randomPrice = (50 + Math.random() * 450).toFixed(2);
    const isLong = Math.random() > 0.3; // 70% long, 30% short
    const qualityTiers = ['S', 'A', 'B', 'C'];
    const randomTier = qualityTiers[Math.floor(Math.random() * qualityTiers.length)];
    const randomScore = Math.floor(60 + Math.random() * 40); // 60-100

    const intent = await prisma.tradeIntent.create({
      data: {
        ticker: randomTicker,
        dir: isLong ? 'Long' : 'Short',
        price: randomPrice,
        status: 'pending',
        card_state: 'ELIGIBLE',
        quality_tier: randomTier,
        quality_score: randomScore,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
      }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'demo_wall_created',
        ticker: randomTicker,
        details: JSON.stringify({
          intent_id: intent.id,
          message: 'Demo WALL card created for testing'
        })
      }
    });

    console.log(`🎯 Demo WALL card created: ${intent.ticker} (${intent.dir}) @ $${intent.price}`);

    res.status(201).json({
      intent,
      message: `Demo WALL card created: ${intent.ticker}`
    });
  } catch (error: any) {
    console.error('Error creating demo WALL card:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
