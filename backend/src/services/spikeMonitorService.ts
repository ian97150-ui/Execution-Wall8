/**
 * Spike Monitor Service — Pipeline 1
 *
 * Auto-detects 40%+ intraday movers with vol_ratio > 50x and seeds the
 * SEC Watch panel, replacing manual "Add ticker" for spike-day candidates.
 *
 * Data sources (in priority order):
 *   1. Polygon.io /v2/snapshot gainers list (POLYGON_API_KEY required, $29/mo)
 *   2. Yahoo Finance day_gainers screener (free, no auth, top ~25 movers)
 *
 * Schedule: every 60s from 08:30–16:30 ET on weekdays.
 * Requires SEC_SCANNER_URL or standalone (runs checklist directly via prisma).
 */

import { prisma } from '../index';
import { runChecklist } from './secChecklistService';
import { PushoverNotifications } from './pushoverService';

// Detection thresholds (from requirements doc)
const MIN_MOVE_PCT = 40;
const MIN_VOL_RATIO = 50;

const TIMEOUT_MS = 8000;

let monitorInterval: NodeJS.Timeout | null = null;

// Dedup: track tickers seeded this session to avoid repeated checklist runs
const seededToday = new Set<string>();

// Reset dedup set at midnight
function resetDailySet() {
  const now = new Date();
  const msUntilMidnight = new Date(
    now.getFullYear(), now.getMonth(), now.getDate() + 1
  ).getTime() - now.getTime();
  setTimeout(() => {
    seededToday.clear();
    resetDailySet();
  }, msUntilMidnight);
}

function isMarketHoursET(): boolean {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat', 'Sun'].includes(day)) return false;
  const etHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
  );
  const etMin = now.getMinutes();
  const totalMin = etHour * 60 + etMin;
  // 08:30–16:30 ET
  return totalMin >= 510 && totalMin < 990;
}

interface SpikeCandidate {
  ticker: string;
  intraday_move_pct: number;
  vol_ratio: number;
}

// ─── Data source 1: Polygon.io gainers ───────────────────────────────────────

async function fetchPolygonGainers(): Promise<SpikeCandidate[]> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const tickers: any[] = data.tickers || [];

    return tickers
      .filter((t: any) => {
        const move = t.todaysChangePerc ?? 0;
        const prevVol = t.prevDay?.v ?? 0;
        const curVol = t.day?.v ?? 0;
        const vol_ratio = prevVol > 0 ? curVol / prevVol : 0;
        return move >= MIN_MOVE_PCT && vol_ratio >= MIN_VOL_RATIO;
      })
      .map((t: any) => {
        const prevVol = t.prevDay?.v ?? 1;
        const curVol = t.day?.v ?? 0;
        return {
          ticker: t.ticker,
          intraday_move_pct: parseFloat((t.todaysChangePerc ?? 0).toFixed(2)),
          vol_ratio: parseFloat((curVol / prevVol).toFixed(1))
        };
      });
  } catch {
    return [];
  }
}

// ─── Data source 2: Yahoo Finance day_gainers screener (free fallback) ───────

async function fetchYahooGainers(): Promise<SpikeCandidate[]> {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=25&start=0',
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const quotes: any[] = data?.finance?.result?.[0]?.quotes ?? [];

    return quotes
      .filter((q: any) => {
        const move = q.regularMarketChangePercent ?? 0;
        const avgVol = q.averageDailyVolume3Month ?? 0;
        const curVol = q.regularMarketVolume ?? 0;
        const vol_ratio = avgVol > 0 ? curVol / avgVol : 0;
        return move >= MIN_MOVE_PCT && vol_ratio >= MIN_VOL_RATIO;
      })
      .map((q: any) => {
        const avgVol = q.averageDailyVolume3Month ?? 1;
        const curVol = q.regularMarketVolume ?? 0;
        return {
          ticker: q.symbol,
          intraday_move_pct: parseFloat((q.regularMarketChangePercent ?? 0).toFixed(2)),
          vol_ratio: parseFloat((curVol / avgVol).toFixed(1))
        };
      });
  } catch {
    return [];
  }
}

// ─── Seed ticker into watchlist ───────────────────────────────────────────────

