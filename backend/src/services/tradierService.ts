/**
 * Tradier API client — official REST API for price data.
 * Requires TRADIER_API_KEY env var (Bearer token from api.tradier.com).
 * All functions return empty/null on missing key or network error; never throws.
 */

const BASE = 'https://api.tradier.com/v1';
const TIMEOUT_MS = 8000;

function authHeaders(): Record<string, string> | null {
  const key = process.env.TRADIER_API_KEY;
  if (!key) return null;
  return { Authorization: `Bearer ${key}`, Accept: 'application/json' };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TradierBar {
  time: string;      // 'YYYY-MM-DDTHH:MM:SS' ET
  timestamp: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}

export interface TradierDailyBar {
  date: string; // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradierQuote {
  symbol: string;
  last: number;
  change: number;
  change_percentage: number;
  volume: number;
  average_volume: number;
  prevclose: number;
  open: number;
  high: number;
  low: number;
  bid: number;
  ask: number;
}

// ─── Intraday 1-min bars ─────────────────────────────────────────────────────

/** Fetch 1-minute bars. start/end must be 'YYYY-MM-DD HH:mm' in ET. */
export async function fetchTimesales(
  ticker: string,
  start: string,
  end: string,
  sessionFilter: 'all' | 'open' = 'all'
): Promise<TradierBar[]> {
  const hdrs = authHeaders();
  if (!hdrs) return [];
  try {
    const params = new URLSearchParams({
      symbol: ticker.toUpperCase(),
      interval: '1min',
      start,
      end,
      session_filter: sessionFilter,
    });
    const res = await fetch(`${BASE}/markets/timesales?${params}`, {
      headers: hdrs,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    const raw = data?.series?.data;
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [raw]) as TradierBar[];
  } catch {
    return [];
  }
}

// ─── Daily OHLCV bars ────────────────────────────────────────────────────────

/** Fetch daily bars. start/end must be 'YYYY-MM-DD'. */
export async function fetchDailyBars(
  ticker: string,
  start: string,
  end: string
): Promise<TradierDailyBar[]> {
  const hdrs = authHeaders();
  if (!hdrs) return [];
  try {
    const params = new URLSearchParams({
      symbol: ticker.toUpperCase(),
      interval: 'daily',
      start,
      end,
    });
    const res = await fetch(`${BASE}/markets/history?${params}`, {
      headers: hdrs,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    const raw = data?.history?.day;
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [raw]) as TradierDailyBar[];
  } catch {
    return [];
  }
}

// ─── Real-time quotes ────────────────────────────────────────────────────────

/** Fetch real-time quote for a single ticker. */
export async function fetchQuote(ticker: string): Promise<TradierQuote | null> {
  const hdrs = authHeaders();
  if (!hdrs) return null;
  try {
    const res = await fetch(
      `${BASE}/markets/quotes?symbols=${encodeURIComponent(ticker.toUpperCase())}`,
      { headers: hdrs, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const q = data?.quotes?.quote;
    if (!q) return null;
    return (Array.isArray(q) ? q[0] : q) as TradierQuote;
  } catch {
    return null;
  }
}

/** Fetch real-time quotes for multiple tickers in one request. */
export async function fetchQuotes(tickers: string[]): Promise<TradierQuote[]> {
  const hdrs = authHeaders();
  if (!hdrs || tickers.length === 0) return [];
  try {
    const symbols = tickers.map(t => t.toUpperCase()).join(',');
    const res = await fetch(
      `${BASE}/markets/quotes?symbols=${encodeURIComponent(symbols)}`,
      { headers: hdrs, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const q = data?.quotes?.quote;
    if (!q) return [];
    return (Array.isArray(q) ? q : [q]) as TradierQuote[];
  } catch {
    return [];
  }
}
