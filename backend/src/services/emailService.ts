import { Resend } from 'resend';
import { prisma } from '../index';

// Email event types matching settings
export type EmailEventType =
  | 'wall_signal'
  | 'order_received'
  | 'signal_approved'
  | 'order_executed'
  | 'position_closed';

interface EmailPayload {
  eventType: EmailEventType;
  ticker: string;
  details: Record<string, any>;
}

// Resend client
let resend: Resend | null = null;

function getResendClient(): Resend | null {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      console.warn('⚠️ Resend API key not configured (RESEND_API_KEY)');
      return null;
    }

    resend = new Resend(apiKey);
  }
  return resend;
}

/**
 * Get settings safely with fallbacks
 */
async function getSettingsSafe() {
  try {
    return await prisma.executionSettings.findFirst();
  } catch (e: any) {
    if (e.message?.includes('does not exist')) {
      try {
        const results = await prisma.$queryRawUnsafe(`SELECT * FROM execution_settings LIMIT 1`) as any[];
        return results[0] || null;
      } catch {
        return null;
      }
    }
    throw e;
  }
}

/**
 * Helper to convert SQLite boolean (0/1) to JavaScript boolean
 */
function toBool(val: any): boolean {
  return val === true || val === 1 || val === '1';
}

/**
 * Check if email should be sent for this event type
 */
async function shouldSendEmail(eventType: EmailEventType): Promise<{ send: boolean; toEmail: string | null }> {
  const settings = await getSettingsSafe();

  if (!settings) {
    return { send: false, toEmail: null };
  }

  // Master switch must be on (handle SQLite 0/1 booleans)
  const emailEnabled = toBool(settings.email_notifications);
  if (!emailEnabled) {
    return { send: false, toEmail: null };
  }

  // Must have notification email configured
  if (!settings.notification_email) {
    console.warn('⚠️ Email notifications enabled but no notification_email set');
    return { send: false, toEmail: null };
  }

  // Check individual event preferences (handle SQLite 0/1 booleans)
  const eventSettingMap: Record<EmailEventType, string> = {
    'wall_signal': 'notify_on_wall',
    'order_received': 'notify_on_order_received',
    'signal_approved': 'notify_on_approval',
    'order_executed': 'notify_on_execution',
    'position_closed': 'notify_on_close'
  };

  const settingKey = eventSettingMap[eventType];
  const settingValue = settings[settingKey];
  // Default to true if undefined, otherwise check for truthy SQLite value
  const isEnabled = settingValue === undefined || toBool(settingValue);

  return { send: isEnabled, toEmail: settings.notification_email };
}

/**
 * Format email subject based on event type
 */
function getEmailSubject(eventType: EmailEventType, ticker: string): string {
  const subjects: Record<EmailEventType, string> = {
    'wall_signal': `🎯 WALL Signal: ${ticker}`,
    'order_received': `📥 Order Received: ${ticker}`,
    'signal_approved': `✅ Signal Approved: ${ticker}`,
    'order_executed': `🚀 Order Executed: ${ticker}`,
    'position_closed': `📊 Position Closed: ${ticker}`
  };
  return subjects[eventType];
}

/**
 * Format email body as HTML
 */