async function seedWatchlist(candidate: SpikeCandidate): Promise<void> {
  const { ticker, intraday_move_pct, vol_ratio } = candidate;
  if (seededToday.has(ticker)) return;

  // Skip if ticker config blocks it
  const config = await prisma.tickerConfig.findUnique({ where: { ticker } }).catch(() => null);
  if (config?.alerts_blocked) return;

  // Skip if already watched today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const existing = await prisma.tradeIntent.findFirst({
    where: { ticker, created_date: { gte: today }, sec_watch: true }
  }).catch(() => null);
  if (existing) {
    seededToday.add(ticker);
    return;
  }

  seededToday.add(ticker);

  console.log(`📡 Spike detected: ${ticker} +${intraday_move_pct}% vol ${vol_ratio}x — seeding watchlist`);

  // Create manual watch entry (same as POST /api/trade-intents/manual-watch)
  const intent = await prisma.tradeIntent.create({
    data: {
      ticker,
      dir: 'WATCH',
      price: '0',
      card_state: 'ELIGIBLE',
      status: 'pending',
      is_manual: true,
      sec_watch: true,
      gates_hit: 0,
      gates_total: 0,
      confidence: 0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  }).catch((err: any) => {
    console.error(`❌ Spike monitor: failed to create intent for ${ticker}:`, err.message);
    return null;
  });

  if (!intent) return;

  // Fire-and-forget checklist run
  runChecklist(ticker)
    .then(checklist =>
      prisma.tradeIntent.update({
        where: { id: intent.id },
        data: { sec_checklist: JSON.stringify(checklist), sec_bias: checklist.bias }
      })
    )
    .catch(err => console.warn(`⚠️ Spike monitor: checklist failed for ${ticker}:`, err.message));

  // Pushover alert
  PushoverNotifications.spikeDetected(ticker, {
    move: `+${intraday_move_pct}%`,
    vol_ratio: `${vol_ratio}x`,
    source: process.env.POLYGON_API_KEY ? 'polygon' : 'yahoo'
  }).catch(() => {});
}

// ─── Main scan pass ───────────────────────────────────────────────────────────

async function runSpikeScan(): Promise<void> {
  // Polygon takes priority; fall back to Yahoo if no key
  let candidates = await fetchPolygonGainers();
  if (candidates.length === 0) {
    candidates = await fetchYahooGainers();
  }

  for (const c of candidates) {
    await seedWatchlist(c).catch(err =>
      console.error(`❌ Spike monitor seed error (${c.ticker}):`, err.message)
    );
  }
}

/**
 * Run a single on-demand spike scan pass.
 * Returns the list of tickers that were detected and seeded.
 * Called from the API route (manual "Scan for Spikes" button).
 */
export async function runSpikeScanOnDemand(): Promise<{ ticker: string; move: number; vol_ratio: number; seeded: boolean }[]> {
  let candidates = await fetchPolygonGainers();
  if (candidates.length === 0) {
    candidates = await fetchYahooGainers();
  }

  const results: { ticker: string; move: number; vol_ratio: number; seeded: boolean }[] = [];

  for (const c of candidates) {
    const wasSeeded = !seededToday.has(c.ticker);
    await seedWatchlist(c).catch(err =>
      console.error(`❌ Spike monitor seed error (${c.ticker}):`, err.message)
    );
    results.push({ ticker: c.ticker, move: c.intraday_move_pct, vol_ratio: c.vol_ratio, seeded: wasSeeded });
  }

  return results;
}

// ─── Auto-scan (disabled by default — use on-demand button instead) ──────────

export function startSpikeMonitor(): void {
  // Auto-scanning disabled — use the "Scan for Spikes" button in the UI instead.
  // Uncomment the block below to re-enable autonomous scanning.
  /*
  if (monitorInterval) return;
  resetDailySet();
  monitorInterval = setInterval(async () => {
    if (!isMarketHoursET()) return;
    await runSpikeScan().catch(err => console.error('❌ Spike scan error:', err.message));
  }, 60_000);
  console.log('📡 Spike monitor started — scanning every 60s from 08:30–16:30 ET');
  */
  resetDailySet();  // still reset the dedup set daily
}

export function stopSpikeMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
