import { prisma } from '../index';
import { forwardToBroker } from './brokerWebhook';
import { EmailNotifications } from './emailService';
import { PushoverNotifications } from './pushoverService';

// Smart scheduler state: two modes
// IDLE  — cheap COUNT query every 60s (near-zero CPU when no trades active)
// ACTIVE — full logic every 10s (when pending orders or blocked tickers exist)
type SchedulerMode = 'idle' | 'active';
let currentMode: SchedulerMode = 'idle';
let activeInterval: NodeJS.Timeout | null = null; // 10s full tick
let idleInterval: NodeJS.Timeout | null = null;   // 60s heartbeat

/**
 * Quick check: does the DB have any pending orders or blocked tickers?
 * Two cheap COUNT queries — used to decide idle vs active mode.
 */
async function checkHasPendingWork(): Promise<boolean> {
  const [pendingCount, blockedCount] = await Promise.all([
    prisma.execution.count({ where: { status: 'pending' } }),
    prisma.tickerConfig.count({ where: { blocked_until: { not: null } } })
  ]);
  return pendingCount > 0 || blockedCount > 0;
}

/**
 * Switch to ACTIVE mode (10s ticks).
 * Called by webhookController when a pending execution is created,
 * and internally when idle heartbeat detects pending work.
 * Safe to call multiple times — guards against double-start.
 */
export function activateScheduler(): void {
  if (activeInterval) return; // already active, nothing to do

  // Stop idle heartbeat before going active
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }

  currentMode = 'active';
  console.log('⚡ Execution scheduler ACTIVE (10s ticks)');

  // Run immediately, then every 10 seconds
  runSchedulerTick();
  activeInterval = setInterval(runSchedulerTick, 10 * 1000);
}

/**
 * Switch to IDLE mode (60s heartbeat).
 * Only the scheduler itself calls this — after a tick finds no more work.
 */
function deactivateToIdle(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }

  currentMode = 'idle';
  console.log('💤 Execution scheduler IDLE (60s heartbeat)');

  // Safety heartbeat: re-activate if work appears (catches any missed webhook activations)
  idleInterval = setInterval(async () => {
    try {
      const hasPending = await checkHasPendingWork();
      if (hasPending) {
        console.log('🔔 Idle heartbeat detected pending work — activating scheduler');
        activateScheduler();
      }
    } catch (err: any) {
      console.error('❌ Idle heartbeat check error:', err.message);
    }
  }, 60 * 1000);
}

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

        // For EXIT signals: verify an open position exists BEFORE calling broker.
        // This prevents phantom exit orders reaching the broker when no position is tracked.
        if (isExitSignal) {
          const openPosition = await prisma.position.findFirst({
            where: { ticker: execution.ticker, closed_at: null }
          });
          if (!openPosition) {
            console.error(`❌ EXIT for ${execution.ticker} blocked — no open position tracked, skipping broker call`);
            await prisma.execution.update({
              where: { id: execution.id },
              data: {
                status: 'failed',
                error_message: 'No open position found — EXIT blocked before broker'
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
          // Position math must account for side:
          //   Long position:  buy = add, sell = reduce
          //   Short position: sell = add (adding to short), buy = reduce (covering)
          const isLong = existingPosition.side === 'Long';
          const newQuantity = isLong
            ? (execution.order_action === 'buy'
                ? existingPosition.quantity + execution.quantity
                : existingPosition.quantity - execution.quantity)
            : (execution.order_action === 'sell'
                ? existingPosition.quantity + execution.quantity
                : existingPosition.quantity - execution.quantity);

          if (newQuantity <= 0) {
            // Full close (or over-close — treat as closed)
            await prisma.position.update({
              where: { id: existingPosition.id },
              data: { closed_at: new Date() }
            });

            // Block ticker for 5 minutes after close
            const blockUntil = new Date(Date.now() + 5 * 60 * 1000);
            await prisma.tickerConfig.upsert({
              where: { ticker: execution.ticker },
              update: { blocked_until: blockUntil },
              create: { ticker: execution.ticker, enabled: true, blocked_until: blockUntil }
            });
          } else {
            // Partial close or add to position
            await prisma.position.update({
              where: { id: existingPosition.id },
              data: { quantity: newQuantity }
            });
          }
        } else {
          // Entry order — create new position
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

        // Send notifications for order executed (entries only — EXIT notifications fire on signal receipt)
        if (!isExitSignal) {
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
 * Check for tickers with short cooldown blocks that have expired (e.g. 5-min post-position-close).
 * Swipe-off blocks have no timer (blocked_until = null) and are only cleared by daily reset or manual revive.
 */
async function processExpiredBlocks() {
  try {
    const now = new Date();

    // Only find tickers with an explicit blocked_until that has passed (cooldown blocks)
    const expiredBlocks = await prisma.tickerConfig.findMany({
      where: {
        enabled: false,
        blocked_until: {
          not: null,
          lte: now
        }
      }
    });

    if (expiredBlocks.length === 0) {
      return;
    }

    console.log(`🔓 Found ${expiredBlocks.length} expired cooldown block(s) - auto-unblocking...`);

    for (const ticker of expiredBlocks) {
      await prisma.tickerConfig.update({
        where: { ticker: ticker.ticker },
        data: {
          enabled: true,
          blocked_until: null
        }
      });

      await prisma.auditLog.create({
        data: {
          event_type: 'ticker_auto_unblocked',
          ticker: ticker.ticker,
          details: JSON.stringify({
            reason: 'Cooldown block expired',
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
 * Combined scheduler tick — runs all periodic checks.
 * After processing, checks if any work remains.
 * If nothing is left, drops back to IDLE mode automatically.
 */
async function runSchedulerTick() {
  await processExpiredDelays();
  await processExpiredBlocks();

  // Only check for deactivation when in active mode
  if (currentMode === 'active') {
    try {
      const hasPending = await checkHasPendingWork();
      if (!hasPending) {
        deactivateToIdle();
      }
    } catch (err: any) {
      console.error('❌ Work check error after tick:', err.message);
      // On error, stay active (safe fallback)
    }
  }
}

/**
 * Start the execution scheduler.
 * Checks DB on startup — activates immediately if pending work exists,
 * otherwise starts in idle heartbeat mode.
 */
export async function startExecutionScheduler(): Promise<void> {
  console.log('🕐 Starting execution scheduler (smart idle/active mode)');

  try {
    const hasPending = await checkHasPendingWork();
    if (hasPending) {
      console.log('📋 Pending work found on startup — starting in ACTIVE mode');
      activateScheduler();
    } else {
      deactivateToIdle();
    }
  } catch (err: any) {
    console.error('❌ Startup work check failed — defaulting to ACTIVE mode:', err.message);
    activateScheduler(); // Safe fallback: active is always correct, just uses more CPU
  }
}

/**
 * Stop the execution scheduler entirely (used on graceful shutdown).
 */
export function stopExecutionScheduler(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
  currentMode = 'idle';
  console.log('🛑 Execution scheduler stopped');
}
