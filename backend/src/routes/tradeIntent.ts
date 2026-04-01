import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { PushoverNotifications } from '../services/pushoverService';
import { checkSecFilings } from '../services/secCallbackService';
import { runSecWatchScan } from '../services/secWatchScanner';
import { runChecklist, applyManualOverride, SecChecklist } from '../services/secChecklistService';

const router = express.Router();

// Get trade intents (with filters)
router.get('/', async (req: Request, res: Response) => {
  try {
    const card_state = req.query.card_state as string | undefined;
    const status = req.query.status as string | undefined;
    const ticker = req.query.ticker as string | undefined;
    const sec_watch = req.query.sec_watch as string | undefined;

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

    // Filter by sec_watch
    if (sec_watch === 'true') {
      where.sec_watch = true;
    }

    // SEC watch list: show all sec_watch cards from last 7 days regardless of expiry
    const isSecWatchQuery = sec_watch === 'true';

    // Filter out expired intents - but skip for blocked cards (swiped_off) and sec_watch
    const isBlockedQuery = status === 'swiped_off';
    if (!isBlockedQuery && !isSecWatchQuery) {
      where.expires_at = { gt: new Date() };
    } else if (isBlockedQuery) {
      // For blocked cards, only show from last 24 hours
      where.created_date = { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    } else {
      // For sec_watch, show from last 7 days
      where.created_date = { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
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
        update: { enabled: true, alerts_blocked: false, blocked_until: null },
        create: {
          ticker: intent.ticker,
          enabled: true,
          alerts_blocked: false
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
      PushoverNotifications.signalApproved(intent.ticker, approvalNotificationData).catch(err => console.error('Pushover notification error:', err));
    }

    res.json(updatedIntent);
  } catch (error: any) {
    console.error('Error processing swipe:', error);
    res.status(500).json({ error: error.message });
  }
});

// SEC watch / confirm action
router.post('/:id/sec', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { action } = req.body; // 'watch' | 'unwatch' | 'confirm' | 'unconfirm'

    const intent = await prisma.tradeIntent.findUnique({ where: { id } });
    if (!intent) return res.status(404).json({ error: 'Trade intent not found' });

    let updateData: any = {};
    if (action === 'watch')     updateData = { sec_watch: true };
    else if (action === 'unwatch') updateData = { sec_watch: false, sec_confirmed: false };
    else if (action === 'confirm')  updateData = { sec_confirmed: true };
    else if (action === 'unconfirm') updateData = { sec_confirmed: false };
    else return res.status(400).json({ error: 'Invalid action. Must be: watch, unwatch, confirm, unconfirm' });

    const updated = await prisma.tradeIntent.update({ where: { id }, data: updateData });

    // Fire-and-forget: auto-run checklist on confirm (bias may upgrade) or watch if no data yet
    if (action === 'confirm' || (action === 'watch' && !intent.sec_checklist)) {
      runChecklist(intent.ticker)
        .then(c => prisma.tradeIntent.update({
          where: { id },
          data: { sec_checklist: JSON.stringify(c), sec_bias: c.bias }
        }))
        .catch(err => console.warn(`⚠️ SEC checklist auto-run failed for ${intent.ticker}: ${err.message}`));
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Error processing SEC action:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scan all watched-but-unconfirmed tickers at once (manual trigger of the scheduled pass)
router.post('/scan-sec-all', async (req: Request, res: Response) => {
  try {
    const results = await runSecWatchScan();
    const confirmed = results.filter(r => r.found).length;
    const total = results.length;
    res.json({ success: true, total, confirmed, results });
  } catch (error: any) {
    console.error('Error running bulk SEC scan:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual SEC scan for a single watched ticker
router.post('/:id/scan-sec', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const intent = await prisma.tradeIntent.findUnique({ where: { id } });
    if (!intent) return res.status(404).json({ error: 'Trade intent not found' });

    const result = await checkSecFilings(intent.ticker, false);
    const now = new Date().toISOString();

    let history: any[] = [];
    try {
      if (intent.sec_scan_history) history = JSON.parse(intent.sec_scan_history as string);
    } catch {}

    const entry: any = { at: now, found: result.found };
    if (result.found && result.filings) entry.filings = result.filings;
    if (result.error) entry.error = result.error;
    history.push(entry);
    if (history.length > 20) history = history.slice(-20);

    const updateData: any = { sec_scan_history: JSON.stringify(history) };
    if (result.found) {
      updateData.sec_confirmed = true;
      updateData.sec_filings = JSON.stringify(result.filings || []);
    }

    const updated = await prisma.tradeIntent.update({ where: { id }, data: updateData });
    res.json({ ...updated, scan_result: result });
  } catch (error: any) {
    console.error('Error running manual SEC scan:', error);
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

// Run full SEC checklist (phases 1-4 automated)
router.post('/:id/run-checklist', async (req: Request, res: Response) => {
  try {
    const intent = await prisma.tradeIntent.findUnique({ where: { id: req.params.id as string } });
    if (!intent) return res.status(404).json({ error: 'Intent not found' });

    // Preserve any existing manual fields
    let existing: SecChecklist | null = null;
    if (intent.sec_checklist) {
      try { existing = JSON.parse(intent.sec_checklist); } catch { /* ignore */ }
    }

    const checklist = await runChecklist(intent.ticker, existing);

    const updated = await prisma.tradeIntent.update({
      where: { id: intent.id },
      data: {
        sec_checklist: JSON.stringify(checklist),
        sec_bias: checklist.bias
      }
    });

    console.log(`✅ SEC checklist run for ${intent.ticker}: ${checklist.bias}`);
    res.json(updated);
  } catch (error: any) {
    console.error('Error running SEC checklist:', error);
    res.status(500).json({ error: error.message });
  }
});

// Apply manual overrides to existing checklist (sympathy_trade, pm_high_override, vwap_override)
router.patch('/:id/checklist-manual', async (req: Request, res: Response) => {
  try {
    const intent = await prisma.tradeIntent.findUnique({ where: { id: req.params.id as string } });
    if (!intent) return res.status(404).json({ error: 'Intent not found' });
    if (!intent.sec_checklist) {
      return res.status(400).json({ error: 'No checklist found — run checklist first' });
    }

    let existing: SecChecklist;
    try {
      existing = JSON.parse(intent.sec_checklist);
    } catch {
      return res.status(400).json({ error: 'Checklist data is corrupt — run checklist again' });
    }

    const updates = req.body as {
      phase2?: { sympathy_trade?: boolean | null };
      phase3?: { pm_high_override?: boolean | null; vwap_override?: boolean | null };
    };

    const updated = applyManualOverride(existing, updates);

    const savedIntent = await prisma.tradeIntent.update({
      where: { id: intent.id },
      data: {
        sec_checklist: JSON.stringify(updated),
        sec_bias: updated.bias
      }
    });

    res.json(savedIntent);
  } catch (error: any) {
    console.error('Error applying checklist manual override:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
