/**
 * Polygon.io API client — fallback price source when Tradier is unavailable.
 * Requires POLYGON_API_KEY env var.
 * Returns the same TradierBar / TradierDailyBar / TradierQuote types so
 * callers can use Tradier and Polygon interchangeably.
 */

import type { TradierBar, TradierDailyBar, TradierQuote } from './tradierService';

const BASE = 'https://api.polygon.io';
const TIMEOUT_MS = 10_000;

function apiKey(): string | null {
  return process.env.POLYGON_API_KEY ?? null;
}

/** Convert Polygon Unix-ms (UTC) to ET local time string 'YYYY-MM-DDTHH:MM:SS' */
function utcMsToET(tsMs: number): string {
  const d = new Date(tsMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  // Intl hour12:false can emit '24' for midnight — normalise to '00'
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

async function polygonFetch(url: string): Promise<any | null> {
  const key = apiKey();
  if (!key) return null;
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}apiKey=${key}`;
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(fullUrl, { signal: ctrl.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch 1-minute bars from Polygon.
 * Returns TradierBar[] so it can be used as a drop-in Tradier replacement.
 */
export async function fetchPolygonTimesales(
  ticker: string,
  startDate: string,  // 'YYYY-MM-DD'
  endDate: string,
): Promise<TradierBar[]> {
  if (!apiKey()) return [];
  const url = `${BASE}/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/minute/${startDate}/${endDate}` +
    `?adjusted=true&sort=asc&limit=50000&extended_hours=true`;
  const data = await polygonFetch(url);
  if (!data || !['OK', 'DELAYED'].includes(data.status)) return [];
  const raw: any[] = data.results ?? [];
  return raw.map(b => ({
    time:      utcMsToET(b.t),
    timestamp: Math.floor(b.t / 1000),
    open:      b.o ?? 0,
    high:      b.h ?? 0,
    low:       b.l ?? 0,
    close:     b.c ?? 0,
    volume:    b.v ?? 0,
  }));
}

/**
 * Fetch daily OHLCV bars from Polygon.
 * Returns TradierDailyBar[] compatible with the Tradier daily bars format.
 */
export async function fetchPolygonDailyBars(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<TradierDailyBar[]> {
  if (!apiKey()) return [];
  const url = `${BASE}/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${startDate}/${endDate}` +
    `?adjusted=true&sort=asc&limit=500`;
  const data = await polygonFetch(url);
  if (!data || !['OK', 'DELAYED'].includes(data.status)) return [];
  const raw: any[] = data.results ?? [];
  return raw.map(b => {
    const d = new Date(b.t);
    const date = d.toISOString().substring(0, 10);
    return {
      date,
      open:   b.o ?? 0,
      high:   b.h ?? 0,
      low:    b.l ?? 0,
      close:  b.c ?? 0,
      volume: b.v ?? 0,
    };
  });
}

/**
 * Fetch real-time quote snapshot from Polygon.
 * Returns a TradierQuote-compatible object.
 */
export async function fetchPolygonQuote(ticker: string): Promise<TradierQuote | null> {
  if (!apiKey()) return null;
  const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}`;
  const data = await polygonFetch(url);
  const snap = data?.ticker;
  if (!snap) return null;
  const day = snap.day ?? {};
  const prev = snap.prevDay ?? {};
  const last = snap.lastTrade?.p ?? day.c ?? 0;
  const prevClose = prev.c ?? 0;
  const change = prevClose > 0 ? last - prevClose : 0;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  return {
    symbol:            ticker.toUpperCase(),
    last:              last,
    change:            parseFloat(change.toFixed(4)),
    change_percentage: parseFloat(changePct.toFixed(4)),
    volume:            day.v ?? 0,
    average_volume:    prev.v ?? 0,
    prevclose:         prevClose,
    open:              day.o ?? 0,
    high:              day.h ?? 0,
    low:               day.l ?? 0,
    bid:               snap.lastQuote?.p ?? 0,
    ask:               snap.lastQuote?.P ?? 0,
  };
}
