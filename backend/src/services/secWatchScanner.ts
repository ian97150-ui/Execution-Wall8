/**
 * SEC Watch Scanner
 *
 * Periodically polls the SEC scanner for all tickers in the watch list
 * that have not yet been confirmed. Runs at fixed ET times on weekdays.
 *
 * Scan times (America/New_York): 06:00, 07:30, 09:00, 11:00, 13:00, 15:30, 17:00
 *
 * Each scan appends a { at, found, filings?, error? } entry to sec_scan_history.
 * If a filing is found the ticker is auto-confirmed (same as WALL auto-confirm).
 *
 * AH RSS Poll (16:00–16:30 ET):
 * Polls EDGAR RSS feed every 30s to detect filings within ~30s of posting.
 * Records ah_drop_timestamp when AH move first exceeds -5% (stored in sec_scan_history).
 * Computes filing_gap_minutes — if gap > 3 min and AH drop present, confirms AH_FILING_GAP pattern.
 */

import { prisma } from '../index';
import { checkSecFilings } from './secCallbackService';
import { lookupCIK } from './edgarService';
import { PushoverNotifications } from './pushoverService';
import { runChecklist, refreshLiveScore } from './secChecklistService';
import type { ScoreSnapshot } from './scoringEngineService';

// Fixed ET scan times (HH:MM 24h)
const SCAN_TIMES_ET = ['06:00', '07:30', '09:00', '11:00', '13:00', '15:30', '17:00'];

// EDGAR RSS feed — returns recent filings in Atom format (~40 most recent, updated every few min)
const EDGAR_RSS_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&dateb=&owner=include&count=40&search_text=&output=atom';
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'Wall8TradingApp contact@example.com';

let scannerInterval: NodeJS.Timeout | null = null;
let lastFiredMinute: string | null = null;
let ahRssInterval: NodeJS.Timeout | null = null;
let liveScoreInterval: NodeJS.Timeout | null = null;

function getETMinute(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isWeekdayET(): boolean {
  const day = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short'
  });
  return day !== 'Sat' && day !== 'Sun';
}

/**
 * Run one full scan pass — checks all watched-but-unconfirmed tickers.
 * Safe to call manually (e.g. from an API route).
 */
export async function runSecWatchScan(): Promise<{ ticker: string; found: boolean; error?: string }[]> {
  const scannerUrl = process.env.SEC_SCANNER_URL;
  if (!scannerUrl) {
    console.warn('⚠️ SEC watch scan skipped — SEC_SCANNER_URL not set');
    return [];
  }

  const watching = await prisma.tradeIntent.findMany({
    where: { sec_watch: true, sec_confirmed: false },
    select: { id: true, ticker: true, sec_scan_history: true }
  });

  if (watching.length === 0) return [];

  const now = new Date().toISOString();
  console.log(`🔍 SEC watch scan: checking ${watching.length} ticker(s) at ${now}`);

  const results: { ticker: string; found: boolean; error?: string }[] = [];

  for (const intent of watching) {
    try {
      // Don't fire Pushover on automatic periodic scans — only on WALL arrival
      const result = await checkSecFilings(intent.ticker, false);

      // Parse existing history
      let history: any[] = [];
      try {
        if (intent.sec_scan_history) history = JSON.parse(intent.sec_scan_history);
      } catch {}

      // Append new entry, keep last 20
      const entry: any = { at: now, found: result.found };
      if (result.found && result.filings) entry.filings = result.filings;
      if (result.error) entry.error = result.error;
      history.push(entry);
      if (history.length > 20) history = history.slice(-20);

      if (result.found) {
        await prisma.tradeIntent.update({
          where: { id: intent.id },
          data: {
            sec_confirmed: true,
            sec_filings: JSON.stringify(result.filings || []),
            sec_scan_history: JSON.stringify(history)
          }
        });
        console.log(`✅ SEC auto-confirmed (watch scan): ${intent.ticker}`);
        PushoverNotifications.secFilingFound(intent.ticker, {
          filings: result.filings?.length ?? 0,
          forms: result.filings?.map((f: any) => f.form).join(', ') || 'Filing found',
          source: 'watch_scan'
        }).catch(err => console.error('Pushover SEC notify error:', err.message));

        // Fire-and-forget: refresh SEC checklist now that a filing is confirmed
        const intentIdForChecklist = intent.id;
        const tickerForChecklist = intent.ticker;
        runChecklist(tickerForChecklist)
          .then(c => prisma.tradeIntent.update({
            where: { id: intentIdForChecklist },
            data: { sec_checklist: JSON.stringify(c), sec_bias: c.bias }
          }))
          .catch(err => console.warn(`⚠️ SEC checklist refresh failed for ${tickerForChecklist}: ${err.message}`));
      } else {
        await prisma.tradeIntent.update({
          where: { id: intent.id },
          data: { sec_scan_history: JSON.stringify(history) }
        });
        console.log(`⏳ No SEC filing yet for ${intent.ticker}${result.error ? ` — ${result.error}` : ''}`);
      }

      results.push({ ticker: intent.ticker, found: result.found, error: result.error });
    } catch (e: any) {
      console.error(`❌ SEC watch scan error for ${intent.ticker}:`, e.message);
      results.push({ ticker: intent.ticker, found: false, error: e.message });
    }
  }

  return results;
}

