import express from 'express';
import {
  handleWebhook,
  getWebhookLogs,
  testWebhook
} from '../controllers/webhookController';
import { prisma } from '../index';

const router = express.Router();

// Early-stage request logging middleware for all webhook routes
// This logs BEFORE any processing to help diagnose delivery issues
router.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const path = req.path;
  const contentType = req.headers['content-type'];
  const bodySize = JSON.stringify(req.body || {}).length;

  // Log every request immediately
  console.log(`📨 [${timestamp}] WEBHOOK REQUEST: ${method} ${path} | Content-Type: ${contentType} | Body size: ${bodySize} bytes`);

  // For POST requests with body, log the ticker/event early
  if (method === 'POST' && req.body) {
    const { event, type, ticker, symbol } = req.body;
    console.log(`   → Event: ${event || type || 'unknown'} | Ticker: ${ticker || symbol || 'unknown'}`);
  }

  next();
});

// Diagnostic: Simple ping endpoint to test connectivity
router.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'Webhook endpoint is reachable'
  });
});

// Diagnostic: Echo endpoint - returns exactly what was received (for testing)
router.post('/echo', async (req, res) => {
  const timestamp = new Date().toISOString();

  // Log to database for persistent record
  try {
    await prisma.auditLog.create({
      data: {
        event_type: 'webhook_echo',
        ticker: req.body?.ticker || req.body?.symbol || 'UNKNOWN',
        details: JSON.stringify({
          headers: {
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent'],
            'x-forwarded-for': req.headers['x-forwarded-for']
          },
          body: req.body,
          received_at: timestamp
        })
      }
    });
  } catch (e) {
    console.error('Failed to log echo request:', e);
  }

  res.json({
    received: true,
    timestamp,
    body: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent']
    }
  });
});

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
