import { prisma } from '../index';

// Store the last reset date
let lastResetDate: string | null = null;

/**
 * Get today's date as YYYY-MM-DD string
 */
function getTodayDateString(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Check if we need to perform a daily reset
 * Returns true if:
 * - It's a new day (midnight has passed)
 * - App just started and hasn't reset today
 */
async function shouldPerformDailyReset(): Promise<boolean> {
  const today = getTodayDateString();

  // If we haven't tracked a reset yet, check database
  if (lastResetDate === null) {
    // Check the last reset from audit log
    const lastReset = await prisma.auditLog.findFirst({
      where: {
        event_type: 'daily_reset'
      },
      orderBy: { timestamp: 'desc' }
    });

    if (lastReset) {
      lastResetDate = lastReset.timestamp.toISOString().split('T')[0];
    }
  }

  // If no reset today, we should reset
  return lastResetDate !== today;
}

/**
 * Perform the daily reset:
 * - Reset all ticker configs to enabled: true
 * - Clear pending executions (not positions!)
 * - Clear expired trade intents
 */
export async function performDailyReset(): Promise<void> {
  try {
    const shouldReset = await shouldPerformDailyReset();

    if (!shouldReset) {
      console.log('📅 Daily reset already performed today');
      return;
    }

    console.log('🌅 Performing daily reset...');

    // 1. Reset all ticker configs to enabled: true (unblock all tickers)
    const tickerConfigsReset = await prisma.tickerConfig.updateMany({
      where: {
        enabled: false
      },
      data: {
        enabled: true,
        blocked_until: null
      }
    });
    console.log(`   ✅ Reset ${tickerConfigsReset.count} blocked ticker configs`);

    // 2. Clear pending executions (not executed ones, and not positions!)
    // IMPORTANT: Exclude EXIT orders - they must survive overnight to close positions
    const pendingExecutionsCleared = await prisma.execution.deleteMany({
      where: {
        status: { in: ['pending', 'cancelled', 'failed'] },
        // Exclude EXIT signals - they should never be deleted by daily reset
        NOT: {
          raw_payload: { contains: '"event":"EXIT"' }
        }
      }
    });
    console.log(`   ✅ Cleared ${pendingExecutionsCleared.count} pending/cancelled/failed executions (EXIT orders preserved)`);

    // 3. Clear expired and non-active trade intents
    const expiredIntentsCleared = await prisma.tradeIntent.deleteMany({
      where: {
        OR: [
          // Expired intents
          {
            expires_at: { lt: new Date() }
          },
          // Blocked/denied intents (we're resetting blocks anyway)
          {
            status: { in: ['swiped_off', 'swiped_deny', 'cancelled'] }
          }
        ]
      }
    });
    console.log(`   ✅ Cleared ${expiredIntentsCleared.count} expired/blocked trade intents`);

    // 4. Reset any remaining pending intents to fresh state (keep them as candidates)
    const pendingIntentsReset = await prisma.tradeIntent.updateMany({
      where: {
        status: 'pending'
      },
      data: {
        // Extend expiry for a new day
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
    console.log(`   ✅ Extended expiry for ${pendingIntentsReset.count} pending intents`);

    // Record the reset in audit log
    await prisma.auditLog.create({
      data: {
        event_type: 'daily_reset',
        details: JSON.stringify({
          ticker_configs_reset: tickerConfigsReset.count,
          pending_executions_cleared: pendingExecutionsCleared.count,
          expired_intents_cleared: expiredIntentsCleared.count,
          pending_intents_extended: pendingIntentsReset.count,
          reset_date: getTodayDateString()
        })
      }
    });

    // Update the last reset date
    lastResetDate = getTodayDateString();

    console.log('✅ Daily reset completed');

  } catch (error: any) {
    console.error('❌ Error during daily reset:', error.message);
  }
}

/**
 * Check if it's midnight (within a 5-minute window)
 */
function isMidnight(): boolean {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();

  // Check if it's between 00:00 and 00:05
  return hours === 0 && minutes < 5;
}

let resetSchedulerInterval: NodeJS.Timeout | null = null;

/**
 * Start the daily reset scheduler
 * - Runs immediately on startup to check if reset is needed
 * - Then checks every minute for midnight reset
 */
export function startDailyResetScheduler(): void {
  if (resetSchedulerInterval) {
    console.log('⚠️ Daily reset scheduler already running');
    return;
  }

  console.log('🕐 Starting daily reset scheduler');

  // Run immediately on startup
  performDailyReset();

  // Check every minute for midnight
  resetSchedulerInterval = setInterval(async () => {
    if (isMidnight()) {
      await performDailyReset();
    }
  }, 60 * 1000); // Check every minute
}

/**
 * Stop the daily reset scheduler
 */
export function stopDailyResetScheduler(): void {
  if (resetSchedulerInterval) {
    clearInterval(resetSchedulerInterval);
    resetSchedulerInterval = null;
    console.log('🛑 Daily reset scheduler stopped');
  }
}

/**
 * Force a daily reset (for manual triggering)
 */
export async function forceReset(): Promise<{ success: boolean; message: string }> {
  try {
    // Reset the lastResetDate to force a new reset
    lastResetDate = null;

    await performDailyReset();

    return { success: true, message: 'Daily reset performed successfully' };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}
