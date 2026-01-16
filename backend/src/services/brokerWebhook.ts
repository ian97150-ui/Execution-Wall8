import { prisma } from '../index';

/**
 * Broker order payload format
 * Simple format for broker execution
 */
interface BrokerOrderPayload {
  symbol: string;
  action: 'buy' | 'sell';
  quantity: number;
  limit_price: number;
}

interface BrokerWebhookResult {
  success: boolean;
  response?: any;
  error?: string;
  statusCode?: number;
}

/**
 * Forward an approved order to the broker webhook
 * Uses TradingView-compatible ORDER format
 */
export async function forwardToBroker(
  execution: {
    id: string;
    intent_id?: string | null;
    ticker: string;
    dir?: string | null;
    order_action: string;
    quantity: number;
    limit_price: any;
    raw_payload?: string | null;
  }
): Promise<BrokerWebhookResult> {
  try {
    // Get settings
    const settings = await prisma.executionSettings.findFirst();

    if (!settings?.broker_webhook_enabled || !settings?.broker_webhook_url) {
      console.log('📭 Broker webhook not configured or disabled');
      return {
        success: false,
        error: 'Broker webhook not configured or disabled'
      };
    }

    const webhookUrl = settings.broker_webhook_url;

    // Build broker order payload
    const payload: BrokerOrderPayload = {
      symbol: execution.ticker,
      action: execution.order_action as 'buy' | 'sell',
      quantity: execution.quantity,
      limit_price: execution.limit_price ? parseFloat(execution.limit_price.toString()) : 0
    };

    console.log(`📤 Forwarding order to broker: ${webhookUrl}`);
    console.log(`   Payload: ${JSON.stringify(payload)}`);

    // Forward to broker webhook
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    // Log the webhook call
    await prisma.auditLog.create({
      data: {
        event_type: 'broker_webhook_sent',
        ticker: execution.ticker,
        details: JSON.stringify({
          execution_id: execution.id,
          webhook_url: webhookUrl,
          payload,
          response_status: response.status,
          response_data: responseData,
          success: response.ok
        })
      }
    });

    if (!response.ok) {
      console.error(`❌ Broker webhook failed: ${response.status} ${responseText}`);
      return {
        success: false,
        error: `Broker responded with ${response.status}: ${responseText}`,
        statusCode: response.status,
        response: responseData
      };
    }

    console.log(`✅ Broker webhook success: ${response.status}`);
    return {
      success: true,
      statusCode: response.status,
      response: responseData
    };

  } catch (error: any) {
    console.error('❌ Broker webhook error:', error.message);

    // Log the error
    await prisma.auditLog.create({
      data: {
        event_type: 'broker_webhook_error',
        ticker: execution.ticker,
        details: JSON.stringify({
          execution_id: execution.id,
          error: error.message
        })
      }
    }).catch(err => console.error('Failed to log broker webhook error:', err));

    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Test the broker webhook connection
 */
export async function testBrokerWebhook(webhookUrl: string): Promise<BrokerWebhookResult> {
  try {
    const testPayload: BrokerOrderPayload = {
      symbol: 'TEST',
      action: 'buy',
      quantity: 1,
      limit_price: 100.00
    };

    console.log(`🧪 Testing broker webhook: ${webhookUrl}`);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testPayload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      return {
        success: false,
        error: `Broker responded with ${response.status}: ${responseText}`,
        statusCode: response.status
      };
    }

    return {
      success: true,
      statusCode: response.status,
      response: responseText
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message
    };
  }
}
