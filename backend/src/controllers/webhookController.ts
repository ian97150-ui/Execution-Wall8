import { Request, Response } from 'express';
import { prisma } from '../index';

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
    // Create webhook log entry (store raw payload verbatim - immutable truth layer)
    const log = await prisma.webhookLog.create({
      data: {
        source: 'tradingview',
        payload: JSON.stringify(req.body),
        status: 'processing'
      }
    });
    logId = log.id;

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
      // Tick-based pricing fields (for TradingView integer cents workaround)
      price_ticks,        // Integer ticks for price (WALL signals)
      limit_price_ticks,  // Integer ticks for limit_price (ORDER/EXIT signals)
      mintick             // Tick size multiplier (e.g., 0.01)
    } = req.body;

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

    // Determine signal type: "event" field takes priority, then "type"
    // If action (buy/sell) is present without event, infer ORDER
    const signalType = (event || type || (action ? 'ORDER' : 'WALL')).toUpperCase();

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
          raw_payload: req.body
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
          raw_payload: req.body
        });
    }

    // Update webhook log as success
    await prisma.webhookLog.update({
      where: { id: logId },
      data: { status: 'success' }
    });

    console.log(`✅ Webhook processed: ${signalType} ${normalizedTicker} ${normalizedDir || ''}`);

    res.status(200).json({
      success: true,
      type: signalType,
      ...result
    });

  } catch (error: any) {
    console.error('❌ Webhook error:', error.message);

    // Update webhook log with error
    if (logId) {
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'error',
          error: error.message
        }
      }).catch(err => console.error('Failed to update webhook log:', err));
    }

    res.status(400).json({
      success: false,
      error: error.message
    });
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

  // Check if ticker is blocked
  const tickerConfig = await prisma.tickerConfig.findUnique({
    where: { ticker: tickerUpper }
  });

  if (tickerConfig && tickerConfig.enabled === false) {
    console.log(`⚠️ WALL signal rejected: ${tickerUpper} is blocked`);
    return {
      intent_id: null,
      message: `Ticker ${tickerUpper} is blocked - signal rejected`,
      rejected: true
    };
  }

  // Check for existing pending or approved intent for this ticker
  const existingIntent = await prisma.tradeIntent.findFirst({
    where: {
      ticker: tickerUpper,
      status: { in: ['pending', 'swiped_on'] },
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

  // Create audit log
  await prisma.auditLog.create({
    data: {
      event_type: isUpdate ? 'intent_updated' : 'intent_created',
      ticker: tickerUpper,
      details: JSON.stringify({
        intent_id: tradeIntent.id,
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
        gate_vector: gateVector
      })
    }
  });

  return {
    intent_id: tradeIntent.id,
    confidence: finalConfidence,
    gates_hit: finalGatesHit,
    gates_total: finalGatesTotal,
    quality_tier: finalQualityTier,
    updated: isUpdate,
    message: isUpdate ? 'Trade intent updated' : 'Trade intent created - awaiting review'
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

  // Get settings for delay configuration
  const settings = await prisma.executionSettings.findFirst();
  const delayBars = settings?.default_delay_bars || 2;
  const barDuration = settings?.bar_duration_minutes || 5;
  const delayMinutes = delayBars * barDuration;
  const delayExpiresAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  // Create Execution directly
  const execution = await prisma.execution.create({
    data: {
      ticker: ticker.toUpperCase(),
      dir: finalDir,
      order_action: action,
      quantity: quantity || 1,
      limit_price: finalLimitPrice ? finalLimitPrice.toString() : null,
      status: 'pending',
      delay_expires_at: delayExpiresAt,
      raw_payload: orderPayload
    }
  });

  // Create audit log
  await prisma.auditLog.create({
    data: {
      event_type: 'execution_created',
      ticker: ticker.toUpperCase(),
      details: JSON.stringify({
        execution_id: execution.id,
        source: 'webhook',
        type: 'ORDER',
        order_action: action,
        quantity: quantity || 1,
        limit_price: finalLimitPrice,
        quality_tier,
        quality_score
      })
    }
  });

  return {
    execution_id: execution.id,
    message: 'Execution created - pending'
  };
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

  // Find matching open position for this ticker
  const openPosition = await prisma.position.findFirst({
    where: {
      ticker: tickerUpper,
      closed_at: null
    }
  });

  // Check for existing pending exit for this position (duplicate detection)
  // Note: Uses raw_payload parsing since order_type/position_id fields not in schema yet
  let duplicateWarning = null;
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
      duplicateWarning = {
        message: `Duplicate EXIT signal - position ${openPosition.id} already has pending exit`,
        existing_exit_id: existingPendingExit.id,
        existing_exit_created: existingPendingExit.created_at
      };
      console.warn(`⚠️ Duplicate EXIT for ${tickerUpper}: existing pending exit ${existingPendingExit.id}`);

      // Log the duplicate detection
      await prisma.auditLog.create({
        data: {
          event_type: 'duplicate_exit_detected',
          ticker: tickerUpper,
          details: JSON.stringify({
            position_id: openPosition.id,
            existing_exit_id: existingPendingExit.id,
            new_exit_price: limit_price || price,
            new_exit_quantity: quantity
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

  // Get settings for delay configuration
  const settings = await prisma.executionSettings.findFirst();
  const delayBars = settings?.default_delay_bars || 2;
  const barDuration = settings?.bar_duration_minutes || 5;
  const delayMinutes = delayBars * barDuration;
  const delayExpiresAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  // Create Execution for exit
  // Note: order_type and position_id are stored in raw_payload for backwards compatibility
  const execution = await prisma.execution.create({
    data: {
      ticker: tickerUpper,
      dir: exitDir,
      order_action: action,
      quantity: exitQty,
      limit_price: finalLimitPrice ? finalLimitPrice.toString() : null,
      status: 'pending',
      delay_expires_at: delayExpiresAt,
      raw_payload: orderPayload  // Contains event: 'EXIT' and position_id for identification
    }
  });

  // Create audit log
  await prisma.auditLog.create({
    data: {
      event_type: 'exit_created',
      ticker: tickerUpper,
      details: JSON.stringify({
        execution_id: execution.id,
        position_id: openPosition?.id,
        source: 'webhook',
        type: 'EXIT',
        order_action: action,
        quantity: exitQty,
        position_quantity: positionQty,
        limit_price: finalLimitPrice
      })
    }
  });

  return {
    execution_id: execution.id,
    position_id: openPosition?.id,
    position_quantity: positionQty,
    exit_quantity: exitQty,
    message: openPosition
      ? `Exit order created for position ${openPosition.id}`
      : 'Exit order created (no matching position found)',
    ...(duplicateWarning && { warning: duplicateWarning })
  };
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
