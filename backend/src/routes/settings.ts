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
  // Use Prisma to create settings with proper defaults
  console.log('Creating new settings with defaults...');
  try {
    await prisma.executionSettings.create({
      data: {
        execution_mode: 'safe',
        default_delay_bars: 2,
        bar_duration_minutes: 1,
        gate_threshold: 3,
        limit_edit_window: 120,
        max_adjustment_pct: '2.0',
        broker_webhook_enabled: false,
        email_notifications: false,
        notify_on_wall: true,
        notify_on_order_received: true,
        notify_on_approval: true,
        notify_on_execution: true,
        notify_on_close: true,
        use_time_schedules: false,
        timezone: 'America/New_York'
      }
    });
  } catch (e: any) {
    console.error('Failed to create settings:', e.message);
    throw e;
  }
  return await getSettingsSafe();
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
      notify_on_wall,
      notify_on_order_received,
      notify_on_approval,
      notify_on_execution,
      notify_on_close,
      use_time_schedules,
      timezone,
      tradingview_chart_id
    } = req.body;

    // Get existing settings or create new
    let settings = await getSettingsSafe();

    if (!settings) {
      settings = await createSettingsSafe();
    }

    const settingsId = (settings as any).id;

    // Build update data object with only provided fields
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
    if (notify_on_wall !== undefined) updateData.notify_on_wall = notify_on_wall;
    if (notify_on_order_received !== undefined) updateData.notify_on_order_received = notify_on_order_received;
    if (notify_on_approval !== undefined) updateData.notify_on_approval = notify_on_approval;
    if (notify_on_execution !== undefined) updateData.notify_on_execution = notify_on_execution;
    if (notify_on_close !== undefined) updateData.notify_on_close = notify_on_close;
    if (use_time_schedules !== undefined) updateData.use_time_schedules = use_time_schedules;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (tradingview_chart_id !== undefined) updateData.tradingview_chart_id = tradingview_chart_id;

    console.log('Updating settings with:', updateData);

    // Update using Prisma
    await prisma.executionSettings.update({
      where: { id: settingsId },
      data: updateData
    });

    // Fetch updated settings
    settings = await getSettingsSafe();

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

// Test email notification using Resend
router.post('/test-email', async (req: Request, res: Response) => {
  console.log('📧 Test email endpoint called');

  try {
    const { sendTestEmail } = await import('../services/emailService');

    // Check for Resend API key
    if (!process.env.RESEND_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'Resend API key not configured',
        details: { RESEND_API_KEY: 'MISSING' },
        hint: 'Add RESEND_API_KEY to your Railway environment variables. Get a free API key at resend.com'
      });
    }

    // Get the email to send to - from request body or settings
    let toEmail = req.body.email;
    if (!toEmail) {
      const settings = await getSettingsSafe();
      toEmail = settings?.notification_email;
    }

    if (!toEmail) {
      return res.status(400).json({
        success: false,
        error: 'No email address provided. Enter an email in the notification email field first.'
      });
    }

    console.log('📧 Sending test email to:', toEmail);

    const result = await sendTestEmail(toEmail);

    if (result.success) {
      console.log(`✅ Test email sent to ${toEmail} (id: ${result.id})`);
      res.json({
        success: true,
        message: `Test email sent to ${toEmail}`,
        id: result.id
      });
    } else {
      console.error('❌ Test email failed:', result.error);
      res.status(400).json({
        success: false,
        error: result.error
      });
    }
  } catch (error: any) {
    console.error('❌ Test email error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
