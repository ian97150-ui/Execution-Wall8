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
 */

import { prisma } from '../index';
import { checkSecFilings } from './secCallbackService';
import { PushoverNotifications } from './pushoverService';
import { runChecklist } from './secChecklistService';

// Fixed ET scan times (HH:MM 24h)
const SCAN_TIMES_ET = ['06:00', '07:30', '09:00', '11:00', '13:00', '15:30', '17:00'];

let scannerInterval: NodeJS.Timeout | null = null;
let lastFiredMinute: string | null = null;

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
    }
  }, 60_000);

  console.log(`📋 SEC watch scanner started — scans at ${SCAN_TIMES_ET.join(', ')} ET (weekdays)`);
}

export function stopSecWatchScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
}
