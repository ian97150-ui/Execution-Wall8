/**
 * Finnhub REST API service — free tier, 60 calls/min.
 * All functions return typed results with optional `error` field; never throws.
 * Requires FINNHUB_API_KEY env var. If absent, returns { error: 'NO_API_KEY' }.
 */

const TIMEOUT_MS = 6000;
const BASE_URL = 'https://finnhub.io/api/v1';

function getApiKey(): string | null {
  return process.env.FINNHUB_API_KEY || null;
}

function finnhubFetch(path: string): Promise<Response> {
  const key = getApiKey();
  if (!key) throw new Error('NO_API_KEY');
  return fetch(`${BASE_URL}${path}`, {
    headers: { 'X-Finnhub-Token': key },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnalystCoverage {
  period: string | null;
  buy: number;
  hold: number;
  sell: number;
  strong_buy: number;
  strong_sell: number;
  analyst_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
  error?: string;
}

export interface ShortInterestResult {
  date: string | null;
  short_interest: number | null;
  shares_outstanding: number | null;   // in millions (from profile2)
  short_float_pct: number | null;      // computed: (short_interest / shares_outstanding*1e6) * 100
  error?: string;
}

export interface NewsItem {
  headline: string;
  summary: string;
  url: string;
  datetime: number;  // unix timestamp
}

// ─── getAnalystCoverage ──────────────────────────────────────────────────────

export async function getAnalystCoverage(ticker: string): Promise<AnalystCoverage> {
  const base: AnalystCoverage = {
    period: null,
    buy: 0,
    hold: 0,
    sell: 0,
    strong_buy: 0,
    strong_sell: 0,
    analyst_bias: null
  };

  try {
    const res = await finnhubFetch(`/stock/recommendation?symbol=${encodeURIComponent(ticker)}`);
    if (!res.ok) return { ...base, error: `Finnhub ${res.status}` };

    const data = await res.json() as any[];
    if (!Array.isArray(data) || data.length === 0) return { ...base, error: 'No analyst data' };

    // Most recent period first
    const latest = data[0];
    const buy = latest.buy || 0;
    const hold = latest.hold || 0;
    const sell = latest.sell || 0;
    const strong_buy = latest.strongBuy || 0;
    const strong_sell = latest.strongSell || 0;

    const bullish = buy + strong_buy;
    const bearish = sell + strong_sell;
    let analyst_bias: AnalystCoverage['analyst_bias'] = 'NEUTRAL';
    if (bullish > bearish) analyst_bias = 'BULLISH';
    else if (bearish > bullish) analyst_bias = 'BEARISH';

    return {
      period: latest.period || null,
      buy,
      hold,
      sell,
      strong_buy,
      strong_sell,
      analyst_bias
    };
  } catch (err: any) {
    return { ...base, error: err.message };
  }
}

// ─── getShortInterest ────────────────────────────────────────────────────────

export async function getShortInterest(ticker: string): Promise<ShortInterestResult> {
  const base: ShortInterestResult = {
    date: null,
    short_interest: null,
    shares_outstanding: null,
    short_float_pct: null
  };

  try {
    // Parallel: short interest + profile
    const [siRes, profileRes] = await Promise.all([
      finnhubFetch(`/stock/short-interest?symbol=${encodeURIComponent(ticker)}`),
      finnhubFetch(`/stock/profile2?symbol=${encodeURIComponent(ticker)}`)
    ]);

    let short_interest: number | null = null;
    let date: string | null = null;
    if (siRes.ok) {
      const siData = await siRes.json() as any;
      // Response shape: { data: [...], symbol }
      const entries: any[] = siData?.data || (Array.isArray(siData) ? siData : []);
      if (entries.length > 0) {
        const latest = entries[entries.length - 1];
        short_interest = latest.shortInterest || latest.short_interest || null;
        date = latest.date || null;
      }
    }

    let shares_outstanding: number | null = null;
    if (profileRes.ok) {
      const profile = await profileRes.json() as any;
      // shareOutstanding is in millions
      shares_outstanding = profile.shareOutstanding || null;
    }

    let short_float_pct: number | null = null;
    if (short_interest !== null && shares_outstanding !== null && shares_outstanding > 0) {
      // shares_outstanding is in millions, short_interest is raw shares
      short_float_pct = parseFloat(((short_interest / (shares_outstanding * 1e6)) * 100).toFixed(2));
    }

    return { date, short_interest, shares_outstanding, short_float_pct };
  } catch (err: any) {
    return { ...base, error: err.message };
  }
}

// ─── getRecentNews ────────────────────────────────────────────────────────────

export async function getRecentNews(ticker: string, daysBack = 2): Promise<NewsItem[]> {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - daysBack);
    const from = fromDate.toISOString().slice(0, 10);

    const res = await finnhubFetch(
      `/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}`
    );
    if (!res.ok) return [];

    const data = await res.json() as any[];
    if (!Array.isArray(data)) return [];

    return data.slice(0, 5).map(item => ({
      headline: item.headline || '',
      summary: item.summary || '',
      url: item.url || '',
      datetime: item.datetime || 0
    }));
  } catch {
    return [];
  }
}
