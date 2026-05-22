import express, { Request, Response } from 'express';
import { getLiveTradesForDate } from '../services/liveTradeExportService';
import { getLiveConsideredForDate } from '../services/liveConsideredService';
import { backfillAll } from '../services/backfillService';

const router = express.Router();

// GET /api/live-trades/export?date=YYYY-MM-DD
router.get('/export', async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  const records = await getLiveTradesForDate(date).catch(() => []);
  res.setHeader('Content-Disposition', `attachment; filename="live_trades_${date}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(records, null, 2));
});

// GET /api/live-trades?date=YYYY-MM-DD
router.get('/', async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  res.json(await getLiveTradesForDate(date).catch(() => []));
});

// GET /api/live-considered/export?date=YYYY-MM-DD
router.get('/considered/export', async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  const records = await getLiveConsideredForDate(date).catch(() => []);
  res.setHeader('Content-Disposition', `attachment; filename="live_considered_${date}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(records, null, 2));
});

// GET /api/live-considered?date=YYYY-MM-DD
router.get('/considered', async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  res.json(await getLiveConsideredForDate(date).catch(() => []));
});

// POST /api/live-trades/backfill?dryRun=true
router.post('/backfill', async (req: Request, res: Response) => {
  const dryRun = req.query.dryRun === 'true';
  const result = await backfillAll(dryRun).catch(err => ({ error: (err as Error).message }));
  res.json({ dryRun, ...result });
});

export default router;
