import express from 'express';
import {
  handleWebhook,
  getWebhookLogs,
  testWebhook
} from '../controllers/webhookController';

const router = express.Router();

// Unified webhook endpoint (handles WALL, ORDER, EXIT signals)
// Use POST /api/webhook or POST /api/webhook/signal
router.post('/', handleWebhook);
router.post('/signal', handleWebhook);

// Legacy route for backwards compatibility
router.post('/tradingview', handleWebhook);

// Get webhook logs (requires auth in production)
router.get('/logs', getWebhookLogs);

// Test webhook endpoint
router.post('/test', testWebhook);

export default router;
