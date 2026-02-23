import { Request, Response } from 'express';
import { prisma } from '../index';
import { acquireSymbolLock, releaseSymbolLock } from '../services/symbolLock';
import { EmailNotifications } from '../services/emailService';
import { PushoverNotifications } from '../services/pushoverService';
import { activateScheduler } from '../services/executionScheduler';

/**
 * Helper to safely get settings without failing on missing columns
 */
async function getSettingsSafe() {
  try {
    return await prisma.executionSettings.findFirst();
  } catch (e: any) {
    // If column doesn't exist (schema mismatch), use raw query for basic fields
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
 * Unified Webhook Handler
 * POST /api/webhook
 *
 * Handles:
 * - WALL signals (candidate cards for review with gate scoring)
 * - ORDER signals (direct execution)
 * - EXIT signals (close position)
 *
 * WALL Payload format (new):
 * {
 *   "event": "WALL",
 *   "ticker": "AAPL",
 *   "dir": "Short",
 *   "price": 189.34,
 *   "strategy_id": "scalper",
 *   "tf": "1m",
 *   "intent": {
 *     "dvtpShortTrig": false,
 *     "shortArmed": false,
 *     ...
 *   },
 *   "gates": {
 *     "rule2_Fire": true,
 *     "Ovr60": true,
 *     ...
 *   }
 * }
 */
export async function handleWebhook(req: Request, res: Response) {
  let logId: string | undefined;

  try {
    // CRITICAL: TradingView has a 3-second timeout. We must respond FAST.
    // Step 1: Quick write to database (acknowledge receipt)
    const log = await prisma.webhookLog.create({
      data: {
        source: 'tradingview',
        payload: JSON.stringify(req.body),
        status: 'processing'
      }
    });
    logId = log.id;

    // Step 2: Extract minimal info for immediate response
    const { event, type, ticker, symbol, action } = req.body;
    const normalizedTicker = ticker || symbol || 'UNKNOWN';
    const signalType = (event || type || (action ? 'ORDER' : 'WALL')).toUpperCase();

    // Step 3: IMMEDIATELY acknowledge receipt to TradingView (before processing)
    // This prevents the 3-second timeout from dropping webhooks
    res.status(200).json({
      success: true,
      received: true,
      log_id: logId,
      type: signalType,
      ticker: normalizedTicker,
      message: 'Webhook received, processing asynchronously'
    });

    // Step 4: Process webhook asynchronously (after response sent)
    // Use setImmediate to ensure response is flushed first
    setImmediate(async () => {
      try {
        await processWebhookAsync(req.body, logId!);
      } catch (error: any) {
        console.error(`❌ Async webhook processing error for ${logId}:`, error.message);
        // Update log with error
        await prisma.webhookLog.update({
          where: { id: logId },
          data: { status: 'error', error: error.message }
        }).catch(e => console.error('Failed to update webhook log:', e));
      }
    });

    return; // Response already sent

  } catch (error: any) {
    console.error('❌ Webhook receive error:', error.message);

    // Only send error response if we haven't already responded
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
}

/**
 * Async webhook processor - runs after immediate acknowledgment
 * This contains all the heavy processing that was causing timeouts
 */
async function processWebhookAsync(body: any, logId: string) {
  try {
    const {
      // New WALL format fields
      event,
      ticker,
      symbol,  // TradingView alternative for ticker
      dir,
      action,  // TradingView alternative for dir (buy/sell)
      price,
      strategy_id,
      tf,
      intent,
      gates,
      // Legacy/ORDER fields
      type,
      limit_price,
      quantity,
      order_action,
      // Legacy quality fields (still supported for backwards compat)
      quality_tier,
      quality_score,
      gates_hit,
      gates_total,
      primary_blocker,
      card_state,
      // Stop loss fields
      stop_price,         // Price at which stop loss was triggered (SL_HIT signals)
      // Tick-based pricing fields (for TradingView integer cents workaround)
      price_ticks,        // Integer ticks for price (WALL signals)
      limit_price_ticks,  // Integer ticks for limit_price (ORDER/EXIT signals)
      mintick             // Tick size multiplier (e.g., 0.01)
    } = body;

    // Helper: Reconstruct price from ticks: limitPx = ticks * mintick
    const reconstructPrice = (
      ticks: number | undefined,
      mintickValue: number | undefined,
      fallbackPrice: number | undefined
    ): number => {
      if (ticks !== undefined && mintickValue !== undefined && mintickValue > 0) {
        return ticks * mintickValue;
      }
      return fallbackPrice || 0;
    };

    // Normalize prices - prefer tick-based reconstruction, fall back to direct values
    const normalizedPrice = reconstructPrice(price_ticks, mintick, price);
    const normalizedLimitPrice = reconstructPrice(limit_price_ticks, mintick, limit_price);

    // Normalize TradingView format to internal format
    // symbol -> ticker, action -> dir, infer event from action
    const normalizedTicker = ticker || symbol;
    const normalizedDir = dir || (action === 'sell' ? 'Short' : action === 'buy' ? 'Long' : null);
    const normalizedAction = order_action || action;

    // Step 1: Validation - verify required fields
    if (!normalizedTicker) {
      throw new Error('Missing required field: ticker or symbol');
    }

    // event is required — reject payloads that omit it to prevent misclassification
    if (!event && !type) {
      throw new Error('Missing required field: event (must be WALL, ORDER, EXIT, or SL_HIT)');
    }

    // Determine signal type from event field (no inference fallback)
    const signalType = (event || type).toUpperCase();

    // Validate event is a known type
    const validEventTypes = ['WALL', 'SIGNAL', 'ORDER', 'EXIT', 'SL_HIT'];
    if (!validEventTypes.includes(signalType)) {
      throw new Error(`Unknown event type: "${signalType}". Must be one of: ${validEventTypes.join(', ')}`);
    }

    // Validate event type
    if (signalType === 'WALL' || signalType === 'SIGNAL') {
      if (!normalizedTicker || !tf || !normalizedDir) {
        // Log validation warning but continue (be lenient)
        console.warn(`⚠️ WALL signal missing recommended fields: ticker=${normalizedTicker}, tf=${tf}, dir=${normalizedDir}`);
      }
    }

    let result: any;

    switch (signalType) {
      case 'WALL':
      case 'SIGNAL':
        // Create a candidate card for review
        result = await handleWallSignal({
          ticker: normalizedTicker,
          dir: normalizedDir,
          price: normalizedPrice,  // Use reconstructed price (from ticks or direct)
          strategy_id,
          tf,
          intent,
          gates,
          // Legacy fields (for backwards compatibility)
          quality_tier,
          quality_score,
          gates_hit,
          gates_total,
          primary_blocker,
          card_state,
          limit_price: normalizedLimitPrice,  // Use reconstructed limit price
          raw_payload: body
        });
        break;

      case 'ORDER':
      case 'ENTRY':
        // Create direct execution (bypasses review)
        result = await handleOrderSignal({
          ticker: normalizedTicker,
          dir: normalizedDir,
          price: normalizedPrice,  // Use reconstructed price
          limit_price: normalizedLimitPrice,  // Use reconstructed limit price (from ticks or direct)
          quantity,
          order_action: normalizedAction,
          quality_tier,
          quality_score
        });
        break;

      case 'EXIT':
        // Handle exit/close position signal
        result = await handleExitSignal({
          ticker: normalizedTicker,
          dir: normalizedDir,
          price: normalizedPrice,  // Use reconstructed price
          limit_price: normalizedLimitPrice,  // Use reconstructed limit price
          quantity
        });
        break;

      case 'SL_HIT':
      case 'STOPLOSS':
        // Handle broker-side stop loss hit — close position locally, no broker order
        result = await handleStopLossHit({
          ticker: normalizedTicker,
          stop_price: stop_price ? parseFloat(stop_price) : undefined
        });
        break;

      default:
        // Default to WALL signal if type not specified
        result = await handleWallSignal({
          ticker: normalizedTicker,
          dir: normalizedDir,
          price: normalizedPrice,  // Use reconstructed price
          strategy_id,
          tf,
          intent,
          gates,
          quality_tier,
          quality_score,
          gates_hit,
          gates_total,
          primary_blocker,
          card_state,
          limit_price: normalizedLimitPrice,  // Use reconstructed limit price
          raw_payload: body
        });
    }

    // Update webhook log as success (response already sent)
    await prisma.webhookLog.update({
      where: { id: logId },
      data: { status: 'success' }
    });

    console.log(`✅ Webhook processed: ${signalType} ${normalizedTicker} ${normalizedDir || ''} (log: ${logId})`);

  } catch (error: any) {
    console.error('❌ Async webhook processing error:', error.message);

    // Update webhook log with error (response already sent, so just log)
    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'error',
        error: error.message
      }
    }).catch(err => console.error('Failed to update webhook log:', err));
  }
}

