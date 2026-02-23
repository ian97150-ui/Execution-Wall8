import { PrismaClient } from '@prisma/client';
import { prisma } from '../index';

// Database size limit in bytes (80 MB)
const DB_SIZE_LIMIT = 80 * 1024 * 1024; // 80 MB in bytes

// Retention policies (in days)
const RETENTION_POLICY = {
  trade_intents: 30,        // Keep last 30 days
  webhook_logs: 14,         // Keep last 14 days
  audit_logs: 60,           // Keep last 60 days
  closed_positions: 90,     // Keep closed positions for 90 days
  wall_events: 30,          // Keep last 30 days
  executed_executions: 30   // Keep executed orders for 30 days
};

/**
 * Get approximate database size
 * This is an estimate based on record counts
 */
async function estimateDatabaseSize(): Promise<number> {
  try {
    // Get counts for each table
    const counts = await Promise.all([
      prisma.tradeIntent.count(),
      prisma.webhookLog.count(),
      prisma.auditLog.count(),
      prisma.position.count(),
      prisma.execution.count(),
      prisma.wallEvent.count(),
      prisma.user.count(),
      prisma.tickerConfig.count(),
      prisma.executionSettings.count()
    ]);

    // Estimated bytes per record for each table
    const avgSizes = [
      3000,  // TradeIntent (~3 KB with JSON fields)
      2000,  // WebhookLog (~2 KB with payload)
      1000,  // AuditLog (~1 KB)
      500,   // Position
      1000,  // Execution
      1000,  // WallEvent
      200,   // User
      200,   // TickerConfig
      500    // ExecutionSettings
    ];

    // Calculate total size
    let totalSize = 0;
    for (let i = 0; i < counts.length; i++) {
      totalSize += counts[i] * avgSizes[i];
    }

    // Add 20% overhead for indexes and metadata
    totalSize = Math.floor(totalSize * 1.2);

    return totalSize;
  } catch (error) {
    console.error('Error estimating database size:', error);
    return 0;
  }
}

/**
 * Delete old trade intents
 */
async function cleanupTradeIntents(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.trade_intents);

  const result = await prisma.tradeIntent.deleteMany({
    where: {
      created_date: {
        lt: cutoffDate
      },
      // Don't delete pending or active intents
      status: {
        in: ['cancelled', 'swiped_off', 'swiped_deny']
      }
    }
  });

  return result.count;
}

/**
 * Delete old webhook logs
 */
async function cleanupWebhookLogs(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.webhook_logs);

  const result = await prisma.webhookLog.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate
      }
    }
  });

  return result.count;
}

/**
 * Delete old audit logs
 */
async function cleanupAuditLogs(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.audit_logs);

  const result = await prisma.auditLog.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate
      }
    }
  });

  return result.count;
}

/**
 * Delete old closed positions
 */
async function cleanupClosedPositions(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.closed_positions);

  const result = await prisma.position.deleteMany({
    where: {
      closed_at: {
        not: null,
        lt: cutoffDate
      }
    }
  });

  return result.count;
}

/**
 * Delete old executions — executed, cancelled, and failed records
 */
async function cleanupExecutedOrders(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.executed_executions);

  const result = await prisma.execution.deleteMany({
    where: {
      OR: [
        // Executed orders: use executed_at timestamp
        {
          status: 'executed',
          executed_at: { not: null, lt: cutoffDate }
        },
        // Cancelled/failed orders: use created_at (no executed_at set)
        {
          status: { in: ['cancelled', 'failed'] },
          created_at: { lt: cutoffDate }
        }
      ]
    }
  });

  return result.count;
}

/**
 * Delete old wall events
 */
async function cleanupWallEvents(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.wall_events);

  const result = await prisma.wallEvent.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate
      }
    }
  });

  return result.count;
}

/**
 * Aggressive cleanup - delete more data if still over limit
 */
async function aggressiveCleanup(): Promise<void> {
  console.log('⚠️  Performing aggressive cleanup...');

  // Keep only last 1000 webhook logs
  const webhookLogs = await prisma.webhookLog.findMany({
    orderBy: { timestamp: 'desc' },
    skip: 1000,
    select: { id: true }
  });

  if (webhookLogs.length > 0) {
    await prisma.webhookLog.deleteMany({
      where: {
        id: {
          in: webhookLogs.map(log => log.id)
        }
      }
    });
    console.log(`   Deleted ${webhookLogs.length} old webhook logs`);
  }

  // Keep only last 5000 audit logs
  const auditLogs = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    skip: 5000,
    select: { id: true }
  });

  if (auditLogs.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        id: {
          in: auditLogs.map(log => log.id)
        }
      }
    });
    console.log(`   Deleted ${auditLogs.length} old audit logs`);
  }
}

