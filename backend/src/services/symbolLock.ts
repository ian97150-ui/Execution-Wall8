/**
 * Symbol Lock Service
 * Prevents race conditions when multiple webhooks arrive for the same symbol simultaneously
 *
 * Uses in-memory locks with TTL to prevent duplicate order creation
 */

interface LockEntry {
  lockedAt: number;
  ttl: number;
}

// In-memory lock store (per symbol)
const symbolLocks: Map<string, LockEntry> = new Map();

// Default lock TTL in milliseconds (3 seconds)
const DEFAULT_LOCK_TTL = 3000;

/**
 * Attempt to acquire a lock for a symbol
 * @param symbol - The ticker symbol to lock
 * @param lockType - Type of lock ('order', 'exit', or 'wall') - allows different lock namespaces
 * @param ttlMs - Lock TTL in milliseconds (default: 3000ms)
 * @returns true if lock acquired, false if already locked
 */
export function acquireSymbolLock(
  symbol: string,
  lockType: 'order' | 'exit' | 'wall' | 'sl_hit' = 'order',
  ttlMs: number = DEFAULT_LOCK_TTL
): boolean {
  const lockKey = `${symbol.toUpperCase()}:${lockType}`;
  const now = Date.now();

  // Check if lock exists and is still valid
  const existingLock = symbolLocks.get(lockKey);
  if (existingLock) {
    const lockAge = now - existingLock.lockedAt;
    if (lockAge < existingLock.ttl) {
      // Lock is still active
      console.log(`🔒 Symbol lock active for ${lockKey} (${lockAge}ms old, TTL: ${existingLock.ttl}ms)`);
      return false;
    }
    // Lock has expired, remove it
    symbolLocks.delete(lockKey);
  }

  // Acquire new lock
  symbolLocks.set(lockKey, {
    lockedAt: now,
    ttl: ttlMs
  });

  console.log(`🔓 Acquired lock for ${lockKey} (TTL: ${ttlMs}ms)`);
  return true;
}

/**
 * Release a symbol lock early (before TTL expires)
 * @param symbol - The ticker symbol to unlock
 * @param lockType - Type of lock ('order', 'exit', or 'wall')
 */
export function releaseSymbolLock(symbol: string, lockType: 'order' | 'exit' | 'wall' | 'sl_hit' = 'order'): void {
  const lockKey = `${symbol.toUpperCase()}:${lockType}`;
  if (symbolLocks.delete(lockKey)) {
    console.log(`🔓 Released lock for ${lockKey}`);
  }
}

/**
 * Check if a symbol is currently locked
 * @param symbol - The ticker symbol to check
 * @param lockType - Type of lock ('order', 'exit', or 'wall')
 * @returns true if locked, false if not locked
 */
export function isSymbolLocked(symbol: string, lockType: 'order' | 'exit' | 'wall' = 'order'): boolean {
  const lockKey = `${symbol.toUpperCase()}:${lockType}`;
  const existingLock = symbolLocks.get(lockKey);

  if (!existingLock) return false;

  const lockAge = Date.now() - existingLock.lockedAt;
  if (lockAge >= existingLock.ttl) {
    // Lock expired, clean it up
    symbolLocks.delete(lockKey);
    return false;
  }

  return true;
}

/**
 * Clean up expired locks (can be called periodically)
 */
export function cleanupExpiredLocks(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, lock] of symbolLocks.entries()) {
    if (now - lock.lockedAt >= lock.ttl) {
      symbolLocks.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired symbol lock(s)`);
  }

  return cleaned;
}

/**
 * Get current lock status (for debugging)
 */
export function getLockStatus(): { symbol: string; lockType: string; age: number; ttl: number }[] {
  const now = Date.now();
  const status: { symbol: string; lockType: string; age: number; ttl: number }[] = [];

  for (const [key, lock] of symbolLocks.entries()) {
    const [symbol, lockType] = key.split(':');
    status.push({
      symbol,
      lockType,
      age: now - lock.lockedAt,
      ttl: lock.ttl
    });
  }

  return status;
}