/**
 * Gate Scoring Engine
 * Converts gates object into numerical vector and calculates confidence score
 */
function calculateGateScore(gates: Record<string, boolean> | undefined): {
  gatesHit: number;
  gatesTotal: number;
  confidence: number;
  gateVector: Record<string, number>;
} {
  if (!gates || typeof gates !== 'object') {
    return { gatesHit: 0, gatesTotal: 0, confidence: 0, gateVector: {} };
  }

  const gateVector: Record<string, number> = {};
  let gatesHit = 0;
  let gatesTotal = 0;

  for (const [key, value] of Object.entries(gates)) {
    gatesTotal++;
    const numericValue = value === true ? 1 : 0;
    gateVector[key] = numericValue;
    gatesHit += numericValue;
  }

  const confidence = gatesTotal > 0 ? gatesHit / gatesTotal : 0;

  return { gatesHit, gatesTotal, confidence, gateVector };
}

/**
 * Derive quality tier from confidence score
 */
function deriveQualityTier(confidence: number): string {
  if (confidence >= 0.9) return 'A+';
  if (confidence >= 0.8) return 'A';
  if (confidence >= 0.7) return 'B';
  if (confidence >= 0.6) return 'C';
  return 'D';
}

/**
 * Handle WALL signal - creates or updates a candidate card for review
 *
 * Design rules:
 * - Never reinterpret raw fields. Only derive new fields.
 * - If ticker already has a pending/approved intent, UPDATE it instead of creating duplicate
 * - If ticker is blocked (swiped_off), reject the signal
 */
