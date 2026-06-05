import express, { Request, Response } from 'express';
import { runAnalysis } from '../services/classifierAnalysisService';

const router = express.Router();

// POST /api/classifier/analyze
// Body: { ticker: string, date: string }
// Spawns v4 with tick layer — slow (30-60s), use for offline session review only
router.post('/analyze', async (req: Request, res: Response) => {
  const { ticker, date } = req.body as { ticker?: string; date?: string };
  if (!ticker || !date) {
    res.status(400).json({ error: 'ticker and date are required' });
    return;
  }
  const result = await runAnalysis(ticker, date);
  if (!result) {
    res.status(500).json({ error: 'Analysis failed or timed out' });
    return;
  }
  res.json(result);
});

export default router;
