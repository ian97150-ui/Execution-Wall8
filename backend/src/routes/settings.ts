import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { testBrokerWebhook } from '../services/brokerWebhook';

const router = express.Router();

// Get execution settings
router.get('/', async (req: Request, res: Response) => {
  try {
    // Get or create default settings
    let settings = await prisma.executionSettings.findFirst();

    if (!settings) {
      settings = await prisma.executionSettings.create({
        data: {
          execution_mode: 'safe',
          default_delay_bars: 2,
          gate_threshold: 3,
          limit_edit_window: 120,
          max_adjustment_pct: '2.0'
        }
      });
    }

    res.json(settings);
  } catch (error: any) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update execution settings
router.put('/', async (req: Request, res: Response) => {
  try {
    const {
      execution_mode,
      default_delay_bars,
      gate_threshold,
      limit_edit_window,
      max_adjustment_pct,
      broker_webhook_url,
      broker_webhook_enabled,
      email_notifications,
      notification_email,
      notify_on_approval,
      notify_on_execution,
      notify_on_close
    } = req.body;

    // Get existing settings or create new
    let settings = await prisma.executionSettings.findFirst();

    if (!settings) {
      settings = await prisma.executionSettings.create({
        data: {
          execution_mode: execution_mode || 'safe',
          default_delay_bars: default_delay_bars || 2,
          gate_threshold: gate_threshold || 3,
          limit_edit_window: limit_edit_window || 120,
          max_adjustment_pct: max_adjustment_pct || '2.0',
          email_notifications: email_notifications || false,
          notification_email: notification_email || null,
          notify_on_approval: notify_on_approval !== undefined ? notify_on_approval : true,
          notify_on_execution: notify_on_execution !== undefined ? notify_on_execution : true,
          notify_on_close: notify_on_close !== undefined ? notify_on_close : true
        }
      });
    } else {
      const updateData: any = {};
      if (execution_mode !== undefined) updateData.execution_mode = execution_mode;
      if (default_delay_bars !== undefined) updateData.default_delay_bars = default_delay_bars;
      if (gate_threshold !== undefined) updateData.gate_threshold = gate_threshold;
      if (limit_edit_window !== undefined) updateData.limit_edit_window = limit_edit_window;
      if (max_adjustment_pct !== undefined) updateData.max_adjustment_pct = max_adjustment_pct.toString();
      if (broker_webhook_url !== undefined) updateData.broker_webhook_url = broker_webhook_url;
      if (broker_webhook_enabled !== undefined) updateData.broker_webhook_enabled = broker_webhook_enabled;
      if (email_notifications !== undefined) updateData.email_notifications = email_notifications;
      if (notification_email !== undefined) updateData.notification_email = notification_email;
      if (notify_on_approval !== undefined) updateData.notify_on_approval = notify_on_approval;
      if (notify_on_execution !== undefined) updateData.notify_on_execution = notify_on_execution;
      if (notify_on_close !== undefined) updateData.notify_on_close = notify_on_close;

      settings = await prisma.executionSettings.update({
        where: { id: settings.id },
        data: updateData
      });
    }

    await prisma.auditLog.create({
      data: {
        event_type: 'settings_updated',
        ticker: null,
        details: JSON.stringify(req.body)
      }
    });

    console.log(`✅ Settings updated`);

    res.json(settings);
  } catch (error: any) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test broker webhook connection
router.post('/test-broker-webhook', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const result = await testBrokerWebhook(url);

    if (result.success) {
      res.json({
        success: true,
        message: 'Broker webhook test successful',
        statusCode: result.statusCode
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        statusCode: result.statusCode
      });
    }
  } catch (error: any) {
    console.error('Error testing broker webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