async function handleWallSignal(data: {
  ticker: string;
  dir?: string;
  price?: number;
  strategy_id?: string;
  tf?: string;
  intent?: Record<string, any>;
  gates?: Record<string, boolean>;
  // Legacy fields
  quality_tier?: string;
  quality_score?: number;
  gates_hit?: number;
  gates_total?: number;
  primary_blocker?: string;
  card_state?: string;
  limit_price?: number;
  raw_payload?: any;
}) {
  const {
    ticker,
    dir,
    price,
    strategy_id,
    tf,
    intent,
    gates,
    quality_tier,
    quality_score,
    gates_hit: legacyGatesHit,
    gates_total: legacyGatesTotal,
    primary_blocker,
    card_state,
    limit_price,
    raw_payload
  } = data;

  if (!dir) {
    throw new Error('Missing required field: dir (Long/Short)');
  }
  if (dir !== 'Long' && dir !== 'Short') {
    throw new Error(`Invalid direction: ${dir}. Must be "Long" or "Short"`);
  }

  const tickerUpper = ticker.toUpperCase();

  // Try to acquire symbol lock to prevent duplicate cards from race conditions
  // Lock TTL: 3 seconds - prevents double webhooks arriving simultaneously
  if (!acquireSymbolLock(tickerUpper, 'wall', 3000)) {
    console.warn(`⚠️ Duplicate WALL signal blocked for ${tickerUpper} - symbol locked`);
    return {
      intent_id: null,
      message: `Duplicate WALL signal blocked for ${tickerUpper} - please wait`,
      rejected: true
    };
  }

  // Check if ticker is blocked
  const tickerConfig = await prisma.tickerConfig.findUnique({
    where: { ticker: tickerUpper }
  });

  if (tickerConfig && (
    tickerConfig.enabled === false ||
    tickerConfig.alerts_blocked === true ||
    (tickerConfig.blocked_until && new Date(tickerConfig.blocked_until) > new Date())
  )) {
    const reason = tickerConfig.alerts_blocked ? 'alerts blocked'
      : tickerConfig.blocked_until && new Date(tickerConfig.blocked_until) > new Date() ? 'temporarily blocked'
      : 'ticker disabled';
    console.log(`⚠️ WALL signal rejected: ${tickerUpper} (${reason})`);
    return {
      intent_id: null,
      message: `Ticker ${tickerUpper} is blocked - signal rejected (${reason})`,
      rejected: true
    };
  }

  // Check for existing pending, approved, or cancelled intent for this ticker
  // Include 'cancelled' to prevent duplicates when a card was invalidated but not expired
  const existingIntent = await prisma.tradeIntent.findFirst({
    where: {
      ticker: tickerUpper,
      status: { in: ['pending', 'swiped_on', 'cancelled'] },
      expires_at: { gt: new Date() }
    },
    orderBy: { created_date: 'desc' }
  });

  // Step 2: Normalization - derive gate scoring from gates object
  const { gatesHit, gatesTotal, confidence, gateVector } = calculateGateScore(gates);

  // Use computed gates if available, otherwise fall back to legacy fields
  const finalGatesHit = gatesTotal > 0 ? gatesHit : (legacyGatesHit || 0);
  const finalGatesTotal = gatesTotal > 0 ? gatesTotal : (legacyGatesTotal || 0);
  const finalConfidence = gatesTotal > 0 ? confidence :
    (legacyGatesTotal && legacyGatesHit ? legacyGatesHit / legacyGatesTotal : 0);

  // Derive quality from confidence (or use legacy values)
  const finalQualityScore = quality_score ?? Math.round(finalConfidence * 100);
  const finalQualityTier = quality_tier ?? deriveQualityTier(finalConfidence);

  let tradeIntent;
  let isUpdate = false;

  if (existingIntent) {
    // UPDATE existing intent with new data
    tradeIntent = await prisma.tradeIntent.update({
      where: { id: existingIntent.id },
      data: {
        dir,
        price: (limit_price || price || 0).toString(),
        strategy_id: strategy_id || existingIntent.strategy_id,
        timeframe: tf || existingIntent.timeframe,
        gates_hit: finalGatesHit,
        gates_total: finalGatesTotal,
        confidence: finalConfidence,
        quality_tier: finalQualityTier,
        quality_score: finalQualityScore,
        card_state: card_state || existingIntent.card_state,
        primary_blocker: primary_blocker || null,
        intent_data: intent ? JSON.stringify(intent) : existingIntent.intent_data,
        gates_data: gates ? JSON.stringify(gates) : existingIntent.gates_data,
        raw_payload: raw_payload ? JSON.stringify(raw_payload) : existingIntent.raw_payload,
        // Extend expiry on update
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
    isUpdate = true;
    console.log(`🔄 Updated existing intent for ${tickerUpper} (id: ${tradeIntent.id})`);
  } else {
    // CREATE new intent
    tradeIntent = await prisma.tradeIntent.create({
      data: {
        ticker: tickerUpper,
        dir,
        price: (limit_price || price || 0).toString(),
        strategy_id: strategy_id || null,
        timeframe: tf || null,
        gates_hit: finalGatesHit,
        gates_total: finalGatesTotal,
        confidence: finalConfidence,
        quality_tier: finalQualityTier,
        quality_score: finalQualityScore,
        card_state: card_state || 'ARMED',
        status: 'pending',
        primary_blocker: primary_blocker || null,
        intent_data: intent ? JSON.stringify(intent) : null,
        gates_data: gates ? JSON.stringify(gates) : null,
        raw_payload: raw_payload ? JSON.stringify(raw_payload) : null,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
    console.log(`✨ Created new intent for ${tickerUpper} (id: ${tradeIntent.id})`);
  }

  // Check if execution already exists for this ticker (ORDER arrived before WALL)
  // Auto-link and approve if found
  let linkedExecutionId: string | null = null;
  const existingExecution = await prisma.execution.findFirst({
    where: {
      ticker: tickerUpper,
      intent_id: null,  // Not yet linked to any intent
      status: { in: ['pending', 'executing', 'executed'] },
      created_at: { gte: new Date(Date.now() - 60 * 60 * 1000) }  // Within last hour
    },
    orderBy: { created_at: 'desc' }
  });

  if (existingExecution) {
    // Link execution to this intent and auto-approve
    await prisma.execution.update({
      where: { id: existingExecution.id },
      data: { intent_id: tradeIntent.id }
    });

    // Only auto-approve in full mode - in safe mode, user must approve
    const settings = await getSettingsSafe();
    const isFullMode = settings?.execution_mode === 'full';

    if (isFullMode) {
      await prisma.tradeIntent.update({
        where: { id: tradeIntent.id },
        data: { status: 'swiped_on' }
      });
      console.log(`🔗 Auto-linked and auto-approved WALL intent (full mode)`);
    } else {
      console.log(`🔗 Linked WALL intent to ORDER - awaiting user approval (safe mode)`);
    }

    linkedExecutionId = existingExecution.id;
  }

  // Create audit log
  await prisma.auditLog.create({
    data: {
      event_type: isUpdate ? 'intent_updated' : 'intent_created',
      ticker: tickerUpper,
      details: JSON.stringify({
        intent_id: tradeIntent.id,
        execution_id: linkedExecutionId,
        source: 'webhook',
        type: 'WALL',
        is_update: isUpdate,
        strategy_id,
        timeframe: tf,
        gates_hit: finalGatesHit,
        gates_total: finalGatesTotal,
        confidence: finalConfidence,
        quality_tier: finalQualityTier,
        quality_score: finalQualityScore,
        price: tradeIntent.price,
        gate_vector: gateVector,
        auto_linked: !!linkedExecutionId
      })
    }
  });

  // Check if user already holds a position in this ticker - skip email if so
  const existingPosition = await prisma.position.findFirst({
    where: {
      ticker: tickerUpper,
      closed_at: null
    }
  });

  // Send notifications for WALL signal (only if no existing position)
  if (!existingPosition) {
    const wallNotificationData = {
      action: isUpdate ? 'Updated' : 'Created',
      side: dir,
      price: tradeIntent.price,
      strategy: strategy_id || 'N/A',
      timeframe: tf || 'N/A',
      gates_hit: `${finalGatesHit}/${finalGatesTotal}`,
      confidence: `${Math.round(finalConfidence * 100)}%`,
      quality_tier: finalQualityTier,
      status: linkedExecutionId ? 'Auto-linked to ORDER' : 'Awaiting review',
      auto_linked: linkedExecutionId ? 'Yes' : 'No'
    };
    EmailNotifications.wallSignal(tickerUpper, wallNotificationData).catch(err => console.error('Email notification error:', err));
    PushoverNotifications.wallSignal(tickerUpper, wallNotificationData).catch(err => console.error('Pushover notification error:', err));
  } else {
    console.log(`📧 Skipping WALL notifications for ${tickerUpper} - user already holds position`);
  }

  return {
    intent_id: tradeIntent.id,
    execution_id: linkedExecutionId,
    confidence: finalConfidence,
    gates_hit: finalGatesHit,
    gates_total: finalGatesTotal,
    quality_tier: finalQualityTier,
    updated: isUpdate,
    auto_linked: !!linkedExecutionId,
    message: linkedExecutionId
      ? `Trade intent auto-approved - linked to existing execution ${linkedExecutionId}`
      : (isUpdate ? 'Trade intent updated' : 'Trade intent created - awaiting review')
  };
}

/**
 * Handle ORDER signal - creates direct execution (bypasses review)
 */
async function handleOrderSignal(data: {
  ticker: string;
  dir?: string;
  price?: number;
  limit_price?: number;
  quantity?: number;
  order_action?: string;
  quality_tier?: string;
  quality_score?: number;
  raw_payload?: any;
}) {
  const {
    ticker,
    dir,
    price,
    limit_price,
    quantity,
    order_action,
    quality_tier,
    quality_score,
    raw_payload
  } = data;

  const tickerUpper = ticker.toUpperCase();

  // Try to acquire symbol lock to prevent duplicate orders from race conditions
  // Lock TTL: 3 seconds - prevents double webhooks arriving simultaneously
  if (!acquireSymbolLock(tickerUpper, 'order', 3000)) {
    console.warn(`⚠️ Duplicate ORDER signal blocked for ${tickerUpper} - symbol locked`);
    return {
      execution_id: null,
      message: `Duplicate order blocked - ${tickerUpper} is currently being processed`,
      blocked: true,
      reason: 'symbol_locked'
    };
  }

  // Check if ticker is temporarily blocked (e.g. after SL_HIT, EXIT, or mark-flat)
  const tickerConfigForOrder = await prisma.tickerConfig.findUnique({
    where: { ticker: tickerUpper }
  });

  if (tickerConfigForOrder && (
    tickerConfigForOrder.enabled === false ||
    (tickerConfigForOrder.blocked_until && new Date(tickerConfigForOrder.blocked_until) > new Date())
  )) {
    const reason = tickerConfigForOrder.blocked_until && new Date(tickerConfigForOrder.blocked_until) > new Date()
      ? 'temporarily blocked' : 'ticker disabled';
    console.warn(`⚠️ ORDER signal blocked for ${tickerUpper} - ${reason}`);
    releaseSymbolLock(tickerUpper, 'order');
    return {
      execution_id: null,
      message: `Order blocked - ${tickerUpper} is ${reason}`,
      blocked: true,
      reason: 'ticker_blocked'
    };
  }

  // Check for existing open position - block new entry orders if position already exists
  const existingOpenPosition = await prisma.position.findFirst({
    where: {
      ticker: tickerUpper,
      closed_at: null
    }
  });

  if (existingOpenPosition) {
    console.warn(`⚠️ ORDER signal blocked for ${tickerUpper} - open position already exists (id: ${existingOpenPosition.id})`);
    releaseSymbolLock(tickerUpper, 'order');
    return {
      execution_id: null,
      message: `Order blocked - ${tickerUpper} already has an open position`,
      blocked: true,
      reason: 'position_exists',
      existing_position: {
        id: existingOpenPosition.id,
        side: existingOpenPosition.side,
        quantity: existingOpenPosition.quantity
      }
    };
  }

  // Check for existing pending/executing order - block duplicate entry orders
  const existingPendingExecution = await prisma.execution.findFirst({
    where: {
      ticker: tickerUpper,
      status: { in: ['pending', 'executing'] }
    },
    orderBy: { created_at: 'desc' }
  });

  if (existingPendingExecution) {
    console.warn(`⚠️ ORDER signal blocked for ${tickerUpper} - pending execution already exists (id: ${existingPendingExecution.id})`);
    releaseSymbolLock(tickerUpper, 'order');
    return {
      execution_id: null,
      message: `Order blocked - ${tickerUpper} already has a pending order`,
      blocked: true,
      reason: 'pending_execution_exists',
      existing_execution: {
        id: existingPendingExecution.id,
        order_action: existingPendingExecution.order_action,
        quantity: existingPendingExecution.quantity,
        limit_price: existingPendingExecution.limit_price
      }
    };
  }

  // Check if the corresponding WALL intent was denied or swiped off - block the order
  const rejectedIntent = await prisma.tradeIntent.findFirst({
    where: {
      ticker: tickerUpper,
      status: { in: ['swiped_deny', 'swiped_off'] },
      expires_at: { gt: new Date() }  // Only check non-expired intents
    },
    orderBy: { updated_at: 'desc' }
  });

  if (rejectedIntent) {
    const reasonText = rejectedIntent.status === 'swiped_deny' ? 'denied' : 'blocked';
    console.warn(`⚠️ ORDER signal blocked for ${tickerUpper} - intent was ${reasonText} (id: ${rejectedIntent.id})`);
    releaseSymbolLock(tickerUpper, 'order');
    return {
      execution_id: null,
      message: `Order blocked - ${tickerUpper} signal was ${reasonText} by user`,
      blocked: true,
      reason: rejectedIntent.status === 'swiped_deny' ? 'intent_denied' : 'intent_blocked',
      rejected_intent_id: rejectedIntent.id
    };
  }

  try {
    // Determine order action from dir if not provided
    const action = order_action || (dir === 'Long' ? 'buy' : dir === 'Short' ? 'sell' : null);
    if (!action) {
      throw new Error('Missing order_action or dir field');
    }

    const finalDir = dir || (action === 'buy' ? 'Long' : 'Short');
    const finalLimitPrice = limit_price || price || 0;

  // Build raw_payload for broker forwarding (TradingView ORDER format)
  const orderPayload = JSON.stringify({
    event: 'ORDER',
    ticker: ticker.toUpperCase(),
    dir: finalDir,
    price: finalLimitPrice,
    limit_price: finalLimitPrice,
    quantity: quantity || 1,
    order_action: action
  });

  // Get settings for execution mode and delay configuration
  const settings = await getSettingsSafe();
  const executionMode = settings?.execution_mode || 'safe';
  const delayBars = settings?.default_delay_bars || 2;
  const barDuration = settings?.bar_duration_minutes || 1;
  const delayMinutes = delayBars * barDuration;
  const delayExpiresAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  // In "full" mode, execute immediately. In "safe" mode, create pending with delay.
  const isFullMode = executionMode === 'full';

  // Create Execution
  const execution = await prisma.execution.create({
    data: {
      ticker: ticker.toUpperCase(),
      dir: finalDir,
      order_action: action,
      quantity: quantity || 1,
      limit_price: finalLimitPrice ? finalLimitPrice.toString() : null,
      status: isFullMode ? 'executing' : 'pending',
      delay_expires_at: isFullMode ? null : delayExpiresAt,
      raw_payload: orderPayload
    }
  });

  // Wake up the scheduler whenever a pending order is created (safe mode only)
  if (!isFullMode) {
    activateScheduler();
  }

  let brokerResult: { success: boolean; error?: string } = { success: false };

  // In full mode, forward to broker immediately
  if (isFullMode) {
    const { forwardToBroker } = await import('../services/brokerWebhook');
    brokerResult = await forwardToBroker(execution);

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
        ticker: ticker.toUpperCase(),
        closed_at: null
      }
    });

    if (existingPosition) {
      const newQuantity = action === 'buy'
        ? existingPosition.quantity + (quantity || 1)
        : existingPosition.quantity - (quantity || 1);

      if (newQuantity === 0) {
        await prisma.position.update({
          where: { id: existingPosition.id },
          data: { closed_at: new Date() }
        });
      } else if (newQuantity > 0) {
        await prisma.position.update({
          where: { id: existingPosition.id },
          data: { quantity: newQuantity }
        });
      }
    } else {
      await prisma.position.create({
        data: {
          ticker: ticker.toUpperCase(),
          side: action === 'buy' ? 'Long' : 'Short',
          quantity: quantity || 1,
          entry_price: finalLimitPrice ? finalLimitPrice.toString() : '0'
        }
      });
    }

    console.log(`⚡ Full mode: Immediately executed ${tickerUpper} ${action} ${quantity || 1}`);
  }

  // Auto-link to existing TradeIntent if one exists for this ticker
  let linkedIntentId: string | null = null;
  const pendingIntent = await prisma.tradeIntent.findFirst({
    where: {
      ticker: tickerUpper,
      status: { in: ['pending', 'swiped_on'] },
      expires_at: { gt: new Date() }
    },
    orderBy: { created_date: 'desc' }
  });

  if (pendingIntent) {
    // Link execution to intent
    await prisma.execution.update({
      where: { id: execution.id },
      data: { intent_id: pendingIntent.id }
    });

    // Only auto-approve in full mode - in safe mode, user must approve
    if (isFullMode) {
      await prisma.tradeIntent.update({
        where: { id: pendingIntent.id },
        data: { status: 'swiped_on' }
      });
      console.log(`🔗 Linked ORDER to WALL intent and auto-approved (full mode)`);
    } else {
      console.log(`🔗 Linked ORDER to WALL intent - awaiting user approval (safe mode)`);
    }

    linkedIntentId = pendingIntent.id;
  }

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: isFullMode ? 'execution_immediate' : 'execution_created',
        ticker: tickerUpper,
        details: JSON.stringify({
          execution_id: execution.id,
          intent_id: linkedIntentId,
          source: 'webhook',
          type: 'ORDER',
          order_action: action,
          quantity: quantity || 1,
          limit_price: finalLimitPrice,
          quality_tier,
          quality_score,
          mode: executionMode,
          broker_forwarded: isFullMode ? brokerResult.success : null,
          auto_linked: !!linkedIntentId
        })
      }
    });

    // Send notifications for order received
    const orderReceivedData = {
      action,
      side: finalDir,
      quantity: quantity || 1,
      limit_price: finalLimitPrice,
      execution_mode: executionMode,
      auto_linked: linkedIntentId ? 'yes' : 'no',
      broker_result: isFullMode ? (brokerResult.success ? 'forwarded' : 'failed') : 'pending'
    };
    EmailNotifications.orderReceived(tickerUpper, orderReceivedData).catch(err => console.error('Email notification error:', err));
    PushoverNotifications.orderReceived(tickerUpper, orderReceivedData).catch(err => console.error('Pushover notification error:', err));

    // If executed immediately in full mode, also send execution notification
    if (isFullMode && brokerResult.success) {
      const orderExecutedData = {
        action,
        side: finalDir,
        quantity: quantity || 1,
        limit_price: finalLimitPrice,
        status: 'executed'
      };
      EmailNotifications.orderExecuted(tickerUpper, orderExecutedData).catch(err => console.error('Email notification error:', err));
      PushoverNotifications.orderExecuted(tickerUpper, orderExecutedData).catch(err => console.error('Pushover notification error:', err));
    }

    return {
      execution_id: execution.id,
      intent_id: linkedIntentId,
      message: isFullMode
        ? `Execution completed immediately (full mode)${brokerResult.success ? ' - forwarded to broker' : ''}`
        : 'Execution created - pending',
      mode: executionMode,
      broker_forwarded: isFullMode ? brokerResult.success : undefined,
      auto_linked: !!linkedIntentId
    };
  } finally {
    // Always release the lock when done
    releaseSymbolLock(tickerUpper, 'order');
  }
}

