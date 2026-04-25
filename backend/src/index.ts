import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

// Import routes
import webhookRoutes from './routes/webhook';
import tradeIntentRoutes from './routes/tradeIntent';
import executionRoutes from './routes/execution';
import positionRoutes from './routes/position';
import auditLogRoutes from './routes/auditLog';
import settingsRoutes from './routes/settings';
import tickerConfigRoutes from './routes/tickerConfig';
import authRoutes from './routes/auth';
import databaseRoutes from './routes/database';
import schedulesRoutes from './routes/schedules';
import simRoutes from './routes/sim';

// Import services
import { startCleanupScheduler } from './services/databaseCleanup';
import { startExecutionScheduler, stopExecutionScheduler } from './services/executionScheduler';
import { startDailyResetScheduler, stopDailyResetScheduler } from './services/dailyReset';
import { startModeScheduler, stopModeScheduler } from './services/modeScheduler';
import { startSecWatchScanner, stopSecWatchScanner, startLiveScorePoller, stopLiveScorePoller } from './services/secWatchScanner';
import { startSpikeMonitor, stopSpikeMonitor } from './services/spikeMonitorService';

// Load environment variables
dotenv.config();

// Initialize Prisma Client
// connection_limit=1 prevents persistent connection pool that keeps Neon awake 24/7
export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL + (process.env.DATABASE_URL?.includes('?') ? '&' : '?') + 'connection_limit=1&pool_timeout=10'
    }
  }
});

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet()); // Security headers
app.use(cors({
  origin: true, // Allow all origins
  credentials: true
}));
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/webhook', webhookRoutes);
app.use('/api/trade-intents', tradeIntentRoutes);
app.use('/api/executions', executionRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ticker-configs', tickerConfigRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/database', databaseRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/sim', simRoutes);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Serve static frontend files in production
// In production: __dirname is backend/dist, frontend-dist is at backend/frontend-dist
const frontendPath = path.join(__dirname, '../frontend-dist');

// Log the frontend path for debugging
console.log(`📁 Frontend path: ${frontendPath}`);

// Check if frontend-dist exists
if (fs.existsSync(frontendPath)) {
  console.log(`✅ Frontend directory exists`);
  const files = fs.readdirSync(frontendPath);
  console.log(`📂 Frontend files: ${files.slice(0, 10).join(', ')}${files.length > 10 ? '...' : ''}`);
} else {
  console.warn(`⚠️ Frontend directory NOT found at: ${frontendPath}`);
}

app.use(express.static(frontendPath));

// For any non-API routes, serve the frontend index.html (SPA support)
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }

  const indexPath = path.join(frontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not found. Build may have failed.');
  }
});

// Seed sim_tickers from committed CSV on first startup (pure Node.js, no Python dependency)
async function seedSimTickersFromCSV(): Promise<void> {
  try {
    const count = await prisma.simTicker.count();
    if (count > 0) return;
    const csvPath = path.join(__dirname, '../..', 'python/market_conditions.csv');
    if (!fs.existsSync(csvPath)) { console.warn('[sim] market_conditions.csv not found at', csvPath); return; }

    const content = fs.readFileSync(csvPath, 'utf-8').replace(/^﻿/, ''); // strip BOM
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return;

    const headers = lines[0].split(',');
    let seeded = 0;
    for (const line of lines.slice(1)) {
      const vals = line.split(',');
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
      const t = row.ticker?.toUpperCase();
      const d = row.spike_date;
      if (!t || !d) continue;
      await prisma.simTicker.upsert({
        where:  { ticker_spike_date: { ticker: t, spike_date: d } },
        create: { ticker: t, spike_date: d, csv_fields: JSON.stringify(row) },
        update: {},
      });
      seeded++;
    }
    console.log(`[sim] seeded ${seeded} rows from market_conditions.csv`);
  } catch (e) {
    console.error('[sim] seed error:', e);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`💾 Database: 80 MB limit with auto-cleanup`);

  // Start automatic database cleanup scheduler
  startCleanupScheduler();

  // Start execution scheduler (smart idle/active mode — activates on demand)
  startExecutionScheduler().catch(err => console.error('❌ Failed to start execution scheduler:', err));

  // Start daily reset scheduler (resets ticker configs at midnight or app startup)
  startDailyResetScheduler();

  // Start mode scheduler (auto-switches execution mode based on time schedules)
  startModeScheduler();

  // Start SEC watch scanner (polls watched tickers at fixed ET times)
  startSecWatchScanner();

  // Start live score poller (refreshes S1/S2 every 60s for active WALL cards)
  startLiveScorePoller();

  // Start spike monitor (auto-detects 40%+ movers, seeds SEC Watch panel)
  startSpikeMonitor();

  // Seed backtest ticker list from committed CSV (no-op if already seeded)
  seedSimTickersFromCSV().catch(err => console.error('[sim] seed failed:', err));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  stopExecutionScheduler();
  stopDailyResetScheduler();
  stopModeScheduler();
  stopSecWatchScanner();
  stopLiveScorePoller();
  stopSpikeMonitor();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  stopExecutionScheduler();
  stopDailyResetScheduler();
  stopModeScheduler();
  stopSecWatchScanner();
  stopLiveScorePoller();
  stopSpikeMonitor();
  await prisma.$disconnect();
  process.exit(0);
});
