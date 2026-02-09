import express, { Request, Response } from 'express';
import { prisma } from '../index';

const router = express.Router();

// Get all ticker configs
router.get('/', async (req: Request, res: Response) => {
  try {
    const configs = await prisma.tickerConfig.findMany({
      orderBy: { ticker: 'asc' }
    });

    res.json(configs);
  } catch (error: any) {
    console.error('Error fetching ticker configs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single ticker config
router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const ticker = req.params.ticker as string;

    const config = await prisma.tickerConfig.findUnique({
      where: { ticker: ticker.toUpperCase() }
    });

    if (!config) {
      return res.status(404).json({ error: 'Ticker config not found' });
    }

    res.json(config);
  } catch (error: any) {
    console.error('Error fetching ticker config:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update ticker config
router.put('/:ticker', async (req: Request, res: Response) => {
  try {
    const ticker = req.params.ticker as string;
    const { enabled, alerts_blocked, blocked_until } = req.body;

    const config = await prisma.tickerConfig.upsert({
      where: { ticker: ticker.toUpperCase() },
      update: {
        ...(enabled !== undefined && { enabled }),
        ...(alerts_blocked !== undefined && { alerts_blocked }),
        ...(blocked_until !== undefined && { blocked_until: blocked_until ? new Date(blocked_until) : null })
      },
      create: {
        ticker: ticker.toUpperCase(),
        enabled: enabled !== undefined ? enabled : true,
        alerts_blocked: alerts_blocked !== undefined ? alerts_blocked : false,
        blocked_until: blocked_until ? new Date(blocked_until) : null
      }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'ticker_config_updated',
        ticker: ticker.toUpperCase(),
        details: JSON.stringify({ enabled, alerts_blocked, blocked_until })
      }
    });

    console.log(`✅ Ticker config updated: ${ticker}`);

    res.json(config);
  } catch (error: any) {
    console.error('Error updating ticker config:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
