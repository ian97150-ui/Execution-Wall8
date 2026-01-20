import express, { Request, Response } from 'express';
import { prisma } from '../index';

const router = express.Router();

// Get audit logs (with filters)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { event_type, ticker, limit = 100, offset = 0 } = req.query;

    const where: any = {};
    if (event_type) {
      if (Array.isArray(event_type)) {
        where.event_type = { in: event_type };
      } else if (typeof event_type === 'string') {
        where.event_type = { in: event_type.split(',') };
      }
    }
    if (ticker) where.ticker = ticker;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: Number(limit),
      skip: Number(offset)
    });

    const total = await prisma.auditLog.count({ where });

    res.json({
      logs,
      total,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error: any) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create audit log entry
router.post('/', async (req: Request, res: Response) => {
  try {
    const { event_type, ticker, details } = req.body;

    if (!event_type) {
      return res.status(400).json({ error: 'event_type is required' });
    }

    const log = await prisma.auditLog.create({
      data: {
        event_type,
        ticker: ticker || null,
        details: typeof details === 'string' ? details : JSON.stringify(details)
      }
    });

    res.status(201).json(log);
  } catch (error: any) {
    console.error('Error creating audit log:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
