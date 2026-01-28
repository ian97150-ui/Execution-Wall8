import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { forwardToBroker } from '../services/brokerWebhook';

const router = express.Router();

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