function getEmailHtml(eventType: EmailEventType, ticker: string, details: Record<string, any>): string {
  const timestamp = new Date().toLocaleString();

  const eventLabels: Record<EmailEventType, string> = {
    'wall_signal': 'WALL Signal',
    'order_received': 'Order Received',
    'signal_approved': 'Signal Approved',
    'order_executed': 'Order Executed',
    'position_closed': 'Position Closed'
  };

  const eventColors: Record<EmailEventType, string> = {
    'wall_signal': '#6366f1',
    'order_received': '#3b82f6',
    'signal_approved': '#22c55e',
    'order_executed': '#8b5cf6',
    'position_closed': '#f59e0b'
  };

  let detailsHtml = '';
  const displayFields = [
    { key: 'action', label: 'Action' },
    { key: 'side', label: 'Side' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'limit_price', label: 'Limit Price', prefix: '$' },
    { key: 'entry_price', label: 'Entry Price', prefix: '$' },
    { key: 'status', label: 'Status' },
    { key: 'execution_mode', label: 'Execution Mode' },
    { key: 'broker_result', label: 'Broker Result' },
    { key: 'message', label: 'Message' }
  ];

  const shownKeys = displayFields.map(f => f.key);

  for (const field of displayFields) {
    if (details[field.key] !== null && details[field.key] !== undefined) {
      const value = field.prefix ? `${field.prefix}${details[field.key]}` : details[field.key];
      detailsHtml += `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${field.label}</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 500;">${value}</td></tr>`;
    }
  }

  // Add any remaining details not in the standard list
  for (const [key, value] of Object.entries(details)) {
    if (!shownKeys.includes(key) && value !== null && value !== undefined) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      detailsHtml += `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${label}</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${value}</td></tr>`;
    }
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <!-- Header -->
      <div style="background-color: ${eventColors[eventType]}; padding: 20px; text-align: center;">
        <h1 style="margin: 0; color: white; font-size: 24px;">${eventLabels[eventType]}</h1>
        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 28px; font-weight: bold;">${ticker}</p>
      </div>

      <!-- Content -->
      <div style="padding: 20px;">
        <table style="width: 100%; border-collapse: collapse;">
          ${detailsHtml}
        </table>

        <p style="margin: 20px 0 0; color: #9ca3af; font-size: 12px; text-align: center;">
          ${timestamp}
        </p>
      </div>

      <!-- Footer -->
      <div style="background-color: #f9fafb; padding: 15px; text-align: center; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; color: #6b7280; font-size: 12px;">Sent by Execution Wall</p>
      </div>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Get plain text version of email
 */
function getEmailText(eventType: EmailEventType, ticker: string, details: Record<string, any>): string {
  const timestamp = new Date().toLocaleString();

  let body = `
Execution Wall Notification
===========================

Event: ${eventType.replace(/_/g, ' ').toUpperCase()}
Ticker: ${ticker}
Time: ${timestamp}

Details:
`;

  if (details.action) body += `  Action: ${details.action}\n`;
  if (details.side) body += `  Side: ${details.side}\n`;
  if (details.quantity) body += `  Quantity: ${details.quantity}\n`;
  if (details.limit_price) body += `  Limit Price: $${details.limit_price}\n`;
  if (details.entry_price) body += `  Entry Price: $${details.entry_price}\n`;
  if (details.status) body += `  Status: ${details.status}\n`;
  if (details.execution_mode) body += `  Execution Mode: ${details.execution_mode}\n`;
  if (details.broker_result) body += `  Broker Result: ${details.broker_result}\n`;

  const shownKeys = ['action', 'side', 'quantity', 'limit_price', 'entry_price', 'status', 'execution_mode', 'broker_result'];
  for (const [key, value] of Object.entries(details)) {
    if (!shownKeys.includes(key) && value !== null && value !== undefined) {
      body += `  ${key}: ${value}\n`;
    }
  }

  body += `
---
Sent by Execution Wall
`;

  return body;
}

/**
 * Send email notification for trading events
 */
export async function sendEmailNotification(payload: EmailPayload): Promise<boolean> {
  const { eventType, ticker, details } = payload;

  try {
    // Check if we should send this email
    const { send, toEmail } = await shouldSendEmail(eventType);

    if (!send || !toEmail) {
      console.log(`📧 Email skipped for ${eventType} (disabled or no recipient)`);
      return false;
    }

    const client = getResendClient();
    if (!client) {
      console.warn('⚠️ Resend client not configured');
      return false;
    }

    // Get the from email (use env var or default to Resend's default)
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Execution Wall <onboarding@resend.dev>';

    const { data, error } = await client.emails.send({
      from: fromEmail,
      to: toEmail,
      subject: getEmailSubject(eventType, ticker),
      html: getEmailHtml(eventType, ticker, details),
      text: getEmailText(eventType, ticker, details)
    });

    if (error) {
      console.error(`❌ Resend error for ${eventType}:`, error);
      return false;
    }

    console.log(`✅ Email sent: ${eventType} for ${ticker} to ${toEmail} (id: ${data?.id})`);
    return true;
  } catch (error: any) {
    console.error(`❌ Failed to send email for ${eventType}:`, error.message);
    return false;
  }
}

/**
 * Send a direct test email (bypasses settings checks)
 */
export async function sendTestEmail(toEmail: string): Promise<{ success: boolean; error?: string; id?: string }> {
  const client = getResendClient();

  if (!client) {
    return { success: false, error: 'Resend API key not configured (RESEND_API_KEY)' };
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'Execution Wall <onboarding@resend.dev>';

  try {
    const { data, error } = await client.emails.send({
      from: fromEmail,
      to: toEmail,
      subject: 'Execution Wall - Test Email',
      html: `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px;">
  <div style="max-width: 500px; margin: 0 auto; background: #f0fdf4; border: 1px solid #22c55e; border-radius: 8px; padding: 20px;">
    <h2 style="color: #16a34a; margin: 0 0 10px;">✅ Test Email Successful!</h2>
    <p style="color: #166534; margin: 0;">Your Execution Wall email notifications are configured correctly.</p>
    <hr style="border: none; border-top: 1px solid #bbf7d0; margin: 15px 0;">
    <p style="color: #6b7280; font-size: 12px; margin: 0;">
      Sent to: ${toEmail}<br>
      Time: ${new Date().toLocaleString()}
    </p>
  </div>
</body>
</html>
`,
      text: `Test Email Successful!\n\nYour Execution Wall email notifications are configured correctly.\n\nSent to: ${toEmail}\nTime: ${new Date().toLocaleString()}`
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, id: data?.id };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Convenience methods for each event type
 */
export const EmailNotifications = {
  wallSignal: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'wall_signal', ticker, details }),

  orderReceived: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'order_received', ticker, details }),

  signalApproved: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'signal_approved', ticker, details }),

  orderExecuted: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'order_executed', ticker, details }),

  positionClosed: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'position_closed', ticker, details })
};
