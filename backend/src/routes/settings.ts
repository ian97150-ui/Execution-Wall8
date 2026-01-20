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
  // Use raw SQL to ensure all columns are created with proper defaults
  // This handles schema mismatches gracefully
  console.log('Creating new settings with defaults...');
  try {
    // Try with all fields first (including newer columns)
    await prisma.$executeRaw`
      INSERT INTO execution_settings (id, execution_mode, default_delay_bars, bar_duration_minutes, gate_threshold, limit_edit_window, max_adjustment_pct, broker_webhook_enabled, email_notifications, notify_on_order_received, notify_on_approval, notify_on_execution, notify_on_close, created_at, updated_at)
      VALUES (lower(hex(randomblob(16))), 'safe', 2, 1, 3, 120, '2.0', 0, 0, 1, 1, 1, 1, datetime('now'), datetime('now'))
    `;
  } catch {
    // Fallback without newer columns (bar_duration_minutes, notify_on_order_received)
    try {
      await prisma.$executeRaw`
        INSERT INTO execution_settings (id, execution_mode, default_delay_bars, gate_threshold, limit_edit_window, max_adjustment_pct, broker_webhook_enabled, email_notifications, notify_on_approval, notify_on_execution, notify_on_close, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), 'safe', 2, 3, 120, '2.0', 0, 0, 1, 1, 1, datetime('now'), datetime('now'))
      `;
    } catch (e2: any) {
      console.error('Failed to create settings:', e2.message);
      throw e2;
    }
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
      notify_on_order_received,
      notify_on_approval,
      notify_on_execution,
      notify_on_close
    } = req.body;

    // Get existing settings or create new
    let settings = await getSettingsSafe();

    if (!settings) {
      settings = await createSettingsSafe();
    }

    const settingsId = (settings as any).id;

    // Helper to safely update a single field (ignores if column doesn't exist)
    async function safeUpdateField(field: string, value: any) {
      try {
        const sql = `UPDATE execution_settings SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`;
        await prisma.$executeRawUnsafe(sql, value, settingsId);
        return true;
      } catch (fieldError: any) {
        // Silently skip if column doesn't exist
        if (fieldError.message?.includes('no such column')) {
          console.log(`⚠️ Column ${field} doesn't exist, skipping`);
        } else {
          console.warn(`⚠️ Could not update ${field}: ${fieldError.message}`);
        }
        return false;
      }
    }

    // Use raw SQL updates directly to avoid Prisma schema mismatch issues
    // Each field is updated individually so missing columns don't break everything
    console.log('Updating settings...');

    if (execution_mode !== undefined) await safeUpdateField('execution_mode', execution_mode);
    if (default_delay_bars !== undefined) await safeUpdateField('default_delay_bars', default_delay_bars);
    if (bar_duration_minutes !== undefined) await safeUpdateField('bar_duration_minutes', bar_duration_minutes);
    if (gate_threshold !== undefined) await safeUpdateField('gate_threshold', gate_threshold);
    if (limit_edit_window !== undefined) await safeUpdateField('limit_edit_window', limit_edit_window);
    if (max_adjustment_pct !== undefined) await safeUpdateField('max_adjustment_pct', max_adjustment_pct.toString());
    if (broker_webhook_url !== undefined) await safeUpdateField('broker_webhook_url', broker_webhook_url);
    if (broker_webhook_enabled !== undefined) await safeUpdateField('broker_webhook_enabled', broker_webhook_enabled ? 1 : 0);
    if (email_notifications !== undefined) await safeUpdateField('email_notifications', email_notifications ? 1 : 0);
    if (notification_email !== undefined) await safeUpdateField('notification_email', notification_email);
    if (notify_on_order_received !== undefined) await safeUpdateField('notify_on_order_received', notify_on_order_received ? 1 : 0);
    if (notify_on_approval !== undefined) await safeUpdateField('notify_on_approval', notify_on_approval ? 1 : 0);
    if (notify_on_execution !== undefined) await safeUpdateField('notify_on_execution', notify_on_execution ? 1 : 0);
    if (notify_on_close !== undefined) await safeUpdateField('notify_on_close', notify_on_close ? 1 : 0);

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

// Test email notification
router.post('/test-email', async (req: Request, res: Response) => {
  try {
    // Import email service
    const { sendEmailNotification } = await import('../services/emailService');

    // Check environment variables - log for debugging
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;

    console.log('Email test - checking env vars:');
    console.log('  GMAIL_USER:', gmailUser ? `set (${gmailUser.substring(0, 3)}...)` : 'missing');
    console.log('  GMAIL_APP_PASSWORD:', gmailPass ? `set (${gmailPass.length} chars)` : 'missing');

    if (!gmailUser || !gmailPass) {
      // List all env vars that contain 'GMAIL' or 'EMAIL' for debugging
      const relevantVars = Object.keys(process.env)
        .filter(k => k.includes('GMAIL') || k.includes('EMAIL') || k.includes('MAIL'))
        .map(k => `${k}: ${process.env[k] ? 'set' : 'missing'}`);

      return res.status(400).json({
        success: false,
        error: 'Gmail credentials not configured',
        details: {
          GMAIL_USER: gmailUser ? 'set' : 'missing',
          GMAIL_APP_PASSWORD: gmailPass ? 'set' : 'missing',
          found_vars: relevantVars.length > 0 ? relevantVars : ['No GMAIL/EMAIL/MAIL vars found']
        }
      });
    }

    // Get settings to check notification email
    const settings = await getSettingsSafe();

    // SQLite stores booleans as 0/1, so check for both
    const emailEnabled = settings?.email_notifications === true || settings?.email_notifications === 1;

    console.log('Email settings check:');
    console.log('  email_notifications raw value:', settings?.email_notifications, typeof settings?.email_notifications);
    console.log('  emailEnabled:', emailEnabled);
    console.log('  notification_email:', settings?.notification_email);

    if (!emailEnabled) {
      return res.status(400).json({
        success: false,
        error: 'Email notifications are disabled in settings',
        debug: {
          raw_value: settings?.email_notifications,
          type: typeof settings?.email_notifications
        }
      });
    }

    if (!settings?.notification_email) {
      return res.status(400).json({
        success: false,
        error: 'No notification email configured in settings'
      });
    }

    // Send test email
    const result = await sendEmailNotification({
      eventType: 'order_received',
      ticker: 'TEST',
      details: {
        action: 'buy',
        side: 'Long',
        quantity: 1,
        limit_price: 100.00,
        status: 'test_email',
        message: 'This is a test email from Execution Wall'
      }
    });

    if (result) {
      res.json({
        success: true,
        message: `Test email sent to ${settings.notification_email}`
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Email send returned false - check server logs for details'
      });
    }
  } catch (error: any) {
    console.error('Error sending test email:', error);
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
