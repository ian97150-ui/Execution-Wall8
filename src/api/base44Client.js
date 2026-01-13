import { createClient } from '@base44/sdk';
// import { getAccessToken } from '@base44/sdk/utils/auth-utils';

// Create a client with authentication required
export const base44 = createClient({
  appId: "695f40c0a784b9d3881e6966", 
  requiresAuth: true // Ensure authentication is required for all operations
});
