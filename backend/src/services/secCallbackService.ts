/**
 * SEC Callback Service
 *
 * When a WALL alert arrives, this service calls the remote SEC scanner
 * (SEC_SCANNER_URL) to check for filings on the given ticker for today.
 *
 * Expected request:  POST {SEC_SCANNER_URL}/sec-check
 *                    { ticker: "AAPL", date: "2026-03-24", event: "WALL" }
 *
 * Expected response: { found: true,  filings: [...] }
 *                 or { found: false }
 *
 * Result mapping:
 *   found: true  → sec_watch: true, sec_confirmed: true  (badge auto-appears on card)
 *   found: false → sec_watch: true, sec_confirmed: false (SEC button stays for manual confirm)
 *   error/no URL → sec fields untouched                  (existing manual flow unchanged)
 */

export interface SecCheckResult {
  found: boolean;
  filings?: any[];
  ticker?: string;
  date?: string;
  error?: string;
}

/**
 * Calls the remote SEC scanner for today's filings on the given ticker.
 * Never throws — always returns a result object (error field set on failure).
 * Timeout: 5 seconds.
 *
 * @param sendPushover - passed to the scanner so it knows whether to fire its own Pushover alert
 */
export async function checkSecFilings(ticker: string, sendPushover = true): Promise<SecCheckResult> {
  const scannerUrl = process.env.SEC_SCANNER_URL;

  if (!scannerUrl) {
    return { found: false, error: 'SEC_SCANNER_URL not configured' };
  }

  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    const res = await fetch(`${scannerUrl}/sec-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, date, event: 'WALL', send_pushover: sendPushover }),
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      return { found: false, error: `SEC scanner returned HTTP ${res.status}` };
    }

    const data = await res.json() as SecCheckResult;
    return data;
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { found: false, error: 'SEC scanner timed out (5s)' };
    }
    return { found: false, error: e.message };
  }
}
