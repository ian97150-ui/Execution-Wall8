import nodemailer from 'nodemailer';
import { prisma } from '../index';

// Email event types matching settings
export type EmailEventType =
  | 'order_received'
  | 'signal_approved'
  | 'order_executed'
  | 'position_closed';

interface EmailPayload {
  eventType: EmailEventType;
  ticker: string;
  details: Record<string, any>;
}

// Create reusable transporter
let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;

    if (!user || !pass) {
      console.warn('⚠️ Gmail credentials not configured (GMAIL_USER, GMAIL_APP_PASSWORD)');
      return null;
    }

    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    });
  }
  return transporter;
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
    'order_received': `Order Received: ${ticker}`,
    'signal_approved': `Signal Approved: ${ticker}`,
    'order_executed': `Order Executed: ${ticker}`,
    'position_closed': `Position Closed: ${ticker}`
  };
  return subjects[eventType];
}

/**
 * Format email body based on event type
 */
function getEmailBody(eventType: EmailEventType, ticker: string, details: Record<string, any>): string {
  const timestamp = new Date().toLocaleString();

  let body = `
Execution Wall Notification
===========================

Event: ${eventType.replace(/_/g, ' ').toUpperCase()}
Ticker: ${ticker}
Time: ${timestamp}

Details:
`;

  // Add relevant details based on event type
  if (details.action) body += `  Action: ${details.action}\n`;
  if (details.side) body += `  Side: ${details.side}\n`;
  if (details.quantity) body += `  Quantity: ${details.quantity}\n`;
  if (details.limit_price) body += `  Limit Price: $${details.limit_price}\n`;
  if (details.entry_price) body += `  Entry Price: $${details.entry_price}\n`;
  if (details.status) body += `  Status: ${details.status}\n`;
  if (details.execution_mode) body += `  Execution Mode: ${details.execution_mode}\n`;
  if (details.broker_result) body += `  Broker Result: ${details.broker_result}\n`;

  // Add any remaining details
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

    const transport = getTransporter();
    if (!transport) {
      console.warn('⚠️ Email transport not configured');
      return false;
    }

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: toEmail,
      subject: getEmailSubject(eventType, ticker),
      text: getEmailBody(eventType, ticker, details)
    };

    await transport.sendMail(mailOptions);
    console.log(`✅ Email sent: ${eventType} for ${ticker} to ${toEmail}`);
    return true;
  } catch (error: any) {
    console.error(`❌ Failed to send email for ${eventType}:`, error.message);
    return false;
  }
}

/**
 * Convenience methods for each event type
 */
export const EmailNotifications = {
  orderReceived: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'order_received', ticker, details }),

  signalApproved: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'signal_approved', ticker, details }),

  orderExecuted: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'order_executed', ticker, details }),

  positionClosed: (ticker: string, details: Record<string, any>) =>
    sendEmailNotification({ eventType: 'position_closed', ticker, details })
};
