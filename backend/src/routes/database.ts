import express, { Request, Response } from 'express';
import { getDatabaseStats, performDatabaseCleanup } from '../services/databaseCleanup';

const router = express.Router();

// Get database statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (error: any) {
    console.error('Error getting database stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger cleanup
router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    await performDatabaseCleanup();
    const stats = await getDatabaseStats();
    res.json({
      message: 'Cleanup completed',
      stats
    });
  } catch (error: any) {
    console.error('Error during manual cleanup:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
