/**
 * Alpaca Flow Service — Pipelines 4 + 5
 *
 * Auto-populates three currently-manual phase3 fields using Alpaca free data API:
 *   - w1_imbalance:     Lee-Ready imbalance, first 5 min RTH (9:30–9:35 ET)
 *   - large_print_zone: Largest single print vs VWAP, first 15 min RTH (9:30–9:45 ET)
 *   - borrow:           Borrow regime approximated from pre-market bars (04:00–09:00 ET)
 *
 * All functions:
 *   - Return null gracefully if ALPACA_KEY / ALPACA_SECRET not set
 *   - Return null gracefully if outside the valid time window
 *   - Never throw — non-blocking, called from runChecklist()
 *
 * Requires: ALPACA_KEY, ALPACA_SECRET env vars (free paper account works)
 */

const ALPACA_DATA_BASE = 'https://data.alpaca.markets/v2/stocks';
const TIMEOUT_MS = 8000;

function getAlpacaHeaders(): Record<string, string> | null {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return null;
  return {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Accept': 'application/json'
  };
}

function etToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Returns '-04:00' (EDT/summer) or '-05:00' (EST/winter)
function etOffset(): string {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offset = utcHour - etHour;
  return offset === 4 ? '-04:00' : '-05:00';
}

function etTs(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00${etOffset()}`;
}


async function alpacaFetch(url: string, headers: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── W1 Imbalance (Lee-Ready) ─────────────────────────────────────────────────
// Returns (buy_vol - sell_vol) / total_vol → -1.0 to +1.0
// +1.0 = all buyer-initiated, -1.0 = all seller-initiated
// Requires market to be open or recently closed (data exists for 9:30–9:35 window)

export async function getW1Imbalance(ticker: string): Promise<number | null> {
  const headers = getAlpacaHeaders();
  if (!headers) return null;

  const today = etToday();

  // Fetch 1-min bars 9:30–9:35 ET
  const start = etTs(today, '09:30');
  const end   = etTs(today, '09:35');
  const url = `${ALPACA_DATA_BASE}/${ticker}/bars?timeframe=1Min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const data = await alpacaFetch(url, headers);
  const bars: any[] = data?.bars ?? [];
  if (bars.length === 0) return null;

  // Lee-Ready approximation using bar OHLCV:
  // If close > open → buyer pressure bar (+v), else seller pressure bar (-v)
  // Mid = (high + low) / 2 → trade above mid = buy, below mid = sell
  let buyVol = 0, sellVol = 0;
  for (const bar of bars) {
    const mid = (bar.h + bar.l) / 2;
    // Use close vs mid as proxy for trade direction (bar-level Lee-Ready)
    if (bar.c > mid) {
      buyVol += bar.v;
    } else if (bar.c < mid) {
      sellVol += bar.v;
    } else {
      // Tick test: close vs open
      if (bar.c >= bar.o) buyVol += bar.v / 2;
      else sellVol += bar.v / 2;
    }
  }

  const total = buyVol + sellVol;
  if (total === 0) return null;
  return parseFloat(((buyVol - sellVol) / total).toFixed(3));
}

// ─── Large Print Zone ─────────────────────────────────────────────────────────
// Finds the highest-volume single bar in the first 15 min RTH (9:30–9:45 ET)
// and compares its price to VWAP to classify as BELOW_VWAP or ABOVE_VWAP.

export async function getLargePrintZone(ticker: string): Promise<'BELOW_VWAP' | 'ABOVE_VWAP' | null> {
  const headers = getAlpacaHeaders();
  if (!headers) return null;

  const today = etToday();
  const start = etTs(today, '09:30');
  const end   = etTs(today, '09:45');
  const url = `${ALPACA_DATA_BASE}/${ticker}/bars?timeframe=1Min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const data = await alpacaFetch(url, headers);
  const bars: any[] = data?.bars ?? [];
  if (bars.length === 0) return null;

  // Compute VWAP across the window
  let sumTPV = 0, sumV = 0;
  for (const bar of bars) {
    const tp = (bar.h + bar.l + bar.c) / 3;
    sumTPV += tp * bar.v;
    sumV += bar.v;
  }
  if (sumV === 0) return null;
  const vwap = sumTPV / sumV;

  // Find bar with highest volume — this is the "large print" bar
  const largePrintBar = bars.reduce((max: any, bar: any) => bar.v > (max?.v ?? 0) ? bar : max, null);
  if (!largePrintBar) return null;

  // Price of the large print = midpoint of that bar
  const printPrice = (largePrintBar.h + largePrintBar.l + largePrintBar.c) / 3;
  return printPrice >= vwap ? 'ABOVE_VWAP' : 'BELOW_VWAP';
}

// ─── Borrow Regime ────────────────────────────────────────────────────────────
// Approximates IBKR borrow regime from Alpaca pre-market hourly bars (04:00–09:00 ET).
// Pre-market volume and spread are proxies for locate availability and borrow cost.

export async function inferBorrowRegime(ticker: string): Promise<'EASY' | 'HARD' | 'HTB' | 'NO_LOCATE' | null> {
  const headers = getAlpacaHeaders();
  if (!headers) return null;

  const today = etToday();
  const start = etTs(today, '04:00');
  const end   = etTs(today, '09:00');
  const url = `${ALPACA_DATA_BASE}/${ticker}/bars?timeframe=1Hour&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const data = await alpacaFetch(url, headers);
  const bars: any[] = data?.bars ?? [];

  // Sum pre-market volume
  const pmVol = bars.reduce((sum: number, b: any) => sum + (b.v ?? 0), 0);

  // Average spread as % of close: (high - low) / close * 100
  const spreads = bars
    .filter((b: any) => b.c > 0)
    .map((b: any) => ((b.h - b.l) / b.c) * 100);
  const avgSpread = spreads.length > 0
    ? spreads.reduce((s: number, v: number) => s + v, 0) / spreads.length
    : 999;

  // Thresholds from requirements doc (Pipeline 5)
  if (pmVol < 10)                          return 'NO_LOCATE';
  if (pmVol < 500 || avgSpread > 3.0)      return 'HTB';
  if (pmVol < 2000 || avgSpread > 1.5)     return 'HARD';
  return 'EASY';
}

// ─── Batch update all watched tickers ────────────────────────────────────────
// Called from runChecklist() when Alpaca keys are present.
// Returns a partial phase3 patch object — caller merges with existing phase3.

export async function fetchAlpacaPhase3Fields(ticker: string): Promise<{
  w1_imbalance?: number | null;
  large_print_zone?: 'BELOW_VWAP' | 'ABOVE_VWAP' | null;
  borrow?: 'EASY' | 'HARD' | 'HTB' | 'NO_LOCATE' | null;
}> {
  if (!getAlpacaHeaders()) return {};

  const [w1_imbalance, large_print_zone, borrow] = await Promise.all([
    getW1Imbalance(ticker).catch(() => null),
    getLargePrintZone(ticker).catch(() => null),
    inferBorrowRegime(ticker).catch(() => null)
  ]);

  const patch: Record<string, any> = {};
  if (w1_imbalance !== null)    patch.w1_imbalance = w1_imbalance;
  if (large_print_zone !== null) patch.large_print_zone = large_print_zone;
  if (borrow !== null)           patch.borrow = borrow;

  return patch;
}
