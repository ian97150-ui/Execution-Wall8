import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { forwardToBroker } from '../services/brokerWebhook';
import { captureGradeSnapshot } from '../services/gradeSnapshotService';

const router = express.Router();

// ─── CSV Export (no external dependencies) ───────────────────────────────────
// GET /api/executions/export
// Downloads a CSV file with all order signals — opens directly in Excel.
// Sections: All Orders, Price Range Summary, Indicator Stats
router.get('/export', async (req: Request, res: Response) => {
  try {
    const executions = await prisma.execution.findMany({
      orderBy: { created_at: 'desc' },
      take: 5000
    });

    const intentIds = executions
      .map(e => e.intent_id)
      .filter((id): id is string => !!id);

    const intents = intentIds.length > 0
      ? await prisma.tradeIntent.findMany({ where: { id: { in: intentIds } } })
      : [];

    const intentMap = new Map(intents.map(i => [i.id, i]));

    // Escape a CSV cell value
    const csv = (v: any): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const row = (...cells: any[]) => cells.map(csv).join(',');
    const lines: string[] = [];

    // ── Section 1: All Orders ────────────────────────────────────────────────
    lines.push('=== ALL ORDERS ===');
    lines.push(row('Date','Ticker','Type','Direction','Action','Quantity','Price',
      'Status','Executed At','Error','Quality Tier','Quality Score',
      'Gates Hit','Gates Total','Confidence %','Strategy','Timeframe'));

    for (const e of executions) {
      let isExit = false;
      try { isExit = e.raw_payload ? JSON.parse(e.raw_payload).event === 'EXIT' : false; } catch {}
      const intent = e.intent_id ? intentMap.get(e.intent_id) : null;

      lines.push(row(
        e.created_at ? new Date(e.created_at).toLocaleString() : '',
        e.ticker,
        isExit ? 'EXIT' : 'ENTRY',
        e.dir || '',
        (e.order_action || '').toUpperCase(),
        e.quantity,
        e.limit_price ? Number(e.limit_price) : '',
        e.status,
        e.executed_at ? new Date(e.executed_at).toLocaleString() : '',
        e.error_message || '',
        intent?.quality_tier || '',
        intent?.quality_score ?? '',
        intent?.gates_hit ?? '',
        intent?.gates_total ?? '',
        intent ? (Number(intent.confidence) * 100).toFixed(1) + '%' : '',
        intent?.strategy_id || '',
        intent?.timeframe || ''
      ));
    }

    // ── Section 2: Price Range Summary ──────────────────────────────────────
    lines.push('');
    lines.push('=== PRICE RANGE SUMMARY ===');
    lines.push(row('Price Range','Total','Executed','Cancelled','Failed','Pending','Success Rate'));

    const buckets: Record<string, number[]> = {
      'Under $10':        [0,0,0,0,0],
      '$10 - $100':       [0,0,0,0,0],
      '$100 - $500':      [0,0,0,0,0],
      '$500 - $1000':     [0,0,0,0,0],
      '$1000 - $5000':    [0,0,0,0,0],
      '$5000 - $20000':   [0,0,0,0,0],
      'Over $20000':      [0,0,0,0,0],
      'No Price':         [0,0,0,0,0]
    };

    const getBucket = (p: number) => {
      if (p < 10)    return 'Under $10';
      if (p < 100)   return '$10 - $100';
      if (p < 500)   return '$100 - $500';
      if (p < 1000)  return '$500 - $1000';
      if (p < 5000)  return '$1000 - $5000';
      if (p < 20000) return '$5000 - $20000';
      return 'Over $20000';
    };

    for (const e of executions) {
      const price = e.limit_price ? Number(e.limit_price) : null;
      const b = buckets[price && price > 0 ? getBucket(price) : 'No Price'];
      b[0]++;
      if (e.status === 'executed')  b[1]++;
      if (e.status === 'cancelled') b[2]++;
      if (e.status === 'failed')    b[3]++;
      if (e.status === 'pending')   b[4]++;
    }

    for (const [range, b] of Object.entries(buckets)) {
      const rate = b[0] > 0 ? (b[1] / b[0] * 100).toFixed(1) + '%' : '-';
      lines.push(row(range, b[0], b[1], b[2], b[3], b[4], rate));
    }

    // ── Section 3: Indicator Stats ───────────────────────────────────────────
    const withIntent = executions.filter(e => e.intent_id && intentMap.has(e.intent_id!));
    if (withIntent.length > 0) {
      lines.push('');
      lines.push('=== INDICATOR STATS (orders with WALL intent) ===');

      // Collect all gate names across all intents
      const allGates = new Set<string>();
      for (const e of withIntent) {
        const intent = intentMap.get(e.intent_id!)!;
        try {
          const gates = intent.gates_data ? JSON.parse(intent.gates_data) : {};
          Object.keys(gates).forEach(g => allGates.add(g));
        } catch {}
      }
      const gateNames = [...allGates];

      lines.push(row('Date','Ticker','Type','Direction','Price','Status',
        'Quality Tier','Quality Score','Gates Hit','Gates Total','Confidence %',
        'Strategy','Timeframe','Primary Blocker',
        ...gateNames.map(g => `Gate: ${g}`)));

      for (const e of withIntent) {
        const intent = intentMap.get(e.intent_id!)!;
        let gates: Record<string, boolean> = {};
        try { gates = intent.gates_data ? JSON.parse(intent.gates_data) : {}; } catch {}
        let isExit = false;
        try { isExit = e.raw_payload ? JSON.parse(e.raw_payload).event === 'EXIT' : false; } catch {}

        lines.push(row(
          e.created_at ? new Date(e.created_at).toLocaleString() : '',
          e.ticker,
          isExit ? 'EXIT' : 'ENTRY',
          e.dir || '',
          e.limit_price ? Number(e.limit_price) : '',
          e.status,
          intent.quality_tier,
          intent.quality_score,
          intent.gates_hit,
          intent.gates_total,
          (Number(intent.confidence) * 100).toFixed(1) + '%',
          intent.strategy_id || '',
          intent.timeframe || '',
          intent.primary_blocker || '',
          ...gateNames.map(g => gates[g] === true ? 'PASS' : gates[g] === false ? 'FAIL' : '')
        ));
      }
    }

    const filename = `execution-wall-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + lines.join('\r\n')); // BOM prefix for Excel UTF-8 detection

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

// ─── Grade Snapshot TXT Export ───────────────────────────────────────────────
// GET /api/executions/export-grades
// Downloads a newline-delimited JSON (.txt) of all executions with grade snapshots.
// Each line is a self-contained JSON object with order info + scoring fields.
router.get('/export-grades', async (req: Request, res: Response) => {
  try {
    const executions = await prisma.execution.findMany({
      orderBy: { created_at: 'desc' },
      take: 5000,
    });

    const lines = executions.map((e: any) => {
      let grade: any = null;
      try { if (e.grade_snapshot) grade = JSON.parse(e.grade_snapshot); } catch {}
      return JSON.stringify({
        id: e.id,
        date: e.created_at,
        ticker: e.ticker,
        action: e.order_action,
        dir: e.dir,
        quantity: e.quantity,
        price: e.limit_price ? Number(e.limit_price) : null,
        status: e.status,
        executed_at: e.executed_at,
        // Grade fields — null when no WALL card checklist existed at order time
        score: grade?.score ?? null,
        bias: grade?.bias ?? null,
        pre_fall_score: grade?.pre_fall_score ?? null,
        pre_fall_tier: grade?.pre_fall_tier ?? null,
        predicted_bucket: grade?.predicted_bucket ?? null,
        bucket_dump_pct: grade?.bucket_dump_pct ?? null,
        signals: grade?.signals ?? null,
        confidence: grade?.confidence ?? null,
        section: grade?.section ?? null,
        snapshot_at: grade?.timestamp ?? null,
      });
    });

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="execution-grades-${date}.txt"`);
    res.send(lines.join('\n'));
  } catch (error: any) {
    console.error('Error exporting grade snapshots:', error);
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
    captureGradeSnapshot(execution.ticker, execution.id, execution.intent_id).catch(console.error);

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

// Custom order — create and immediately forward to broker (no delay/scheduler)
router.post('/custom', async (req: Request, res: Response) => {
  try {
    const { ticker, action, quantity, limit_price, intent_id } = req.body;

    if (!ticker || !action || !quantity || !limit_price) {
      return res.status(400).json({ error: 'Missing required fields: ticker, action, quantity, limit_price' });
    }
    if (!['buy', 'sell'].includes(action)) {
      return res.status(400).json({ error: 'action must be buy or sell' });
    }
    if (Number(quantity) <= 0 || Number(limit_price) <= 0) {
      return res.status(400).json({ error: 'quantity and limit_price must be positive' });
    }

    const tickerUpper = ticker.toUpperCase();
    const dir = action === 'buy' ? 'Long' : 'Short';

    const execution = await prisma.execution.create({
      data: {
        ticker: tickerUpper,
        dir,
        order_action: action,
        quantity: Number(quantity),
        limit_price: limit_price.toString(),
        status: 'pending',
        intent_id: intent_id || null,
        raw_payload: JSON.stringify({
          event: 'ORDER',
          ticker: tickerUpper,
          dir,
          price: Number(limit_price),
          limit_price: Number(limit_price),
          quantity: Number(quantity),
          order_action: action,
          source: 'custom'
        })
      }
    });
    captureGradeSnapshot(execution.ticker, execution.id, execution.intent_id).catch(console.error);

    const brokerResult = await forwardToBroker(execution);

    await prisma.execution.update({
      where: { id: execution.id },
      data: {
        status: brokerResult.success ? 'executed' : 'failed',
        executed_at: brokerResult.success ? new Date() : null,
        error_message: brokerResult.success ? null : brokerResult.error
      }
    });

    await prisma.auditLog.create({
      data: {
        event_type: 'custom_order_sent',
        ticker: tickerUpper,
        details: JSON.stringify({
          execution_id: execution.id,
          action,
          quantity: Number(quantity),
          limit_price: Number(limit_price),
          broker_success: brokerResult.success,
          intent_id: intent_id || null
        })
      }
    });

    console.log(`📤 Custom order: ${tickerUpper} ${action} ${quantity} @ $${limit_price} — broker: ${brokerResult.success ? 'ok' : brokerResult.error}`);
    res.json({ success: brokerResult.success, execution_id: execution.id, broker: brokerResult });
  } catch (error: any) {
    console.error('Error sending custom order:', error);
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

    // Block EXIT orders with no associated open position — prevents outbound
    // broker calls and notifications when the position no longer exists.
    let isExitOrder = false;
    if (execution.raw_payload) {
      try {
        const payload = JSON.parse(execution.raw_payload);
        isExitOrder = payload.event === 'EXIT';
      } catch (_) {}
    }
    if (isExitOrder) {
      const openPosition = await prisma.position.findFirst({
        where: { ticker: execution.ticker, closed_at: null }
      });
      if (!openPosition) {
        await prisma.execution.update({
          where: { id },
          data: { status: 'failed', error_message: 'No open position found — EXIT blocked before broker' }
        });
        await prisma.auditLog.create({
          data: {
            event_type: 'exit_rejected_no_position',
            ticker: execution.ticker,
            details: JSON.stringify({ execution_id: id, source: 'force_execute', reason: 'No open position found' })
          }
        });
        return res.status(409).json({ error: `No open position for ${execution.ticker} — EXIT order blocked` });
      }
    }

    // Forward to broker webhook first
    const brokerResult = await forwardToBroker(execution);
    // Capture grade snapshot if not already set (execution was created via a different path)
    if (!execution.grade_snapshot) {
      captureGradeSnapshot(execution.ticker, execution.id, execution.intent_id).catch(console.error);
    }

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
