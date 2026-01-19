import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { testBrokerWebhook } from '../services/brokerWebhook';

const router = express.Router();

/**
 * Helper to safely get settings without failing on missing columns
 */
async function getSettingsSafe() {
  try {
    return await prisma.executionSettings.findFirst();
  } catch (e: any) {
    // If column doesn't exist (schema mismatch), use raw query for basic fields
    if (e.message?.includes('does not exist')) {
      console.warn('⚠️ Some settings columns missing in GET, using raw query');
      try {
        const results = await prisma.$queryRaw`
          SELECT * FROM execution_settings LIMIT 1
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
 * Helper to safely create settings with only existing columns
 */
async function createSettingsSafe() {
  try {
    return await prisma.executionSettings.create({
      data: {
        execution_mode: 'safe',
        default_delay_bars: 2,
        bar_duration_minutes: 1,
        gate_threshold: 3,
        limit_edit_window: 120,
        max_adjustment_pct: '2.0'
      }
    });
  } catch (e: any) {
    // If column doesn't exist, create with basic fields only
    if (e.message?.includes('does not exist')) {
      console.warn('⚠️ Creating settings with basic fields only');
      await prisma.$executeRaw`
        INSERT INTO execution_settings (id, execution_mode, default_delay_bars, gate_threshold, limit_edit_window, max_adjustment_pct, broker_webhook_enabled, email_notifications, notify_on_approval, notify_on_execution, notify_on_close, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), 'safe', 2, 3, 120, '2.0', 0, 0, 1, 1, 1, datetime('now'), datetime('now'))
      `;
      return await getSettingsSafe();
    }
    throw e;
  }
}

// Get execution settings
router.get('/', async (req: Request, res: Response) => {
  try {
    // Get or create default settings
    let settings = await getSettingsSafe();

    if (!settings) {
      settings = await createSettingsSafe();
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
      bar_duration_minutes,
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
    let settings = await getSettingsSafe();

    if (!settings) {
      settings = await createSettingsSafe();
    }

    // Build update data - only include fields that exist
    const updateData: any = {};
    if (execution_mode !== undefined) updateData.execution_mode = execution_mode;
    if (default_delay_bars !== undefined) updateData.default_delay_bars = default_delay_bars;
    if (bar_duration_minutes !== undefined) updateData.bar_duration_minutes = bar_duration_minutes;
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

    // Try Prisma update first, fall back to raw SQL if columns missing
    try {
      settings = await prisma.executionSettings.update({
        where: { id: (settings as any).id },
        data: updateData
      });
    } catch (e: any) {
      if (e.message?.includes('does not exist')) {
        // Remove problematic fields and retry
        delete updateData.bar_duration_minutes;
        settings = await prisma.executionSettings.update({
          where: { id: (settings as any).id },
          data: updateData
        });
        console.warn('⚠️ Updated settings without bar_duration_minutes (column missing)');
      } else {
        throw e;
      }
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