/**
 * Handle EXIT signal - close position
 * Exit orders are adverse orders for trades previously opened (manually or via automation)
 */
async function handleExitSignal(data: {
  ticker: string;
  dir?: string;
  price?: number;
  limit_price?: number;
  quantity?: number;
}) {
  const { ticker, dir, price, limit_price, quantity } = data;

  const tickerUpper = ticker.toUpperCase();

  // Try to acquire position_close lock — shared with SL_HIT and mark-flat
  // to prevent race conditions between different close paths
  if (!acquireSymbolLock(tickerUpper, 'position_close', 5000)) {
    console.warn(`⚠️ EXIT signal blocked for ${tickerUpper} - position close in progress`);
    return {
      execution_id: null,
      message: `Exit blocked - ${tickerUpper} position close already in progress`,
      blocked: true,
      reason: 'symbol_locked'
    };
  }

  try {
    // Find matching open position for this ticker
  const openPosition = await prisma.position.findFirst({
    where: {
      ticker: tickerUpper,
      closed_at: null
    }
  });

  // Validate position exists - EXIT signals require an open position
  if (!openPosition) {
    console.warn(`⚠️ EXIT signal rejected: No open position found for ${tickerUpper}`);
    releaseSymbolLock(tickerUpper, 'position_close');
    return {
      execution_id: null,
      message: `No open position found for ${tickerUpper} - EXIT signal rejected`,
      rejected: true,
      reason: 'no_position'
    };
  }

  // Check for existing pending exit and REPLACE it with the new one
  // This ensures the latest exit signal takes precedence
  let replacedExitInfo = null;
  if (openPosition) {
    // Find pending exits for this ticker by parsing raw_payload
    const pendingExits = await prisma.execution.findMany({
      where: {
        ticker: tickerUpper,
        status: 'pending'
      }
    });

    // Check if any pending execution is an EXIT for this position
    const existingPendingExit = pendingExits.find((exec: any) => {
      if (exec.raw_payload) {
        try {
          const payload = JSON.parse(exec.raw_payload);
          return payload.event === 'EXIT' && payload.position_id === openPosition.id;
        } catch (e) {
          return false;
        }
      }
      return false;
    });

    if (existingPendingExit) {
      // Cancel the old exit and replace with new one
      await prisma.execution.update({
        where: { id: existingPendingExit.id },
        data: { status: 'cancelled' }
      });

      replacedExitInfo = {
        cancelled_exit_id: existingPendingExit.id,
        old_price: existingPendingExit.limit_price,
        old_quantity: existingPendingExit.quantity
      };

      console.log(`🔄 Replacing EXIT for ${tickerUpper}: cancelled ${existingPendingExit.id}, creating new exit`);

      // Log the replacement
      await prisma.auditLog.create({
        data: {
          event_type: 'exit_replaced',
          ticker: tickerUpper,
          details: JSON.stringify({
            position_id: openPosition.id,
            cancelled_exit_id: existingPendingExit.id,
            old_price: existingPendingExit.limit_price,
            old_quantity: existingPendingExit.quantity,
            new_price: limit_price || price,
            new_quantity: quantity
          })
        }
      });
    }
  }

  // Determine exit action based on position direction (or provided dir)
  // Exit action is OPPOSITE of position direction
  const positionDir = openPosition?.side || dir;
  const action = positionDir === 'Long' ? 'sell' : positionDir === 'Short' ? 'buy' : 'sell';
  const exitDir = positionDir === 'Long' ? 'Short' : 'Long';
  const finalLimitPrice = limit_price || price || 0;

  // Use position quantity if not specified, or clamp to position quantity
  const positionQty = openPosition?.quantity || quantity || 1;
  const exitQty = quantity ? Math.min(quantity, positionQty) : positionQty;

  // Build raw_payload for broker forwarding (TradingView EXIT/ORDER format)
  const orderPayload = JSON.stringify({
    event: 'EXIT',
    ticker: tickerUpper,
    dir: exitDir,
    price: finalLimitPrice,
    limit_price: finalLimitPrice,
    quantity: exitQty,
    order_action: action,
    position_id: openPosition?.id || null
  });

  // Get settings for execution mode and EXIT-specific delay
  const settings = await getSettingsSafe();
  const executionMode = settings?.execution_mode || 'safe';

  // EXIT signals use their own shorter delay (bypasses normal approval flow)
  // Default: 10 seconds. Can be set to 0 for immediate execution.
  const exitDelaySeconds = (settings as any)?.exit_delay_seconds ?? 10;
  const delayExpiresAt = exitDelaySeconds > 0
    ? new Date(Date.now() + exitDelaySeconds * 1000)
    : null;

  // EXIT signals execute immediately if:
  // 1. Full mode, OR
  // 2. exit_delay_seconds is 0
  const isImmediateExecution = executionMode === 'full' || exitDelaySeconds === 0;

  // Create Execution for exit
  // Note: order_type and position_id are stored in raw_payload for backwards compatibility
  const execution = await prisma.execution.create({
    data: {
      ticker: tickerUpper,
      dir: exitDir,
      order_action: action,
      quantity: exitQty,
      limit_price: finalLimitPrice ? finalLimitPrice.toString() : null,
      status: isImmediateExecution ? 'executing' : 'pending',
      delay_expires_at: isImmediateExecution ? null : delayExpiresAt,
      raw_payload: orderPayload  // Contains event: 'EXIT' and position_id for identification
    }
  });

  // Wake up the scheduler if exit is queued (not immediate)
  if (!isImmediateExecution) {
    activateScheduler();
  }

  // Notify immediately on EXIT signal receipt — before any delay or execution
  const exitReceivedData = {
    action,
    quantity: exitQty,
    limit_price: finalLimitPrice,
    position_side: openPosition.side,
    status: isImmediateExecution ? 'closing' : 'exit_queued',
    exit_delay_seconds: exitDelaySeconds,
    is_signal: true
  };
  EmailNotifications.positionClosed(tickerUpper, exitReceivedData).catch(err => console.error('Email notification error:', err));
  PushoverNotifications.positionClosed(tickerUpper, exitReceivedData).catch(err => console.error('Pushover notification error:', err));

  let brokerResult: { success: boolean; error?: string } = { success: false };

  // Execute immediately if full mode OR exit_delay is 0
  if (isImmediateExecution) {
    const { forwardToBroker } = await import('../services/brokerWebhook');
    brokerResult = await forwardToBroker(execution);

    // Update execution status
    await prisma.execution.update({
      where: { id: execution.id },
      data: {
        status: 'executed',
        executed_at: new Date(),
        error_message: brokerResult.success ? null : brokerResult.error
      }
    });

    // Close position if we have one
    if (openPosition) {
      const newQuantity = openPosition.quantity - exitQty;
      if (newQuantity <= 0) {
        // Full close - mark position as closed
        await prisma.position.update({
          where: { id: openPosition.id },
          data: { closed_at: new Date() }
        });

        // Block ticker for 5 minutes to prevent immediate re-entry
        const blockUntil = new Date(Date.now() + 5 * 60 * 1000);
        await prisma.tickerConfig.upsert({
          where: { ticker: tickerUpper },
          update: { blocked_until: blockUntil },
          create: { ticker: tickerUpper, enabled: true, blocked_until: blockUntil }
        });
        console.log(`🔒 Ticker ${tickerUpper} blocked for 5 minutes after EXIT close`);
      } else {
        // Partial close - reduce quantity
        await prisma.position.update({
          where: { id: openPosition.id },
          data: { quantity: newQuantity }
        });
      }
    }

    console.log(`⚡ Immediately executed EXIT ${tickerUpper} ${action} ${exitQty}`);
  }

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: isImmediateExecution ? 'exit_immediate' : 'exit_created',
        ticker: tickerUpper,
        details: JSON.stringify({
          execution_id: execution.id,
          position_id: openPosition?.id,
          source: 'webhook',
          type: 'EXIT',
          order_action: action,
          quantity: exitQty,
          position_quantity: positionQty,
          limit_price: finalLimitPrice,
          mode: executionMode,
          exit_delay_seconds: exitDelaySeconds,
          broker_forwarded: isImmediateExecution ? brokerResult.success : null
        })
      }
    });

    // If position was closed or partially closed, send notifications
    if (isImmediateExecution && openPosition && brokerResult.success) {
      const newQuantity = openPosition.quantity - exitQty;
      const positionWasClosed = newQuantity <= 0;

      if (positionWasClosed) {
        // Full close notification
        const positionClosedData = {
          action,
          quantity: exitQty,
          limit_price: finalLimitPrice,
          position_side: openPosition.side,
          status: 'closed'
        };
        EmailNotifications.positionClosed(tickerUpper, positionClosedData).catch(err => console.error('Email notification error:', err));
        PushoverNotifications.positionClosed(tickerUpper, positionClosedData).catch(err => console.error('Pushover notification error:', err));
      } else {
        // Partial close notification - use same positionClosed method with partial status
        const partialCloseData = {
          action,
          quantity: exitQty,
          limit_price: finalLimitPrice,
          position_side: openPosition.side,
          status: 'partial',
          remaining_quantity: newQuantity
        };
        EmailNotifications.positionClosed(tickerUpper, partialCloseData).catch(err => console.error('Email notification error:', err));
        PushoverNotifications.positionClosed(tickerUpper, partialCloseData).catch(err => console.error('Pushover notification error:', err));
      }
    }

    return {
      execution_id: execution.id,
      position_id: openPosition?.id,
      position_quantity: positionQty,
      exit_quantity: exitQty,
      message: isImmediateExecution
        ? `Exit executed immediately${brokerResult.success ? ' - forwarded to broker' : ''}`
        : `Exit order queued (${exitDelaySeconds}s delay)`,
      mode: executionMode,
      exit_delay_seconds: exitDelaySeconds,
      broker_forwarded: isImmediateExecution ? brokerResult.success : undefined,
      ...(replacedExitInfo && { replaced: replacedExitInfo })
    };
  } finally {
    // Always release the lock when done
    releaseSymbolLock(tickerUpper, 'position_close');
  }
}

