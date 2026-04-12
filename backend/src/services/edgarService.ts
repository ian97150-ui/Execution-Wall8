/**
 * EDGAR public API service — no auth required.
 * All functions return typed results with optional `error` field; never throws.
 */

const USER_AGENT = process.env.SEC_USER_AGENT || 'Wall8TradingApp contact@example.com';
const TIMEOUT_MS = 8000;

// Module-level CIK cache
const cikCache = new Map<string, string>();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShelfHistory {
  cik: string | null;
  shelf_type: string | null;
  shelf_date: string | null;
  shelf_age_days: number | null;
  prior_424b_count_12m: number;
  same_day_424b: { form: string; filing_url: string }[];
  error?: string;
}

export interface EightKResult {
  found: boolean;
  filing_date: string | null;
  signals: Array<'ATM_TERMINATED' | 'UNDERWRITING_DONE' | 'PRIVATE_PLACEMENT'>;
  catalyst_tier: 1 | 2 | 3 | 4 | null;
  proceeds_type: 'MILESTONE' | 'LOSSES' | 'UNKNOWN' | null;
  filing_url: string | null;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function edgarFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function daysBetween(dateStr: string): number {
  const today = new Date(todayET());
  const then = new Date(dateStr);
  return Math.floor((today.getTime() - then.getTime()) / 86400000);
}

export interface InsiderSignals {
  form144_presale: boolean;  // Form 144 filed within 30d (insider pre-sale notice)
  form4_sell: boolean;       // Form 4 filed within 14d (insider disposition)
}

// ─── lookupCIK ───────────────────────────────────────────────────────────────

export async function lookupCIK(ticker: string): Promise<string | null> {
  const upper = ticker.toUpperCase();
  if (cikCache.has(upper)) return cikCache.get(upper)!;

  try {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${upper}&output=atom`;
    const res = await edgarFetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    // EDGAR atom returns CIK as <cik>1864581</cik> (variable length, not zero-padded)
    const match = text.match(/<cik>(\d+)<\/cik>/i);
    if (!match) return null;
    const cik = match[1].padStart(10, '0');
    cikCache.set(upper, cik);
    return cik;
  } catch {
    return null;
  }
}

// ─── getShelfAndFilingHistory ─────────────────────────────────────────────────

export async function getShelfAndFilingHistory(ticker: string): Promise<ShelfHistory> {
  const base: ShelfHistory = {
    cik: null,
    shelf_type: null,
    shelf_date: null,
    shelf_age_days: null,
    prior_424b_count_12m: 0,
    same_day_424b: []
  };

  try {
    const cik = await lookupCIK(ticker);
    if (!cik) return { ...base, error: `CIK not found for ${ticker}` };
    base.cik = cik;

    const paddedCik = cik.padStart(10, '0');
    const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
    const res = await edgarFetch(url);
    if (!res.ok) return { ...base, cik, error: `EDGAR submissions ${res.status}` };

    const data = await res.json() as any;
    const recent = data.filings?.recent;
    if (!recent) return { ...base, cik, error: 'No filings data' };

    const forms: string[] = recent.form || [];
    const dates: string[] = recent.filingDate || [];
    const accNos: string[] = recent.accessionNumber || [];

    const SHELF_FORMS = ['S-3', 'S-3ASR', 'S-3/A', 'F-3', 'F-3ASR', 'F-3/A'];
    const oneYearAgo = daysAgo(365);
    const today = todayET();

    // Find most recent shelf
    for (let i = 0; i < forms.length; i++) {
      if (SHELF_FORMS.includes(forms[i]) && !base.shelf_date) {
        base.shelf_type = forms[i];
        base.shelf_date = dates[i];
        base.shelf_age_days = daysBetween(dates[i]);
      }
    }

    // Count 424Bs in last 12 months + same-day
    for (let i = 0; i < forms.length; i++) {
      if (forms[i].startsWith('424B') && dates[i] >= oneYearAgo) {
        base.prior_424b_count_12m++;
      }
      if (forms[i].startsWith('424B') && dates[i] === today) {
        const accNo = accNos[i].replace(/-/g, '');
        const filingUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo}/${accNos[i]}-index.htm`;
        base.same_day_424b.push({ form: forms[i], filing_url: filingUrl });
      }
    }

    return base;
  } catch (err: any) {
    return { ...base, error: err.message };
  }
}

// ─── getInsiderSignals ────────────────────────────────────────────────────────
// Checks EDGAR submissions for Form 144 (pre-sale notice) and Form 4 (insider
// disposition) filed recently. Non-blocking — returns false/false on any error.