/**
 * AH Filing Gap scan — runs at 17:00 ET.
 * For each SEC-watched ticker with AH_FILING_GAP_T1 in score_snapshot.signals,
 * places a limit short order at prior_close × 0.82 (18% below close) via broker webhook.
 * Only fires when broker webhook is enabled. Non-blocking per ticker.
 */
async function runAHFilingGapScan(): Promise<void> {
  const settings = await prisma.executionSettings.findFirst().catch(() => null);
  if (!settings?.broker_webhook_enabled || !settings?.broker_webhook_url) return;

  const watched = await prisma.tradeIntent.findMany({
    where: { sec_watch: true },
    select: { id: true, ticker: true, sec_checklist: true }
  });

  for (const intent of watched) {
    try {
      if (!intent.sec_checklist) continue;
      const checklist = JSON.parse(intent.sec_checklist);
      const snap: ScoreSnapshot | null = checklist.score_snapshot ?? null;
      if (!snap?.signals?.includes('AH_FILING_GAP_T1')) continue;

      const prior_close: number | null = checklist.phase1b?.prior_close ?? null;
      if (!prior_close || prior_close <= 0) continue;

      const limit_price = parseFloat((prior_close * 0.82).toFixed(2));

      console.log(`📉 AH_FILING_GAP_T1 — placing D+1 limit short for ${intent.ticker} at $${limit_price} (prior_close $${prior_close})`);

      await fetch(settings.broker_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: intent.ticker,
          action: 'sell',
          quantity: 1,
          limit_price,
          source: 'AH_FILING_GAP_T1'
        })
      });
    } catch (e: any) {
      console.warn(`⚠️ AH gap order failed for ${intent.ticker}: ${e.message}`);
    }
  }
}

/**
 * Poll EDGAR RSS feed once — check for filings matching any watched CIK.
 * Runs every 30s during 16:00–16:30 ET AH window.
 * Records ah_drop_timestamp when first detected. Confirms AH_FILING_GAP if gap > 3 min.
 */