/**
 * Handle SL_HIT signal - broker-side stop loss was triggered
 * The broker has already closed the position, so we only close it locally.
 * No order is forwarded to the broker. Any subsequent EXIT from the main TV
 * strategy will be auto-rejected since no open position exists.
 */
async function handleStopLossHit(data: {
  ticker: string;
  stop_price?: number;
}) {
  const { ticker, stop_price } = data;
  const tickerUpper = ticker.toUpperCase();

  // Acquire position_close lock — shared with EXIT and mark-flat
  // to prevent race conditions between different close paths
  if (!acquireSymbolLock(tickerUpper, 'position_close', 5000)) {
    console.warn(`⚠️ SL_HIT signal blocked for ${tickerUpper} - position close in progress`);
    return {
      message: `SL_HIT blocked - ${tickerUpper} position close already in progress`,
      blocked: true,
      reason: 'symbol_locked'
    };
  }

  try {
    // Find matching open position
    const openPosition = await prisma.position.findFirst({
      where: {
        ticker: tickerUpper,
        closed_at: null
      }
    });

    if (!openPosition) {
      console.warn(`⚠️ SL_HIT rejected: No open position for ${tickerUpper} (may already be closed)`);
      return {
        message: `No open position found for ${tickerUpper} - stop loss may have already been processed`,
        rejected: true,
        reason: 'no_position'
      };
    }

    // All DB writes in a transaction for atomicity — if any fail, all roll back
    const blockUntil = new Date(Date.now() + 5 * 60 * 1000);
    const txResult = await prisma.$transaction(async (tx) => {
      // Close the position locally (broker already closed it)
      await tx.position.update({
        where: { id: openPosition.id },
        data: { closed_at: new Date() }
      });

      // Block ticker for 5 minutes to prevent immediate re-entry
      await tx.tickerConfig.upsert({
        where: { ticker: tickerUpper },
        update: { blocked_until: blockUntil },
        create: { ticker: tickerUpper, enabled: true, blocked_until: blockUntil }
      });

      // Cancel any pending executions for this ticker (stale orders)
      const cancelledExecs = await tx.execution.updateMany({
        where: {
          ticker: tickerUpper,
          status: { in: ['pending', 'executing'] }
        },
        data: { status: 'cancelled' }
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          event_type: 'stop_loss_hit',
          ticker: tickerUpper,
          details: JSON.stringify({
            position_id: openPosition.id,
            side: openPosition.side,
            quantity: openPosition.quantity,
            entry_price: openPosition.entry_price,
            stop_price: stop_price || null,
            blocked_until: blockUntil.toISOString(),
            cancelled_pending_executions: cancelledExecs.count,
            broker_order_sent: false
          })
        }
      });

      return { cancelledExecs: cancelledExecs.count };
    });

    if (txResult.cancelledExecs > 0) {
      console.log(`🗑️ Cancelled ${txResult.cancelledExecs} pending execution(s) for ${tickerUpper} after SL_HIT`);
    }

    console.log(`🛑 SL_HIT: ${tickerUpper} position closed locally (stop @ ${stop_price || 'unknown'}). No broker order sent.`);

    // Send notifications
    const slData = {
      side: openPosition.side,
      quantity: openPosition.quantity,
      entry_price: openPosition.entry_price,
      stop_price: stop_price || null,
      status: 'stop_loss_hit'
    };
    EmailNotifications.positionClosed(tickerUpper, slData).catch(err => console.error('Email notification error:', err));
    PushoverNotifications.positionClosed(tickerUpper, slData).catch(err => console.error('Pushover notification error:', err));

    return {
      position_id: openPosition.id,
      message: `Stop loss hit - ${tickerUpper} position closed locally. Broker already closed it.`,
      stop_price: stop_price || null,
      cancelled_pending_executions: txResult.cancelledExecs,
      broker_order_sent: false
    };
  } finally {
    releaseSymbolLock(tickerUpper, 'position_close');
  }
}

/**
 * Get webhook logs
 * GET /api/webhook/logs
 */
export async function getWebhookLogs(req: Request, res: Response) {
  try {
    const { source, status, limit = 100, offset = 0 } = req.query;

    const where: any = {};
    if (source) where.source = source;
    if (status) where.status = status;

    const logs = await prisma.webhookLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: Number(limit),
      skip: Number(offset)
    });

    const total = await prisma.webhookLog.count({ where });

    res.json({
      logs,
      total,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error: any) {
    console.error('Error fetching webhook logs:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Test webhook endpoint
 * POST /api/webhook/test
 */
export async function testWebhook(req: Request, res: Response) {
  try {
    // Create a test WALL signal with new format
    const testPayload = {
      event: 'WALL',
      ticker: 'TEST',
      dir: 'Long',
      price: 100.00,
      strategy_id: 'test_strategy',
      tf: '1m',
      intent: {
        testMode: 'TEST',
        armed: true
      },
      gates: {
        rule1: true,
        rule2: true,
        rule3: true,
        rule4: false,
        rule5: true
      }
    };

    // Process it through the main handler
    req.body = testPayload;
    await handleWebhook(req, res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
