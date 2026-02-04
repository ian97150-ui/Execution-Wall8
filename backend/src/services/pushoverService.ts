import { prisma } from '../index';

// Pushover event types matching settings
export type PushoverEventType =
  | 'wall_signal'
  | 'order_received'
  | 'signal_approved'
  | 'order_executed'
  | 'position_closed';

// Pushover priority levels
// -2 = no notification, -1 = quiet, 0 = normal, 1 = high, 2 = emergency (requires ack)
export type PushoverPriority = -2 | -1 | 0 | 1 | 2;

interface PushoverPayload {
  eventType: PushoverEventType;
  ticker: string;
  details: Record<string, any>;
  priority?: PushoverPriority;
}

interface PushoverResponse {
  status: number;
  request?: string;
  errors?: string[];
}

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

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
 * Check if Pushover should be sent for this event type
 */
async function shouldSendPushover(eventType: PushoverEventType): Promise<{
  send: boolean;
  userKey: string | null;
  apiToken: string | null;
}> {
  const settings = await getSettingsSafe();

  if (!settings) {
    return { send: false, userKey: null, apiToken: null };
  }

  // Check if Pushover is enabled
  const pushoverEnabled = toBool(settings.pushover_enabled);
  if (!pushoverEnabled) {
    return { send: false, userKey: null, apiToken: null };
  }

  // Must have Pushover credentials configured
  const userKey = settings.pushover_user_key;
  const apiToken = settings.pushover_api_token;

  if (!userKey || !apiToken) {
    console.warn('⚠️ Pushover enabled but credentials not configured');
    return { send: false, userKey: null, apiToken: null };
  }

  // Check individual event preferences (reuse email settings)
  const eventSettingMap: Record<PushoverEventType, string> = {
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

  return { send: isEnabled, userKey, apiToken };
}

/**
 * Get notification title based on event type
 */
function getTitle(eventType: PushoverEventType, ticker: string): string {
  const titles: Record<PushoverEventType, string> = {
    'wall_signal': `WALL: ${ticker}`,
    'order_received': `ORDER: ${ticker}`,
    'signal_approved': `APPROVED: ${ticker}`,
    'order_executed': `EXECUTED: ${ticker}`,
    'position_closed': `CLOSED: ${ticker}`
  };
  return titles[eventType];
}

/**
 * Get notification message body
 */
function getMessage(eventType: PushoverEventType, ticker: string, details: Record<string, any>): string {
  const parts: string[] = [];

  // Add key details based on event type
  if (details.side) parts.push(details.side);
  if (details.action) parts.push(details.action.toUpperCase());
  if (details.quantity) parts.push(`Qty: ${details.quantity}`);
  if (details.limit_price) parts.push(`@ $${details.limit_price}`);
  if (details.price) parts.push(`@ $${details.price}`);
  if (details.quality_tier) parts.push(`Grade: ${details.quality_tier}`);
  if (details.gates_hit) parts.push(`Gates: ${details.gates_hit}`);
  if (details.confidence) parts.push(`Conf: ${details.confidence}`);
  if (details.status) parts.push(`Status: ${details.status}`);
  if (details.broker_result) parts.push(`Broker: ${details.broker_result}`);
  if (details.trigger) parts.push(`Trigger: ${details.trigger}`);

  return parts.join(' | ') || eventType.replace(/_/g, ' ');
}

/**
 * Get priority based on event type
 */
function getDefaultPriority(eventType: PushoverEventType): PushoverPriority {
  const priorities: Record<PushoverEventType, PushoverPriority> = {
    'wall_signal': 0,        // Normal
    'order_received': 1,     // High - needs attention
    'signal_approved': 0,    // Normal
    'order_executed': 1,     // High - trade happened
    'position_closed': 0     // Normal
  };
  return priorities[eventType];
}

/**
 * Get sound based on event type
 */
function getSound(eventType: PushoverEventType): string {
  const sounds: Record<PushoverEventType, string> = {
    'wall_signal': 'pushover',
    'order_received': 'cashregister',
    'signal_approved': 'magic',
    'order_executed': 'cashregister',
    'position_closed': 'bugle'
  };
  return sounds[eventType];
}

/**
 * Send Pushover notification
 */
export async function sendPushoverNotification(payload: PushoverPayload): Promise<boolean> {
  const { eventType, ticker, details, priority } = payload;

  try {
    const { send, userKey, apiToken } = await shouldSendPushover(eventType);

    if (!send || !userKey || !apiToken) {
      console.log(`📱 Pushover skipped for ${eventType} (disabled or no credentials)`);
      return false;
    }

    const formData = new URLSearchParams();
    formData.append('token', apiToken);
    formData.append('user', userKey);
    formData.append('title', getTitle(eventType, ticker));
    formData.append('message', getMessage(eventType, ticker, details));
    formData.append('priority', String(priority ?? getDefaultPriority(eventType)));
    formData.append('sound', getSound(eventType));

    // Add timestamp
    formData.append('timestamp', String(Math.floor(Date.now() / 1000)));

    // For emergency priority (2), add retry and expire
    if (priority === 2) {
      formData.append('retry', '60');   // Retry every 60 seconds
      formData.append('expire', '300'); // Stop after 5 minutes
    }

    const response = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      body: formData
    });

    const result = await response.json() as PushoverResponse;

    if (result.status !== 1) {
      console.error(`❌ Pushover error for ${eventType}:`, result.errors);
      return false;
    }

    console.log(`✅ Pushover sent: ${eventType} for ${ticker} (request: ${result.request})`);
    return true;
  } catch (error: any) {
    console.error(`❌ Failed to send Pushover for ${eventType}:`, error.message);
    return false;
  }
}

/**
 * Send a test Pushover notification (bypasses settings checks)
 */
export async function sendTestPushover(userKey: string, apiToken: string): Promise<{ success: boolean; error?: string }> {
  try {
    const formData = new URLSearchParams();
    formData.append('token', apiToken);
    formData.append('user', userKey);
    formData.append('title', 'Execution Wall Test');
    formData.append('message', 'Pushover notifications are configured correctly!');
    formData.append('priority', '0');
    formData.append('sound', 'magic');

    const response = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      body: formData
    });

    const result = await response.json() as PushoverResponse;

    if (result.status !== 1) {
      return { success: false, error: result.errors?.join(', ') || 'Unknown error' };
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Convenience methods for each event type
 */
export const PushoverNotifications = {
  wallSignal: (ticker: string, details: Record<string, any>) =>
    sendPushoverNotification({ eventType: 'wall_signal', ticker, details }),

  orderReceived: (ticker: string, details: Record<string, any>) =>
    sendPushoverNotification({ eventType: 'order_received', ticker, details, priority: 1 }),

  signalApproved: (ticker: string, details: Record<string, any>) =>
    sendPushoverNotification({ eventType: 'signal_approved', ticker, details }),

  orderExecuted: (ticker: string, details: Record<string, any>) =>
    sendPushoverNotification({ eventType: 'order_executed', ticker, details, priority: 1 }),

  positionClosed: (ticker: string, details: Record<string, any>) =>
    sendPushoverNotification({ eventType: 'position_closed', ticker, details })
};