async function pollEdgarRSSOnce(): Promise<void> {
  const watched = await prisma.tradeIntent.findMany({
    where: { sec_watch: true },
    select: { id: true, ticker: true, sec_scan_history: true, sec_checklist: true }
  });
  if (watched.length === 0) return;

  // Build CIK → intent map (cache lookups)
  const cikMap = new Map<string, (typeof watched)[0]>();
  for (const intent of watched) {
    const cik = await lookupCIK(intent.ticker).catch(() => null);
    if (cik) cikMap.set(cik, intent);
  }
  if (cikMap.size === 0) return;

  let rssXml = '';
  try {
    const res = await fetch(EDGAR_RSS_URL, {
      headers: { 'User-Agent': SEC_USER_AGENT },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return;
    rssXml = await res.text();
  } catch {
    return;
  }

  const now = new Date().toISOString();
  const edgarTimestamp = now;

  // Parse CIKs from RSS <id> tags: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=XXXXXXXXXX&...
  const cikMatches = [...rssXml.matchAll(/CIK=(\d{1,10})/gi)];
  const foundCIKs = new Set<string>();
  for (const m of cikMatches) {
    foundCIKs.add(m[1].padStart(10, '0'));
  }

  for (const [cik, intent] of cikMap.entries()) {
    if (!foundCIKs.has(cik)) continue;

    let history: any[] = [];
    try {
      if (intent.sec_scan_history) history = JSON.parse(intent.sec_scan_history);
    } catch {}

    // Find stored AH drop timestamp (if any)
    const ahDropEntry = history.find((h: any) => h.ah_drop_at);
    const ahDropTs = ahDropEntry?.ah_drop_at ? new Date(ahDropEntry.ah_drop_at).getTime() : null;
    const edgarTs = new Date(edgarTimestamp).getTime();
    const gapMinutes = ahDropTs ? (edgarTs - ahDropTs) / 60000 : null;

    // Also check current checklist for AH move
    let ahMovePct: number | null = null;
    try {
      if (intent.sec_checklist) {
        const cl = JSON.parse(intent.sec_checklist);
        ahMovePct = cl?.phase1b?.ah_move_pct ?? null;
      }
    } catch {}

    // Record AH drop timestamp if AH has dropped > 5% and not yet recorded
    if (!ahDropEntry && ahMovePct !== null && ahMovePct < -5) {
      history.push({ ah_drop_at: now, ah_move_pct: ahMovePct });
      if (history.length > 20) history = history.slice(-20);
      await prisma.tradeIntent.update({
        where: { id: intent.id },
        data: { sec_scan_history: JSON.stringify(history) }
      });
    }

    // Filing found in RSS for this ticker
    const rssEntry: any = { at: now, rss_edgar_hit: true, ticker: intent.ticker };
    if (gapMinutes !== null) rssEntry.filing_gap_minutes = parseFloat(gapMinutes.toFixed(1));
    if (ahMovePct !== null) rssEntry.ah_move_pct = ahMovePct;

    // AH_FILING_GAP confirmation: filing appeared in RSS after AH drop, gap > 3 min
    if (gapMinutes !== null && gapMinutes > 3 && ahMovePct !== null && ahMovePct < -5) {
      rssEntry.ah_filing_gap_confirmed = true;
      console.log(`📡 AH_FILING_GAP confirmed: ${intent.ticker} — AH drop ${ahMovePct}%, filing appeared ${gapMinutes.toFixed(1)}min later`);
    }

    history.push(rssEntry);
    if (history.length > 20) history = history.slice(-20);
    await prisma.tradeIntent.update({
      where: { id: intent.id },
      data: { sec_scan_history: JSON.stringify(history) }
    });
  }
}

/**
 * Start AH RSS poll (16:00–16:30 ET). Fires every 30s, auto-stops at 16:30.
 */
function startAHRssPoll(): void {
  if (ahRssInterval) return;
  console.log('📡 AH EDGAR RSS poll started (30s interval, stops at 16:30 ET)');
  ahRssInterval = setInterval(async () => {
    if (!isWeekdayET()) return;
    const etHHMM = getETMinute();
    const [h, m] = etHHMM.split(':').map(Number);
    const totalMin = h * 60 + m;
    // 16:00 = 960, 16:30 = 990
    if (totalMin < 960 || totalMin >= 990) {
      clearInterval(ahRssInterval!);
      ahRssInterval = null;
      console.log('📡 AH EDGAR RSS poll stopped (past 16:30 ET)');
      return;
    }
    pollEdgarRSSOnce().catch(err =>
      console.error('❌ AH RSS poll error:', err.message)
    );
  }, 30_000);
}

export function startSecWatchScanner(): void {
  if (scannerInterval) return;

  // Check every minute — fire when ET time matches a scan slot
  scannerInterval = setInterval(async () => {
    if (!isWeekdayET()) return;

    const etMinute = getETMinute();
    if (SCAN_TIMES_ET.includes(etMinute) && etMinute !== lastFiredMinute) {
      lastFiredMinute = etMinute;
      await runSecWatchScan().catch(err =>
        console.error('❌ SEC watch scan failed:', err.message)
      );
      // At 15:30 ET — start AH RSS poll so it's ready for 16:00 AH window
      if (etMinute === '15:30') {
        startAHRssPoll();
      }
      // At 17:00 ET — after-hours filing window — check for AH_FILING_GAP_T1 orders
      if (etMinute === '17:00') {
        runAHFilingGapScan().catch(err =>
          console.error('❌ AH filing gap scan failed:', err.message)
        );
      }
    }
  }, 60_000);

  console.log(`📋 SEC watch scanner started — scans at ${SCAN_TIMES_ET.join(', ')} ET (weekdays)`);
}

export function stopSecWatchScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
  if (ahRssInterval) {
    clearInterval(ahRssInterval);
    ahRssInterval = null;
  }
}

// ─── Live Score Poller ────────────────────────────────────────────────────────
// Refreshes price action + borrow for all active (non-swiped-off) intents that
// have a cached checklist. Runs every 60s. Stops automatically when no intents
// are active. Does NOT re-call EDGAR — only fast market/borrow APIs.

export function startLiveScorePoller(): void {
  if (liveScoreInterval) return;

  liveScoreInterval = setInterval(async () => {
    const active = await prisma.tradeIntent.findMany({
      where: {
        status: { not: 'swiped_off' },
        sec_checklist: { not: null },
        OR: [{ expires_at: { equals: null } }, { expires_at: { gt: new Date() } }],
      },
      select: { ticker: true },
      distinct: ['ticker'],
    }).catch(() => []);

    for (const { ticker } of active) {
      refreshLiveScore(ticker).catch(err =>
        console.warn(`[LiveScorePoller] ${ticker} refresh failed: ${err?.message}`)
      );
    }
  }, 60_000);

  console.log('📡 Live score poller started — refreshing S1/S2 every 60s for active cards');
}

export function stopLiveScorePoller(): void {
  if (liveScoreInterval) {
    clearInterval(liveScoreInterval);
    liveScoreInterval = null;
  }
}
