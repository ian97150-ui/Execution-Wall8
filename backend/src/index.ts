import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
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
  origin: process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_URL
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
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
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  stopExecutionScheduler();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  stopExecutionScheduler();
  await prisma.$disconnect();
  process.exit(0);
});