/**
 * Main cleanup function
 */
export async function performDatabaseCleanup(): Promise<void> {
  try {
    console.log('🧹 Starting database cleanup...');

    // Check current database size
    const currentSize = await estimateDatabaseSize();
    const sizeMB = (currentSize / (1024 * 1024)).toFixed(2);
    const limitMB = (DB_SIZE_LIMIT / (1024 * 1024)).toFixed(2);

    console.log(`   Current size: ${sizeMB} MB / ${limitMB} MB`);

    // If under 70% of limit, skip cleanup
    if (currentSize < DB_SIZE_LIMIT * 0.7) {
      console.log('   ✅ Database size OK, skipping cleanup');
      return;
    }

    console.log('   🗑️  Cleaning up old records...');

    // Perform standard cleanup
    const results = await Promise.all([
      cleanupTradeIntents(),
      cleanupWebhookLogs(),
      cleanupAuditLogs(),
      cleanupClosedPositions(),
      cleanupExecutedOrders(),
      cleanupWallEvents()
    ]);

    const [intents, webhooks, audits, positions, executions, events] = results;

    console.log(`   Deleted: ${intents} trade intents`);
    console.log(`   Deleted: ${webhooks} webhook logs`);
    console.log(`   Deleted: ${audits} audit logs`);
    console.log(`   Deleted: ${positions} closed positions`);
    console.log(`   Deleted: ${executions} executed orders`);
    console.log(`   Deleted: ${events} wall events`);

    // Check size again
    const newSize = await estimateDatabaseSize();
    const newSizeMB = (newSize / (1024 * 1024)).toFixed(2);

    console.log(`   New size: ${newSizeMB} MB`);

    // If still over limit, perform aggressive cleanup
    if (newSize > DB_SIZE_LIMIT) {
      await aggressiveCleanup();

      const finalSize = await estimateDatabaseSize();
      const finalSizeMB = (finalSize / (1024 * 1024)).toFixed(2);
      console.log(`   Final size: ${finalSizeMB} MB`);
    }

    console.log('✅ Database cleanup completed');

  } catch (error) {
    console.error('❌ Error during database cleanup:', error);
  }
}

/**
 * Start automatic cleanup scheduler
 * Runs cleanup every hour
 */
export function startCleanupScheduler(): void {
  console.log('🕐 Starting database cleanup scheduler (runs every hour)');

  // Run immediately on startup
  performDatabaseCleanup();

  // Run every hour
  setInterval(() => {
    performDatabaseCleanup();
  }, 60 * 60 * 1000); // 1 hour
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
  try {
    const [
      tradeIntents,
      webhookLogs,
      auditLogs,
      positions,
      openPositions,
      executions,
      users,
      tickerConfigs
    ] = await Promise.all([
      prisma.tradeIntent.count(),
      prisma.webhookLog.count(),
      prisma.auditLog.count(),
      prisma.position.count(),
      prisma.position.count({ where: { closed_at: null } }),
      prisma.execution.count(),
      prisma.user.count(),
      prisma.tickerConfig.count()
    ]);

    const estimatedSize = await estimateDatabaseSize();
    const sizeMB = (estimatedSize / (1024 * 1024)).toFixed(2);
    const limitMB = (DB_SIZE_LIMIT / (1024 * 1024)).toFixed(2);
    const usagePercent = ((estimatedSize / DB_SIZE_LIMIT) * 100).toFixed(1);

    return {
      size: {
        current: estimatedSize,
        currentMB: sizeMB,
        limit: DB_SIZE_LIMIT,
        limitMB: limitMB,
        usagePercent: parseFloat(usagePercent)
      },
      records: {
        tradeIntents,
        webhookLogs,
        auditLogs,
        positions,
        openPositions,
        executions,
        users,
        tickerConfigs
      },
      retentionPolicy: RETENTION_POLICY
    };
  } catch (error) {
    console.error('Error getting database stats:', error);
    throw error;
  }
}