export async function getInsiderSignals(ticker: string): Promise<InsiderSignals> {
  const result: InsiderSignals = { form144_presale: false, form4_sell: false };
  try {
    const cik = await lookupCIK(ticker);
    if (!cik) return result;

    const paddedCik = cik.padStart(10, '0');
    const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
    const res = await edgarFetch(url);
    if (!res.ok) return result;

    const data = await res.json() as any;
    const recent = data.filings?.recent;
    if (!recent) return result;

    const forms: string[] = recent.form || [];
    const dates: string[] = recent.filingDate || [];

    const cutoff144 = daysAgo(30);
    const cutoff4   = daysAgo(14);

    for (let i = 0; i < forms.length; i++) {
      if (!result.form144_presale && forms[i] === '144' && dates[i] >= cutoff144) {
        result.form144_presale = true;
      }
      if (!result.form4_sell && forms[i] === '4' && dates[i] >= cutoff4) {
        result.form4_sell = true;
      }
      if (result.form144_presale && result.form4_sell) break;
    }
  } catch {
    // non-blocking
  }
  return result;
}

// ─── getRecentEightKText ──────────────────────────────────────────────────────

export async function getRecentEightKText(ticker: string, daysBack = 2): Promise<EightKResult> {
  const base: EightKResult = {
    found: false,
    filing_date: null,
    signals: [],
    catalyst_tier: null,
    proceeds_type: null,
    filing_url: null
  };

  try {
    const cik = await lookupCIK(ticker);
    if (!cik) return { ...base, error: `CIK not found for ${ticker}` };

    const paddedCik = cik.padStart(10, '0');
    const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
    const res = await edgarFetch(url);
    if (!res.ok) return { ...base, error: `EDGAR submissions ${res.status}` };

    const data = await res.json() as any;
    const recent = data.filings?.recent;
    if (!recent) return base;

    const forms: string[] = recent.form || [];
    const dates: string[] = recent.filingDate || [];
    const accNos: string[] = recent.accessionNumber || [];
    const cutoff = daysAgo(daysBack);
    const cikInt = parseInt(cik);

    // Find most recent 8-K within daysBack
    let targetIdx = -1;
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === '8-K' && dates[i] >= cutoff) {
        targetIdx = i;
        break;
      }
    }

    if (targetIdx === -1) return base;

    const accNo = accNos[targetIdx];
    const accNoDashes = accNo.replace(/-/g, '');
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/${accNo}-index.htm`;
    base.filing_url = indexUrl;
    base.filing_date = dates[targetIdx];
    base.found = true;

    // Fetch index page to find primary document
    let docText = '';
    try {
      const idxRes = await fetch(indexUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (idxRes.ok) {
        const idxHtml = await idxRes.text();
        // Find primary .htm or .txt document link
        const docMatch = idxHtml.match(/href="([^"]*\.(htm|txt))"/i);
        if (docMatch) {
          const docUrl = docMatch[1].startsWith('http')
            ? docMatch[1]
            : `https://www.sec.gov${docMatch[1]}`;
          const docRes = await fetch(docUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
          if (docRes.ok) {
            // Read first 15KB only
            const reader = docRes.body?.getReader();
            if (reader) {
              const chunks: Uint8Array[] = [];
              let total = 0;
              while (total < 15000) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                chunks.push(value);
                total += value.length;
              }
              reader.cancel();
              docText = new TextDecoder().decode(
                Buffer.concat(chunks.map(c => Buffer.from(c)))
              ).toLowerCase();
            }
          }
        }
      }
    } catch {
      // Text fetch failed — base result with found=true still returned
    }

    if (!docText) return base;

    // Signal detection
    const signals: EightKResult['signals'] = [];
    if (docText.includes('atm termination') || docText.includes('terminate') && docText.includes('at-the-market')) {
      signals.push('ATM_TERMINATED');
    }
    if (docText.includes('underwriting agreement') || docText.includes('firm commitment')) {
      signals.push('UNDERWRITING_DONE');
    }
    if (docText.includes('private placement') || docText.includes('securities purchase agreement')) {
      signals.push('PRIVATE_PLACEMENT');
    }
    base.signals = signals;

    // Catalyst tier
    if (/fda|nda|bla|approval|phase.?3 (data|result|trial)|breakthrough therapy/i.test(docText)) {
      base.catalyst_tier = 1;
    } else if (/phase.?2|collaboration agreement|license agreement|milestone payment/i.test(docText)) {
      base.catalyst_tier = 2;
    } else if (/artificial intelligence|ai strategy|bitcoin|digital asset|exploring alternatives|strategic review/i.test(docText)) {
      base.catalyst_tier = 3;
    } else {
      base.catalyst_tier = 4;
    }

    // Proceeds type
    if (/general corporate purposes|working capital|operating expenses|fund operation/i.test(docText)) {
      base.proceeds_type = 'LOSSES';
    } else if (/advance|develop|fund.{0,30}program|clinical trial|commerciali/i.test(docText)) {
      base.proceeds_type = 'MILESTONE';
    } else {
      base.proceeds_type = 'UNKNOWN';
    }

    return base;
  } catch (err: any) {
    return { ...base, error: err.message };
  }
}
