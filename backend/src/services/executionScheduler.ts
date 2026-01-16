import { prisma } from '../index';
import { forwardToBroker } from './brokerWebhook';

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Check for pending executions with expired delays and auto-execute them
 */
async function processExpiredDelays() {
  try {
    // Get settings to check execution mode
    const settings = await prisma.executionSettings.findFirst();

    // Only auto-execute in 'safe' mode (which has delays)
    if (!settings || settings.execution_mode !== 'safe') {
      return;
    }

    const now = new Date();

    // Find pending executions with expired delays
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
