import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
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

// Import services
import { startCleanupScheduler } from './services/databaseCleanup';
import { startExecutionScheduler, stopExecutionScheduler } from './services/executionScheduler';
import { startDailyResetScheduler, stopDailyResetScheduler } from './services/dailyReset';

// Load environment variables
dotenv.config();

// Initialize Prisma Client
export const prisma = new PrismaClient();

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

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Serve static frontend files in production
const frontendPath = path.join(__dirname, '../../frontend-dist');
app.use(express.static(frontendPath));

// For any non-API routes, serve the frontend index.html (SPA support)
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`💾 Database: 80 MB limit with auto-cleanup`);

  // Start automatic database cleanup scheduler
  startCleanupScheduler();

  // Start execution scheduler (auto-executes orders when delay expires)
  startExecutionScheduler();

  // Start daily reset scheduler (resets ticker configs at midnight or app startup)
  startDailyResetScheduler();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  stopExecutionScheduler();
  stopDailyResetScheduler();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  stopExecutionScheduler();
  stopDailyResetScheduler();
  await prisma.$disconnect();
  process.exit(0);
});
