import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { forwardToBroker } from '../services/brokerWebhook';
import * as XLSX from 'xlsx';

const router = express.Router();

// ─── Excel Export ────────────────────────────────────────────────────────────
// GET /api/executions/export
// Downloads an Excel workbook with 3 sheets:
//   1. All Orders    — full execution history
//   2. Price Ranges  — summary grouped by price bucket
//   3. Indicator Stats — quality/gate data from linked trade intents
router.get('/export', async (req: Request, res: Response) => {
  try {
    // Fetch all executions with linked trade intent for indicator data
    const executions = await prisma.execution.findMany({
      orderBy: { created_at: 'desc' },
      take: 5000
    });

    // Fetch linked intents in one query
    const intentIds = executions
      .map(e => e.intent_id)
      .filter((id): id is string => !!id);

    const intents = intentIds.length > 0
      ? await prisma.tradeIntent.findMany({ where: { id: { in: intentIds } } })
      : [];

    const intentMap = new Map(intents.map(i => [i.id, i]));

    // ── Sheet 1: All Orders ──────────────────────────────────────────────────
    const allOrdersRows = executions.map(e => {
      let isExit = false;
      try { isExit = e.raw_payload ? JSON.parse(e.raw_payload).event === 'EXIT' : false; } catch {}

      const intent = e.intent_id ? intentMap.get(e.intent_id) : null;

      return {
        'Date':          e.created_at ? new Date(e.created_at).toLocaleString() : '',
        'Ticker':        e.ticker,
        'Type':          isExit ? 'EXIT' : 'ENTRY',
        'Direction':     e.dir || '',
        'Action':        (e.order_action || '').toUpperCase(),
        'Quantity':      e.quantity,
        'Price':         e.limit_price ? Number(e.limit_price) : '',
        'Status':        e.status,
        'Executed At':   e.executed_at ? new Date(e.executed_at).toLocaleString() : '',
        'Error':         e.error_message || '',
        // Indicator columns from linked WALL intent
        'Quality Tier':  intent?.quality_tier || '',
        'Quality Score': intent?.quality_score ?? '',
        'Gates Hit':     intent?.gates_hit ?? '',
        'Gates Total':   intent?.gates_total ?? '',
        'Confidence %':  intent ? (intent.confidence * 100).toFixed(1) + '%' : '',
        'Strategy':      intent?.strategy_id || '',
        'Timeframe':     intent?.timeframe || ''
      };
    });

    // ── Sheet 2: Price Ranges ─────────────────────────────────────────────────
    const priceBuckets: Record<string, { total: number; executed: number; cancelled: number; failed: number; pending: number }> = {
      'Under $10':        { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      '$10 – $100':       { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      '$100 – $500':      { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      '$500 – $1,000':    { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      '$1,000 – $5,000':  { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      '$5,000 – $20,000': { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      'Over $20,000':     { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 },
      'No Price':         { total: 0, executed: 0, cancelled: 0, failed: 0, pending: 0 }
    };

    const getBucket = (price: number): string => {
      if (price < 10)      return 'Under $10';
      if (price < 100)     return '$10 – $100';
      if (price < 500)     return '$100 – $500';
      if (price < 1000)    return '$500 – $1,000';
      if (price < 5000)    return '$1,000 – $5,000';
      if (price < 20000)   return '$5,000 – $20,000';
      return 'Over $20,000';
    };

    for (const e of executions) {
      const price = e.limit_price ? Number(e.limit_price) : null;
      const bucket = price !== null && price > 0 ? getBucket(price) : 'No Price';
      const b = priceBuckets[bucket];
      b.total++;
      if (e.status === 'executed')  b.executed++;
      if (e.status === 'cancelled') b.cancelled++;
      if (e.status === 'failed')    b.failed++;
      if (e.status === 'pending')   b.pending++;
    }

    const priceRangeRows = Object.entries(priceBuckets).map(([range, counts]) => ({
      'Price Range':    range,
      'Total Orders':  counts.total,
      'Executed':      counts.executed,
      'Cancelled':     counts.cancelled,
      'Failed':        counts.failed,
      'Pending':       counts.pending,
      'Success Rate':  counts.total > 0 ? (counts.executed / counts.total * 100).toFixed(1) + '%' : '—'
    }));

    // ── Sheet 3: Indicator Stats ──────────────────────────────────────────────
    const indicatorRows = executions
      .filter(e => e.intent_id && intentMap.has(e.intent_id!))
      .map(e => {
        const intent = intentMap.get(e.intent_id!)!;
        let gates: Record<string, boolean> = {};
        try { gates = intent.gates_data ? JSON.parse(intent.gates_data) : {}; } catch {}

        let isExit = false;
        try { isExit = e.raw_payload ? JSON.parse(e.raw_payload).event === 'EXIT' : false; } catch {}

        const row: Record<string, any> = {
          'Date':           e.created_at ? new Date(e.created_at).toLocaleString() : '',
          'Ticker':         e.ticker,
          'Type':           isExit ? 'EXIT' : 'ENTRY',
          'Direction':      e.dir || '',
          'Price':          e.limit_price ? Number(e.limit_price) : '',
          'Status':         e.status,
          'Quality Tier':   intent.quality_tier,
          'Quality Score':  intent.quality_score,
          'Gates Hit':      intent.gates_hit,
          'Gates Total':    intent.gates_total,
          'Confidence %':   (intent.confidence * 100).toFixed(1) + '%',
          'Strategy':       intent.strategy_id || '',
          'Timeframe':      intent.timeframe || '',
          'Primary Blocker': intent.primary_blocker || ''
        };

        // Spread individual gate results as columns
        for (const [gateName, passed] of Object.entries(gates)) {
          row[`Gate: ${gateName}`] = passed ? 'PASS' : 'FAIL';
        }

        return row;
      });

    // ── Build Workbook ────────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.json_to_sheet(allOrdersRows);
    const ws2 = XLSX.utils.json_to_sheet(priceRangeRows);
    const ws3 = indicatorRows.length > 0
      ? XLSX.utils.json_to_sheet(indicatorRows)
      : XLSX.utils.json_to_sheet([{ Note: 'No executions with linked WALL intent found' }]);

    // Set column widths for readability
    ws1['!cols'] = [
      { wch: 20 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 8 },
      { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 30 },
      { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
      { wch: 14 }, { wch: 10 }
    ];
    ws2['!cols'] = [
      { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 14 }
    ];

    XLSX.utils.book_append_sheet(wb, ws1, 'All Orders');
    XLSX.utils.book_append_sheet(wb, ws2, 'Price Ranges');
    XLSX.utils.book_append_sheet(wb, ws3, 'Indicator Stats');

    const filename = `execution-wall-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (error: any) {
    console.error('❌ Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get executions (with filters)
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const ticker = req.query.ticker as string | undefined;

    const where: any = {};

    // Support comma-separated status filter (e.g., "pending,executing")
    if (status) {
      if (status.includes(',')) {
        where.status = { in: status.split(',') };
      } else {
        where.status = status;
      }
    }

    if (ticker) where.ticker = ticker;

    const executions = await prisma.execution.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 100
    });

    res.json(executions);
  } catch (error: any) {
    console.error('Error fetching executions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get execution with position context (for exit orders)
router.get('/:id/with-position', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const execution = await prisma.execution.findUnique({
      where: { id }
    });

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    // Determine if this is an exit order and get position_id from raw_payload
    let isExit = false;
    let positionIdFromPayload = null;
    if (execution.raw_payload) {
      try {
        const payload = JSON.parse(execution.raw_payload);
        isExit = payload.event === 'EXIT';
        positionIdFromPayload = payload.position_id;
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Get linked position from payload or find by ticker
    let position = null;
    if (positionIdFromPayload) {
      position = await prisma.position.findUnique({
        where: { id: positionIdFromPayload }
      });
    }

    // Fallback: find open position by ticker
    if (!position) {
      position = await prisma.position.findFirst({
        where: {
          ticker: execution.ticker,
          closed_at: null
        }
      });
    }

    res.json({
      execution,
      position,
      isExit
    });
  } catch (error: any) {
    console.error('Error fetching execution with position:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create execution
router.post('/', async (req: Request, res: Response) => {
  try {
    const { ticker, dir, order_action, quantity, limit_price, delay_bars, intent_id, raw_payload } = req.body;

    if (!ticker || !order_action || !quantity) {
      return res.status(400).json({
        error: 'Missing required fields: ticker, order_action, quantity'
      });
    }

    // Calculate delay expiration if delay_bars provided
    let delay_expires_at = null;
    if (delay_bars && delay_bars > 0) {
      // Assume 1 bar = 5 minutes for simplicity
      const delayMinutes = delay_bars * 5;
      delay_expires_at = new Date(Date.now() + delayMinutes * 60 * 1000);
    }

    // Build raw_payload for broker if not provided
    const orderPayload = raw_payload || JSON.stringify({
      event: 'ORDER',
      ticker: ticker.toUpperCase(),
      dir: dir || (order_action === 'buy' ? 'Long' : 'Short'),
      price: limit_price || 0,
      limit_price: limit_price || 0,
      quantity: Number(quantity),
      order_action
    });

    const execution = await prisma.execution.create({
      data: {
        ticker: ticker.toUpperCase(),
        dir: dir || (order_action === 'buy' ? 'Long' : 'Short'),
        order_action,
        quantity: Number(quantity),
        limit_price: limit_price ? limit_price.toString() : null,
        status: 'pending',
        delay_expires_at,
        intent_id: intent_id || null,
        raw_payload: orderPayload
      }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'execution_created',
        ticker: ticker.toUpperCase(),
        details: JSON.stringify({
          execution_id: execution.id,
          order_action,
          quantity,
          delay_expires_at,
          intent_id
        })
      }
    });

    console.log(`✅ Execution created: ${ticker} ${order_action} ${quantity}`);

    res.status(201).json(execution);
  } catch (error: any) {
    console.error('Error creating execution:', error);
    res.status(500).json({ error: error.message });
  }
});

// Execute (force execute)
router.post('/:id/execute', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const execution = await prisma.execution.findUnique({
      where: { id }
    });

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    if (execution.status === 'executed') {
      return res.status(400).json({ error: 'Execution already completed' });
    }

    // Forward to broker webhook first
    const brokerResult = await forwardToBroker(execution);

    // Update execution as executed (even if broker fails - local state is tracked)
    const updatedExecution = await prisma.execution.update({
      where: { id },
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
      // Update existing position
      const newQuantity = execution.order_action === 'buy'
        ? existingPosition.quantity + execution.quantity
        : existingPosition.quantity - execution.quantity;

      if (newQuantity === 0) {
        // Close position
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
      // Create new position
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
        event_type: 'execution_completed',
        ticker: execution.ticker,
        details: JSON.stringify({
          execution_id: id,
          order_action: execution.order_action,
          quantity: execution.quantity,
          broker_forwarded: brokerResult.success,
          broker_error: brokerResult.error || null
        })
      }
    });

    console.log(`✅ Execution completed: ${execution.ticker} ${execution.order_action}`);
    if (brokerResult.success) {
      console.log(`   📤 Forwarded to broker successfully`);
    } else if (brokerResult.error) {
      console.log(`   ⚠️ Broker forward failed: ${brokerResult.error}`);
    }

    res.json({
      ...updatedExecution,
      broker_forwarded: brokerResult.success,
      broker_response: brokerResult.response,
      broker_error: brokerResult.error
    });
  } catch (error: any) {
    console.error('Error executing order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update execution (e.g., limit price)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { limit_price, quantity } = req.body;

    const updateData: any = {};
    if (limit_price !== undefined) {
      updateData.limit_price = limit_price.toString();
    }
    if (quantity !== undefined) {
      updateData.quantity = Number(quantity);
    }

    const execution = await prisma.execution.update({
      where: { id },
      data: updateData
    });

    console.log(`✅ Execution updated: ${id} - limit_price: ${limit_price}`);

    res.json(execution);
  } catch (error: any) {
    console.error('Error updating execution:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel execution
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const execution = await prisma.execution.update({
      where: { id },
      data: { status: 'cancelled' }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'execution_cancelled',
        ticker: execution.ticker,
        details: JSON.stringify({ execution_id: id })
      }
    });

    console.log(`✅ Execution cancelled: ${id}`);

    res.json(execution);
  } catch (error: any) {
    console.error('Error cancelling execution:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create demo execution (for testing the approval flow)
router.post('/demo', async (req: Request, res: Response) => {
  try {
    const demoTicker = 'DEMO';
    const demoPrice = '99.50';

    // First, create a trade intent that requires approval
    const intent = await prisma.tradeIntent.create({
      data: {
        ticker: demoTicker,
        dir: 'Long',
        price: demoPrice,
        status: 'pending', // Not approved yet
        card_state: 'ARMED',
        quality_tier: 'A',
        quality_score: 85,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
      }
    });

    // Create execution linked to this intent (will need approval)
    // Set delay_expires_at to 30 seconds for testing
    const execution = await prisma.execution.create({
      data: {
        ticker: demoTicker,
        dir: 'Long',
        order_action: 'buy',
        quantity: 10,
        limit_price: demoPrice,
        status: 'pending',
        delay_expires_at: new Date(Date.now() + 30 * 1000), // 30 second delay for testing
        intent_id: intent.id,
        raw_payload: JSON.stringify({
          event: 'ORDER',
          ticker: demoTicker,
          dir: 'Long',
          price: demoPrice,
          limit_price: demoPrice,
          quantity: 10,
          order_action: 'buy',
          demo: true
        })
      }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'demo_execution_created',
        ticker: demoTicker,
        details: JSON.stringify({
          execution_id: execution.id,
          intent_id: intent.id,
          message: 'Demo execution created for testing approval flow'
        })
      }
    });

    console.log(`🎯 Demo execution created: ${execution.id} (linked to intent: ${intent.id})`);

    res.status(201).json({
      execution,
      intent,
      message: 'Demo execution created. Approve the order in the execution queue to see it execute.'
    });
  } catch (error: any) {
    console.error('Error creating demo execution:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
