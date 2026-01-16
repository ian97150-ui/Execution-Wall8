import api from './apiClient';

/**
 * Trade Intent Actions
 */
export const tradeIntentActions = {
  // Swipe action (approve, deny, off)
  swipe: async (id: string, action: 'approve' | 'deny' | 'off') => {
    const response = await api.post(`/trade-intents/${id}/swipe`, { action });
    return response.data;
  },

  // Invalidate intent
  invalidate: async (id: string) => {
    const response = await api.post(`/trade-intents/${id}/invalidate`);
    return response.data;
  }
};

/**
 * Execution Actions
 */
export const executionActions = {
  // Create execution
  create: async (data: {
    ticker: string;
    order_action: string;
    quantity: number;
    limit_price?: number;
    delay_bars?: number;
  }) => {
    const response = await api.post('/executions', data);
    return response.data;
  },

  // Force execute
  execute: async (id: string) => {
    const response = await api.post(`/executions/${id}/execute`);
    return response.data;
  },

  // Cancel execution
  cancel: async (id: string) => {
    const response = await api.post(`/executions/${id}/cancel`);
    return response.data;
  }
};

/**
 * Position Actions
 */
export const positionActions = {
  // Mark position as flat (close it)
  markFlat: async (id: string) => {
    const response = await api.post(`/positions/${id}/mark-flat`);
    return response.data;
  }
};

/**
 * Settings Actions
 */
export const settingsActions = {
  // Update execution settings
  update: async (data: {
    execution_mode?: string;
    default_delay_bars?: number;
    gate_threshold?: number;
    limit_edit_window?: number;
    max_adjustment_pct?: number;
    email_notifications?: boolean;
    notification_email?: string;
    notify_on_approval?: boolean;
    notify_on_execution?: boolean;
    notify_on_close?: boolean;
  }) => {
    const response = await api.put('/settings', data);
    return response.data;
  }
};

/**
 * Ticker Config Actions
 */
export const tickerConfigActions = {
  // Update ticker config
  update: async (ticker: string, data: {
    enabled?: boolean;
    blocked_until?: string | null;
  }) => {
    const response = await api.put(`/ticker-configs/${ticker}`, data);
    return response.data;
  }
};

/**
 * Webhook Actions
 */
export const webhookActions = {
  // Test webhook
  test: async () => {
    const response = await api.post('/webhook/test');
    return response.data;
  },

  // Send TradingView webhook
  sendTradingView: async (data: {
    ticker: string;
    dir: string;
    quality_tier?: string;
    quality_score?: number;
    price: number;
    card_state?: string;
  }) => {
    const response = await api.post('/webhook/tradingview', data);
    return response.data;
  }
};

/**
 * Auth Actions
 */
export const authActions = {
  // Register
  register: async (email: string, password: string) => {
    const response = await api.post('/auth/register', { email, password });
    // Store token
    if (response.data.token) {
      localStorage.setItem('auth_token', response.data.token);
    }
    return response.data;
  },

  // Login
  login: async (email: string, password: string) => {
    const response = await api.post('/auth/login', { email, password });
    // Store token
    if (response.data.token) {
      localStorage.setItem('auth_token', response.data.token);
    }
    return response.data;
  },

  // Logout
  logout: async () => {
    await api.post('/auth/logout');
    localStorage.removeItem('auth_token');
  }
};
