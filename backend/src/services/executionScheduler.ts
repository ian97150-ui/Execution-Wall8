import { prisma } from '../index';
import { forwardToBroker } from './brokerWebhook';
import { EmailNotifications } from './emailService';

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Helper to safely get settings without failing on missing columns
 */
async function getSettingsSafe() {
  try {
    // Try to get all settings
    return await prisma.executionSettings.findFirst();
  } catch (e: any) {
    // If column doesn't exist, use raw query for basic fields only
    if (e.message?.includes('does not exist')) {
      console.warn('⚠️ Some settings columns missing, using defaults');
      try {
        const results = await prisma.$queryRaw`
          SELECT id, execution_mode, default_delay_bars
          FROM execution_settings
          LIMIT 1
        ` as any[];
        return results[0] || null;
      } catch {
        return null;
      }
    }
    throw e;
  }
}

/**
 * Check for pending executions with expired delays and auto-execute them
 *
 * Safe Mode Behavior:
 * - ENTRY orders: Auto-execute when delay expires (user can cancel during delay)
 * - EXIT orders: Also auto-execute when delay expires (fail-safe: always close positions)
 *
 * This ensures positions are never left open indefinitely if user doesn't respond.
 */
async function processExpiredDelays() {
  try {
    // Get settings to check execution mode
    const settings = await getSettingsSafe();

    // Only auto-execute in 'safe' mode (which has delays)
    if (!settings || settings.execution_mode !== 'safe') {
      return;
    }

    const now = new Date();

    // Find ALL pending executions with expired delays
    // Both ENTRY and EXIT orders auto-execute when delay expires
    const expiredExecutions = await prisma.execution.findMany({
      where: {
        status: 'pending',
        delay_expires_at: {
          lte: now // delay_expires_at <= now (expired)
        }
      }
    });

    if (expiredExecutions.length === 0) {
      return;
    }

    console.log(`⏰ Found ${expiredExecutions.length} expired delay(s) - auto-executing...`);

    for (const execution of expiredExecutions) {
      try {
        // In safe mode, check if linked intent is approved before executing
        if (execution.intent_id) {
          const linkedIntent = await prisma.tradeIntent.findUnique({
            where: { id: execution.intent_id }
          });

          // If intent exists but is NOT approved (swiped_on), skip execution
          if (linkedIntent && linkedIntent.status !== 'swiped_on') {
            console.log(`   ⏸️ Skipping ${execution.ticker} - awaiting approval (intent status: ${linkedIntent.status})`);
            continue; // Skip this execution, check again next cycle
          }
        }

        // Forward to broker
        const brokerResult = await forwardToBroker(execution);

        // Update execution status
        await prisma.execution.update({
          where: { id: execution.id },
          data: {
            status: 'executed',
            executed_at: new Date(),
            error_message: brokerResult.success ? null : brokerResult.error
          }
        });

        // Create or update position
        const existingPosition = await prisma.position.findFirst({
          where: {
            ticker: execution.ticker,
            closed_at: null
          }
        });

        if (existingPosition) {
          const newQuantity = execution.order_action === 'buy'
            ? existingPosition.quantity + execution.quantity
            : existingPosition.quantity - execution.quantity;

          if (newQuantity === 0) {
            await prisma.position.update({
              where: { id: existingPosition.id },
              data: { closed_at: new Date() }
            });
          } else {
            await prisma.position.update({
              where: { id: existingPosition.id },
              data: { quantity: newQuantity }
            });
          }
        } else {
          await prisma.position.create({
            data: {
              ticker: execution.ticker,
              side: execution.order_action === 'buy' ? 'Long' : 'Short',
              quantity: execution.quantity,
              entry_price: execution.limit_price || '0'
            }
          });
        }

        // Create audit log
        await prisma.auditLog.create({
          data: {
            event_type: 'execution_auto_completed',
            ticker: execution.ticker,
            details: JSON.stringify({
              execution_id: execution.id,
              order_action: execution.order_action,
              quantity: execution.quantity,
              broker_forwarded: brokerResult.success,
              broker_error: brokerResult.error || null,
              trigger: 'delay_expired'
            })
          }
        });

        console.log(`   ✅ Auto-executed: ${execution.ticker} ${execution.order_action} ${execution.quantity}`);
        if (brokerResult.success) {
          console.log(`      📤 Forwarded to broker successfully`);
        } else if (brokerResult.error) {
          console.log(`      ⚠️ Broker forward failed: ${brokerResult.error}`);
        }

        // Send email notification for order executed
        EmailNotifications.orderExecuted(execution.ticker, {
          action: execution.order_action,
          side: execution.dir,
          quantity: execution.quantity,
          limit_price: execution.limit_price,
          status: 'executed',
          broker_result: brokerResult.success ? 'forwarded' : 'failed',
          trigger: 'delay_expired'
        }).catch(err => console.error('Email notification error:', err));

      } catch (execError: any) {
        console.error(`   ❌ Failed to auto-execute ${execution.id}:`, execError.message);

        // Mark as failed
        await prisma.execution.update({
          where: { id: execution.id },
          data: {
            status: 'failed',
            error_message: execError.message
          }
        });
      }
    }

  } catch (error: any) {
    console.error('❌ Execution scheduler error:', error.message);
  }
}

/**
 * Start the execution scheduler
 * Runs every 10 seconds to check for expired delays
 */
export function startExecutionScheduler() {
  if (schedulerInterval) {
    console.log('⚠️ Execution scheduler already running');
    return;
  }

  console.log('🕐 Starting execution scheduler (checks every 10 seconds)');

  // Run immediately on start
  processExpiredDelays();

  // Then run every 10 seconds
  schedulerInterval = setInterval(processExpiredDelays, 10 * 1000);
}

/**
 * Stop the execution scheduler
 */
export function stopExecutionScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🛑 Execution scheduler stopped');
  }
}
