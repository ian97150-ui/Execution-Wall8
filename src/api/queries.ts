import api from './apiClient';

/**
 * Trade Intent Queries
 */
export const tradeIntentQueries = {
  // Get trade intents with filters
  getAll: async (filters?: {
    card_state?: string[];
    status?: string[];
    ticker?: string;
  }) => {
    const response = await api.get('/trade-intents', { params: filters });
    return response.data;
  },

  // Get single trade intent
  getById: async (id: string) => {
    const response = await api.get(`/trade-intents/${id}`);
    return response.data;
  }
};

/**
 * Execution Queries
 */
export const executionQueries = {
  // Get executions with filters
  getAll: async (filters?: { status?: string; ticker?: string }) => {
    const response = await api.get('/executions', { params: filters });
    return response.data;
  }
};

/**
 * Position Queries
 */
export const positionQueries = {
  // Get positions
  getAll: async (filters?: { open_only?: boolean; ticker?: string }) => {
    const response = await api.get('/positions', { params: filters });
    return response.data;
  },

  // Get single position
  getById: async (id: string) => {
    const response = await api.get(`/positions/${id}`);
    return response.data;
  }
};

/**
 * Audit Log Queries
 */
export const auditLogQueries = {
  // Get audit logs with filters
  getAll: async (filters?: {
    event_type?: string[];
    ticker?: string;
    limit?: number;
    offset?: number;
  }) => {
    const response = await api.get('/audit-logs', { params: filters });
    return response.data;
  }
};

/**
 * Settings Queries
 */
export const settingsQueries = {
  // Get execution settings
  get: async () => {
    const response = await api.get('/settings');
    return response.data;
  }
};

/**
 * Ticker Config Queries
 */
export const tickerConfigQueries = {
  // Get all ticker configs
  getAll: async () => {
    const response = await api.get('/ticker-configs');
    return response.data;
  },

  // Get single ticker config
  getByTicker: async (ticker: string) => {
    const response = await api.get(`/ticker-configs/${ticker}`);
    return response.data;
  }
};

/**
 * Webhook Log Queries
 */
export const webhookLogQueries = {
  // Get webhook logs
  getAll: async (filters?: {
    source?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => {
    const response = await api.get('/webhook/logs', { params: filters });
    return response.data;
  }
};

/**
 * Auth Queries
 */
export const authQueries = {
  // Get current user
  me: async () => {
    const response = await api.get('/auth/me');
    return response.data;
  }
};
