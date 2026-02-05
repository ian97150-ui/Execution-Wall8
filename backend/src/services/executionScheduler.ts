import { prisma } from '../index';
import { forwardToBroker } from './brokerWebhook';
import { EmailNotifications } from './emailService';
import { PushoverNotifications } from './pushoverService';

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
        // Check if this is an EXIT signal (bypasses approval requirement)
        let isExitSignal = false;
        if (execution.raw_payload) {
          try {
            const payload = JSON.parse(execution.raw_payload);
            isExitSignal = payload.event === 'EXIT';
          } catch (e) {
            // Invalid JSON, not an exit signal
          }
        }

        // EXIT signals bypass approval - they always execute after delay
        // This is because exits reduce risk (closing positions) and the original entry was already approved
        if (isExitSignal) {
          console.log(`   🚪 EXIT signal for ${execution.ticker} - bypassing approval (auto-execute)`);
          // Skip directly to execution (fall through to execution logic below)
        } else if (execution.intent_id) {
          // Has linked intent - check if it's approved
          const linkedIntent = await prisma.tradeIntent.findUnique({
            where: { id: execution.intent_id }
          });

          // If intent exists but is NOT approved (swiped_on), cancel the execution
          // User didn't approve in time - order expires
          if (linkedIntent && linkedIntent.status !== 'swiped_on') {
            console.log(`   ❌ Cancelling ${execution.ticker} - not approved before delay expired (intent status: ${linkedIntent.status})`);

            // Cancel the execution
            await prisma.execution.update({
              where: { id: execution.id },
              data: {
                status: 'cancelled',
                error_message: 'Order not approved before delay expired'
              }
            });

            // Also cancel/invalidate the linked intent
            await prisma.tradeIntent.update({
              where: { id: execution.intent_id },
              data: {
                status: 'cancelled',
                card_state: 'INVALIDATED'
              }
            });

            // Create audit log
            await prisma.auditLog.create({
              data: {
                event_type: 'execution_expired',
                ticker: execution.ticker,
                details: JSON.stringify({
                  execution_id: execution.id,
                  intent_id: execution.intent_id,
                  reason: 'Not approved before delay expired'
                })
              }
            });

            continue; // Move to next execution
          }
        } else {
          // NO linked intent - check if there's a rejected/blocked intent for this ticker
          // Also check if there's an approved intent we can link to
          const existingIntent = await prisma.tradeIntent.findFirst({
            where: {
              ticker: execution.ticker,
              expires_at: { gt: new Date() }
            },
            orderBy: { updated_at: 'desc' }
          });

          if (existingIntent) {
            if (existingIntent.status === 'swiped_on') {
              // Found an approved intent - link it and continue to execution
              await prisma.execution.update({
                where: { id: execution.id },
                data: { intent_id: existingIntent.id }
              });
              console.log(`   🔗 Late-linked ${execution.ticker} to approved intent ${existingIntent.id}`);
            } else {
              // Intent exists but not approved - cancel
              console.log(`   ❌ Cancelling ${execution.ticker} - found unapproved intent (status: ${existingIntent.status})`);

              await prisma.execution.update({
                where: { id: execution.id },
                data: {
                  status: 'cancelled',
                  error_message: `Order cancelled - intent was ${existingIntent.status}`
                }
              });

              await prisma.auditLog.create({
                data: {
                  event_type: 'execution_cancelled_no_approval',
                  ticker: execution.ticker,
                  details: JSON.stringify({
                    execution_id: execution.id,
                    found_intent_id: existingIntent.id,
                    intent_status: existingIntent.status,
                    reason: 'Found unapproved intent for ticker'
                  })
                }
              });

              continue;
            }
          } else {
            // No intent exists at all - cancel execution (safe mode requires approval)
            console.log(`   ❌ Cancelling ${execution.ticker} - no WALL intent found (safe mode requires approval)`);

            await prisma.execution.update({
              where: { id: execution.id },
              data: {
                status: 'cancelled',
                error_message: 'No approved WALL intent found - safe mode requires approval'
              }
            });

            await prisma.auditLog.create({
              data: {
                event_type: 'execution_cancelled_no_intent',
                ticker: execution.ticker,
                details: JSON.stringify({
                  execution_id: execution.id,
                  reason: 'No WALL intent found - safe mode requires explicit approval'
                })
              }
            });

            continue;
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

        // Send notifications for order executed
        const executedNotificationData = {
          action: execution.order_action,
          side: execution.dir,
          quantity: execution.quantity,
          limit_price: execution.limit_price,
          status: 'executed',
          broker_result: brokerResult.success ? 'forwarded' : 'failed',
          trigger: 'delay_expired'
        };
        EmailNotifications.orderExecuted(execution.ticker, executedNotificationData).catch(err => console.error('Email notification error:', err));
        PushoverNotifications.orderExecuted(execution.ticker, executedNotificationData).catch(err => console.error('Pushover notification error:', err));

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
 * Check for blocked tickers that should be unblocked (blocked_until has passed)
 * Runs as part of the scheduler to auto-reset blocked tickers at end of day
 */
async function processExpiredBlocks() {
  try {
    const now = new Date();

    // Find tickers where blocked_until has passed
    const expiredBlocks = await prisma.tickerConfig.findMany({
      where: {
        enabled: false,
        blocked_until: {
          lte: now // blocked_until <= now (expired)
        }
      }
    });

    if (expiredBlocks.length === 0) {
      return;
    }

    console.log(`🔓 Found ${expiredBlocks.length} expired block(s) - auto-unblocking...`);

    for (const ticker of expiredBlocks) {
      // Re-enable the ticker
      await prisma.tickerConfig.update({
        where: { ticker: ticker.ticker },
        data: {
          enabled: true,
          blocked_until: null
        }
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          event_type: 'ticker_auto_unblocked',
          ticker: ticker.ticker,
          details: JSON.stringify({
            reason: 'Block expired at end of day',
            blocked_until: ticker.blocked_until
          })
        }
      });

      console.log(`   ✅ Auto-unblocked: ${ticker.ticker}`);
    }

  } catch (error: any) {
    console.error('❌ Block expiry check error:', error.message);
  }
}

/**
 * Start the execution scheduler
 * Runs every 10 seconds to check for expired delays
 */
/**
 * Combined scheduler tick - runs all periodic checks
 */
async function runSchedulerTick() {
  await processExpiredDelays();
  await processExpiredBlocks();
}

export function startExecutionScheduler() {
  if (schedulerInterval) {
    console.log('⚠️ Execution scheduler already running');
    return;
  }

  console.log('🕐 Starting execution scheduler (checks every 10 seconds)');

  // Run immediately on start
  runSchedulerTick();

  // Then run every 10 seconds
  schedulerInterval = setInterval(runSchedulerTick, 10 * 1000);
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
