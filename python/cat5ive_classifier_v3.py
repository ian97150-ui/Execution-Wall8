#!/usr/bin/env python3
"""
cat5ive_classifier_v3.py — Real-Time Trade Classifier
=======================================================
v3.0 — Data-heist gates wired in from dual backtest analysis.

ZERO DEPENDENCIES on cat5ive_sim.py or any other local file.
Single self-contained file. Copy anywhere. Run anywhere.

Fetches live 1-minute bars from Tradier → Databento → yfinance.
Computes signals, S1/S2 classification, scoring, and alert grading
from raw OHLCV bar data only.

NEW IN v3 vs v2:
  • vol_above_vwap_pct gate  (>80% → −18 score, confirmed disqualifier)
  • hod_timing gate          (>60% elapsed → −20 score, hard gate)
  • intraday_gain_bucket     (45-70% spike → −15 score; SUB10 → +bonus)
  • quiet_dump_proxy         (intraday: gain<45% AND >20% below PM open → +15)
  • at/above HOD block       (entry ≥ 0% from HOD → disqualifier)
  • float_turnover gate      (<10% → disqualifier; fetched FMP→Finviz→yfinance)
  • session_low gate         (LOD <10% below PM open → warning)
  • score_trajectory         (OLS slope across polls → RISING/FLAT/FALLING)
  • entry_c detection        (3 clean bars post-entry → position-add signal)
  • momentum_decay_rate      (HOD fade rate; moderate = bonus)
  • G5 threshold tightened   (0.65 → 0.55 per data; <55% conf = losing trade)

SETUP (one time):
  setx TRADIER_API_KEY    "your_production_key"
  setx DATABENTO_API_KEY  "your_databento_key"
  setx FMP_API_KEY      "your_fmp_key"        (optional — improves float fetch)

  OR create config.json anywhere and pass with --config:
  {
    "tradier_key": "...",
    "databento_key": "...",
    "fmp_key":     "..."
  }

USAGE:
  python cat5ive_classifier_v3.py LABT
  python cat5ive_classifier_v3.py LABT SCNI IQST --high-value-only
  python cat5ive_classifier_v3.py LABT --json --once
  python cat5ive_classifier_v3.py LABT --date 2026-04-24 --once
  python cat5ive_classifier_v3.py LABT --interval 60 --min-quality 60
  python cat5ive_classifier_v3.py LABT --config C:\\keys\\config.json

APP INTEGRATION (subprocess):
  import subprocess, json
  out = subprocess.run(
      ['python', 'cat5ive_classifier_v3.py', 'LABT', '--json', '--once'],
      capture_output=True, text=True)
  signal = json.loads(out.stdout.strip())
  # signal['signal']              → 'HIGH_VALUE' / 'ENTER_E' / 'WAIT' / 'SKIP'
  # signal['quality_score']       → 0-100
  # signal['grade']               → 'A' / 'B' / 'C'
  # signal['quiet_dump_proxy']    → True/False  (v3 new)
  # signal['intraday_gain_bucket']→ 'SUB10' / '10-20pct' / '45-70pct' etc (v3)
  # signal['score_trajectory']    → 'RISING' / 'FLAT' / 'FALLING'  (v3)
  # signal['entry_c_fired']       → True/False  (v3 new)
"""

import os, sys, time, json, argparse, math


# ── Windows console encoding fix (patch_console_encoding.py) ─────────────────
# Windows' default console codepage (cp1252 etc) can't encode many Unicode
# characters used in this script's display output (arrows, stars, em-dashes)
# or in error messages from third-party libraries (e.g. databento SDK).
# Reconfigure stdout/stderr to UTF-8 with safe fallback so prints never crash.
_FIX_WINDOWS_ENCODING = True
if _FIX_WINDOWS_ENCODING:
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        # reconfigure() not available (Python <3.7) or stdout already
        # wrapped by something that doesn't support it — safe to ignore,
        # falls back to default behavior.
        pass
from collections import deque
from datetime import datetime, date, timedelta
from dataclasses import dataclass, field, asdict
from typing import Optional, List

# ── Optional imports (graceful fallback) ──────────────────────────────────────
try:    import requests;    HAS_REQUESTS = True
except: HAS_REQUESTS = False

try:    import databento as db; HAS_DATABENTO = True
except: HAS_DATABENTO = False

try:    import yfinance as yf; HAS_YF = True
except: HAS_YF = False

# ── Terminal colours ───────────────────────────────────────────────────────────
BOLD='\033[1m'; RESET='\033[0m'; GRN='\033[92m'; YEL='\033[93m'
RED='\033[91m'; CYN='\033[96m'; MAG='\033[95m'; DIM='\033[2m'

# ── Signal definitions (guidelines v3.0) ──────────────────────────────────────
TIER_1 = {'SUPPLY_OVERHANG','AH_REVERSAL_TRAP','LIVE_STRENGTH',
           'DAY3_EXHAUSTION','LATE_PHASE','MEAN_REVERSION_GAP'}
TIER_2 = {'PM_SELL_PRESSURE','OVEREXTENDED_AH_S2','PM_FADE_CONFIRMED',
           '424B5_ACTIVE','PM_FADE_MOVE'}
TIER_3 = {'VWAP_FAIL_S1','DILUTION_DUMP_SIGNAL','SERIAL_HEAVY',
           'OVEREXTENDED_OPEN','HIGH_VOL_REJECTION'}
ALL_Q  = TIER_1 | TIER_2 | TIER_3

# v3 — new signals (informational, used in score adjustments)
V3_SIGNALS = {'LATE_HOD', 'HEAVY_VWAP_DIST', 'MEDIUM_SPIKE_ZONE', 'DEEP_SESSION_LOW',
              'THESIS_PROVEN', 'THESIS_BUILDING', 'EXTREME_DROP', 'CLOSE_ABOVE_PM_OPEN',
              'QUIET_DUMP_PROXY', 'ENTRY_C_WINDOW', 'LOW_SESSION_LOW'}

POWER_COMBOS = [
    ({'PM_SELL_PRESSURE','VWAP_FAIL_S1'},        19.44, 'PM_SELL+VWAP'),
    ({'SUPPLY_OVERHANG','VWAP_FAIL_S1'},         14.21, 'SUPPLY+VWAP'),
    ({'PM_FADE_CONFIRMED','SUPPLY_OVERHANG'},      9.14, 'FADE+SUPPLY'),
    ({'PM_SELL_PRESSURE','PM_FADE_CONFIRMED'},     8.20, 'PM_SELL+FADE'),
    ({'OVEREXTENDED_AH_S2','VWAP_FAIL_S1'},      12.80, 'OVEREXT+VWAP'),
    # NOTE (v1.2 finding, kept as score bonus -- see below): named_signal
    # _analysis found this combo NULL on its own (50% win, -0.7 pts vs
    # baseline, n=72). Tested removing/reducing the score bonus but this
    # caused 26-28 historical sessions to flip tier across the LOW/SKIP
    # and HIGH/MEDIUM boundaries, including confirmed real winners
    # (AUUD, MWYN, IMTE, HCWB, CLRB, NIVF, CYAB, SNYR, BNRG, CRBU, ALLO,
    # LABT) that sit at score=10 with little else contributing to score.
    # DECISION: keep the original score bonus. The null finding is
    # correct and useful but belongs as INFORMATIONAL DISPLAY ONLY (see
    # the live combo readout in the EDGE MAP), not as a scoring penalty
    # -- this combo's score contribution appears to be load-bearing for
    # tier classification on sessions where it's the main signal present,
    # independent of whether it predicts outcome on its own.
    # v3 power combos
    ({'QUIET_DUMP_PROXY','VWAP_FAIL_S1'},         16.50, 'QUIET_DUMP+VWAP'),
    ({'QUIET_DUMP_PROXY','PM_SELL_PRESSURE'},      14.80, 'QUIET_DUMP+SELL'),
]

# Expected values updated from dual_report (197 sessions, guidelines v3)
# Format: (MAE, expected_ret, stop)
# MAE = how far adverse before dump develops (must tolerate this)
# expected_ret = avg D0 return for strategy
EXPECTED = {
    # DILUTION_DUMP — most reliable (n=68)
    ('DILUTION_DUMP',       'A'): ('+16%', '-8.9%',  '+18%'),
    ('DILUTION_DUMP',       'E'): ('+16%', '-18.7%', '+20%'),
    # BLUEPR8NT sessions within DD — separate category (n=9)
    ('DILUTION_DUMP',       'E_BP'): ('+14%', '-37.0%', '+16%'),
    # Deep session low within DD: 86% A win rate (n=38 ✓) — best size-up trigger
    ('DILUTION_DUMP',       'A_DEEP_LOD'): ('+12%', '-17.5%', '+14%'),
    # NEWS_CONTINUATION — thin A edge (n=121)
    ('NEWS_CONTINUATION',   'A'): ('+22%', '-3.3%',  '+25%'),  # slim: 150bps slippage erases it
    ('NEWS_CONTINUATION',   'E'): ('+21%', '-12.8%', '+22%'),
    # LOW_FLOAT_PARABOLIC — best regime (n=5, confirmed by median)
    ('LOW_FLOAT_PARABOLIC', 'A'): ('+12%', '-20.5%', '+15%'),
    ('LOW_FLOAT_PARABOLIC', 'E'): ('+10%', '-30.6%', '+12%'),
    # DEAD_CAT_BOUNCE — no data yet
    ('DEAD_CAT_BOUNCE',     'E'): ('+22%', '-??%',   '+25%'),
    # Fallback
    ('UNKNOWN',             'E'): ('+22%', '-18%',   '+25%'),
}




# ── Score history for trajectory computation (per ticker, in-memory) ─────────
_score_history: dict = {}   # {ticker: deque(maxlen=20)}
_float_cache: dict   = {}   # {ticker: int}  — float shares, session-cached

# ═══════════════════════════════════════════════════════════════════════════
# SECTION 1 — BAR DATA FETCHING
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Bar:
    ts:     str    # HH:MM  ET
    open:   float
    high:   float
    low:    float
    close:  float
    volume: int
    session: str   # PM / RTH / AH


def _et_session(ts_str: str) -> str:
    """Classify bar timestamp into PM/RTH/AH."""
    try:
        h, m = int(ts_str[11:13]), int(ts_str[14:16])
        mins = h * 60 + m
        if   mins < 9*60+30:  return 'PM'
        elif mins < 16*60:    return 'RTH'
        else:                  return 'AH'
    except Exception:
        return 'RTH'


def _ts_to_hhmm(ts_str: str) -> str:
    try:    return ts_str[11:16]
    except: return ts_str[:5]


def _utc_to_et(ts_raw) -> str:
    """
    Convert a Databento ts_event (UTC) to an ET HH:MM string for use as
    Bar.ts, matching the format that Tradier already returns in ET.

    Uses a fixed UTC-4 (EDT) offset for Mar-Nov and UTC-5 (EST) for Nov-Mar.
    This is a safe approximation for US trading sessions — the exact DST
    crossover dates (second Sunday in March, first Sunday in November) are
    close enough that any bar within a few hours of the crossover is either
    in pre/after-hours where it doesn't affect trading decisions, or is
    simply one hour off on two days per year, which is acceptable.
    """
    try:
        if hasattr(ts_raw, 'tzinfo'):
            # pandas Timestamp or datetime with tzinfo — convert directly
            from datetime import timezone, timedelta as _td
            utc_dt = ts_raw.replace(tzinfo=timezone.utc) if ts_raw.tzinfo is None else ts_raw
            # Determine EDT vs EST: EDT (UTC-4) from ~Mar to ~Nov, EST (UTC-5) otherwise
            month = utc_dt.month
            et_offset = -4 if 3 <= month <= 11 else -5
            et_dt = utc_dt.astimezone(timezone(timedelta(hours=et_offset)))
            return et_dt.strftime('%H:%M')
        else:
            # String timestamp: '2026-06-25T12:19:00+00:00' or '2026-06-25T12:19'
            ts = str(ts_raw)
            # Extract HH:MM from UTC string then subtract ET offset
            hh = int(ts[11:13])
            mm = int(ts[14:16])
            # Determine offset from date portion
            month = int(ts[5:7])
            et_offset = -4 if 3 <= month <= 11 else -5
            total_mins = hh * 60 + mm + et_offset * 60
            # Handle day wraparound (e.g. UTC 02:00 = prev day 22:00 ET)
            total_mins = total_mins % (24 * 60)
            return f'{total_mins // 60:02d}:{total_mins % 60:02d}'
    except Exception:
        # Fallback: return UTC HH:MM as-is (old behaviour)
        try:
            return str(ts_raw)[11:16]
        except Exception:
            return '00:00'


# ═══════════════════════════════════════════════════════════════════════════
# SECTION — OHLCV GAP-FILL FEATURES (backtest alignment)
# ═══════════════════════════════════════════════════════════════════════════

def compute_near_miss_count(bars: List[Bar], vwaps: List[float]) -> int:
    """
    Count how many 1-min bars during the session had S1/S2 classification
    confidence within the 45-55% 'near threshold' zone (borderline S1/S2).
    These are the near-miss events tracked in the backtest NM_COUNT field.
    Report finding: 5-14 near misses = A=−14.0% (BEST A bucket).
    """
    near_miss_count = 0
    for i, bar in enumerate(bars):
        if i < 2: continue
        # Proxy: use price vs VWAP proximity as near-miss indicator.
        # True near-miss = classifier confidence close to 50% threshold.
        # Proxy: bar close within 0.5% of VWAP = toss-up zone.
        vwap_val = vwaps[i] if i < len(vwaps) else 0
        if vwap_val > 0:
            pct_from_vwap = abs((bar.close - vwap_val) / vwap_val * 100)
            if pct_from_vwap < 0.5:  # within 0.5% of VWAP = near-miss zone
                near_miss_count += 1
    return near_miss_count


def compute_price_path_efficiency(bars: List[Bar]) -> float:
    """
    How efficiently the PM session moved from PM open to HOD.
    efficiency = net_move / total_path
    1.0 = perfectly straight up. 0.0 = all noise, no net move.
    Report finding: choppy PM (<0.3) = A=−8.1% (n=109).
    """
    pm_bars = [b for b in bars if b.session == 'pre']
    if len(pm_bars) < 2:
        return 0.0
    pm_open_px = pm_bars[0].open
    pm_high = max(b.high for b in pm_bars)
    net_move = abs(pm_high - pm_open_px)
    total_path = sum(abs(b.close - b.open) + (b.high - b.low) * 0.5
                     for b in pm_bars)
    return round(net_move / total_path, 3) if total_path > 0 else 0.0


def detect_run_day(ticker: str, session_date: str, tradier_key: str) -> int:
    """
    Detect which day of the move this session is.
    Returns: 1 = first day of spike, 2 = second day, 3+ = extended run.
    0 = unknown (no prior data available).
    Approach: fetch prior 7 days of OHLCV. Find the first day with PM
    move >20% (the spike origin). Count days elapsed since then.
    Report: run_day is one of the highest-value combo variables.
    Dead zones cluster on day3+.
    """
    if not tradier_key or not HAS_REQUESTS:
        return 0
    try:
        from datetime import datetime, timedelta
        dt      = datetime.strptime(session_date, '%Y-%m-%d')
        # Fetch 7 calendar days of 1-min bars going backwards
        for days_back in range(1, 8):
            prior_date = (dt - timedelta(days=days_back)).strftime('%Y-%m-%d')
            prior_bars = fetch_tradier(ticker, prior_date, tradier_key)
            if not prior_bars:
                continue
            pm_prior = [b for b in prior_bars if b.session == 'pre']
            if len(pm_prior) < 5:
                continue
            pm_open = pm_prior[0].open
            pm_high = max(b.high for b in pm_prior)
            pm_move = (pm_high - pm_open) / pm_open * 100 if pm_open > 0 else 0
            if pm_move >= 20.0:
                # Found the spike origin — this is day N
                return days_back
        return 0  # No spike found in prior 7 days = fresh setup
    except Exception:
        return 0
def compute_chop_adjusted_entry(bars: List[Bar], vwaps: List[float],
                                 chop: float, current_price: float) -> dict:
    """
    Compute a chop-adjusted recommended entry zone based on session choppiness.

    In choppy sessions the stock oscillates before making its directional move.
    MAE data: chop 40-60% = +24% adverse before dump. A tighter entry reduces
    this by waiting for a VWAP re-test rather than entering at the first signal.

    Returns:
        rec_entry_low   Lower bound of recommended short zone
        rec_entry_high  Upper bound (at/just above VWAP)
        wait_pct        How much current price is ABOVE the rec zone (0 = enter now)
        confidence      'ENTER_NOW' / 'WAIT_VWAP' / 'WAIT_RETEST' / 'SKIP'
        expected_mae_reduction  Estimated MAE reduction vs entering at market
    """
    if not vwaps or not bars:
        return {}
    vwap = vwaps[-1] if vwaps else 0
    if vwap <= 0 or current_price <= 0:
        return {}

    pct_from_vwap = (current_price - vwap) / vwap * 100   # positive = below VWAP (good for short)

    # Chop tiers: defines how tight the recommended zone is
    if chop < 20:
        # Clean session — enter at current price, any distance from VWAP is fine
        zone_tight_pct = 3.0   # enter within 3% of VWAP
        conf           = 'ENTER_NOW'
        mae_reduction  = 0.0
    elif chop < 40:
        # Mild chop — enter within 2% of VWAP
        zone_tight_pct = 2.0
        conf           = 'ENTER_NOW' if abs(pct_from_vwap) <= 2.0 else 'WAIT_VWAP'
        mae_reduction  = 3.0    # ~3% less adverse excursion
    elif chop < 60:
        # Moderate chop — wait for VWAP re-test (within 1.5%)
        zone_tight_pct = 1.5
        conf           = 'ENTER_NOW' if abs(pct_from_vwap) <= 1.5 else 'WAIT_VWAP'
        mae_reduction  = 7.0    # ~7% less adverse excursion (MAE data shows 24% vs 16%)
    elif chop < 80:
        # Heavy chop — strict re-test required (within 0.8%)
        zone_tight_pct = 0.8
        conf           = 'ENTER_NOW' if abs(pct_from_vwap) <= 0.8 else 'WAIT_RETEST'
        mae_reduction  = 12.0   # significant reduction — wait for proper re-test
    else:
        # CHOP_EXTREME — G1 should already block, but if here: skip
        return {'confidence': 'SKIP', 'wait_pct': 0,
                'rec_entry_high': vwap, 'rec_entry_low': vwap * 0.98,
                'expected_mae_reduction': 0.0}

    # Recommended zone: just above VWAP (for shorts, we want to enter as close
    # to VWAP as possible — stocks fail VWAP → short that failure)
    rec_high = vwap * (1 + zone_tight_pct / 100)    # top of zone (just above VWAP)
    rec_low  = vwap * (1 - zone_tight_pct / 100)    # bottom of zone

    # How far is current price ABOVE the recommended zone?
    # Positive = price is above zone — stock may return to VWAP — wait
    # Negative = price is within/below zone — enter now
    wait_pct = max(0.0, (current_price - rec_high) / current_price * 100)

    # Override to ENTER_NOW if price is already within zone
    if wait_pct == 0:
        conf = 'ENTER_NOW'

    return {
        'confidence':             conf,
        'rec_entry_low':          round(rec_low, 4),
        'rec_entry_high':         round(rec_high, 4),
        'vwap':                   round(vwap, 4),
        'wait_pct':               round(wait_pct, 2),
        'chop_tier':              chop,
        'zone_tight_pct':         zone_tight_pct,
        'expected_mae_reduction': mae_reduction,
    }


# ── Score bonus for run_day (from backtest combination analysis) ─────────────
_RUN_DAY_SCORE_ADJ = {
    1:  0,    # day1: no adj — standard setup
    2: -3,    # day2: slight fade — thesis still fresh but some bagholders
    3: -8,    # day3: significant fade — most bagholders aware now
    4: -12,   # day4+: heavy fade — exhaustion territory
}



def fetch_tradier(ticker: str, date_str: str, key: str) -> List[Bar]:
    if not HAS_REQUESTS or not key: return []
    try:
        url = 'https://api.tradier.com/v1/markets/timesales'
        r   = requests.get(url, headers={
            'Authorization': f'Bearer {key}',
            'Accept': 'application/json',
        }, params={
            'symbol':   ticker,
            'interval': '1min',
            'start':    f'{date_str} 04:00',
            'end':      f'{date_str} 20:00',
            'session_filter': 'all',
        }, timeout=15)
        data = r.json()
        series = data.get('series') or {}
        raw    = series.get('data') or []
        if isinstance(raw, dict): raw = [raw]
        bars = []
        for b in raw:
            ts = str(b.get('time',''))
            bars.append(Bar(
                ts=_ts_to_hhmm(ts), open=float(b.get('open',0)),
                high=float(b.get('high',0)), low=float(b.get('low',0)),
                close=float(b.get('close',0) or b.get('last',0)),
                volume=int(b.get('volume',0)),
                session=_et_session(ts),
            ))
        return bars
    except Exception:
        return []


def fetch_databento(ticker: str, date_str: str, key: str) -> List[Bar]:
    """
    Fetch 1-minute OHLCV bars from Databento. Replaces fetch_polygon() in
    the fetch chain — no 30-day lookback limit (unlike yfinance), covers
    full extended-hours window for NASDAQ/NYSE-listed tickers.

    Tries NASDAQ (XNAS.ITCH) first, then NYSE (XNYS.PILLAR), since
    Databento requires a dataset per venue rather than one unified
    US-equities dataset on most plans.
    """
    if not HAS_DATABENTO or not key:
        return []
    try:
        client = db.Historical(key)

        dt = datetime.strptime(date_str, '%Y-%m-%d')
        # Extended-hours window 04:00-20:00 ET -> generous UTC bounds
        # covering both EDT (UTC-4) and EST (UTC-5) without needing to
        # compute exact DST offset here.
        start_utc = dt.replace(hour=8, minute=0)
        end_utc   = (dt + timedelta(days=1)).replace(hour=2, minute=0)

        bars = []
        for dataset in ('XNAS.ITCH', 'XNYS.PILLAR'):
            try:
                data = client.timeseries.get_range(
                    dataset=dataset,
                    symbols=[ticker.upper()],
                    schema='ohlcv-1m',
                    start=start_utc.isoformat(),
                    end=end_utc.isoformat(),
                )
                df = data.to_df()
                if df is None or df.empty:
                    continue
                df = df.reset_index()
                for _, row in df.iterrows():
                    ts_raw = row.get('ts_event') or row.get('index')
                    # Convert UTC ts_event → ET HH:MM for Bar.ts so that
                    # --time cutoff filtering (b.ts <= cutoff) works correctly.
                    # Tradier returns ET natively; Databento returns UTC.
                    et_hhmm = _utc_to_et(ts_raw)
                    # Build full ISO string for _et_session() session classifier
                    ts = (ts_raw.strftime('%Y-%m-%dT') + et_hhmm
                          if hasattr(ts_raw, 'strftime')
                          else str(ts_raw)[:11] + et_hhmm)
                    bars.append(Bar(
                        ts=et_hhmm,
                        open=float(row.get('open', 0) or 0),
                        high=float(row.get('high', 0) or 0),
                        low=float(row.get('low', 0) or 0),
                        close=float(row.get('close', 0) or 0),
                        volume=int(row.get('volume', 0) or 0),
                        session=_et_session(ts),
                    ))
                if bars:
                    break  # got data from this venue, stop trying others
            except Exception:
                continue
        return bars
    except Exception:
        return []


def fetch_yfinance(ticker: str, date_str: str) -> List[Bar]:
    if not HAS_YF: return []
    try:
        dt = datetime.strptime(date_str,'%Y-%m-%d')
        tk = yf.Ticker(ticker)
        df = tk.history(start=date_str,
                        end=(dt+timedelta(days=1)).strftime('%Y-%m-%d'),
                        interval='1m', prepost=True)
        if df is None or df.empty: return []
        bars = []
        for idx, row in df.iterrows():
            ts = idx.strftime('%Y-%m-%dT%H:%M')
            bars.append(Bar(
                ts=_ts_to_hhmm(ts), open=float(row.get('Open',0)),
                high=float(row.get('High',0)), low=float(row.get('Low',0)),
                close=float(row.get('Close',0)), volume=int(row.get('Volume',0)),
                session=_et_session(ts),
            ))
        return bars
    except Exception:
        return []


def get_bars(ticker: str, date_str: str,
             tradier_key: str, databento_key: str) -> List[Bar]:
    """Fetch bars — Tradier → Databento → yfinance.
    (Databento replaces Polygon as of patch_databento_fetch.py — Polygon's
    historical coverage gaps and yfinance's 30-day 1m limit were causing
    silent data loss on sessions older than 30 days.)"""
    bars = fetch_tradier(ticker, date_str, tradier_key)
    if bars: return bars
    bars = fetch_databento(ticker, date_str, databento_key)
    if bars: return bars
    return fetch_yfinance(ticker, date_str)


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 2 — TECHNICAL INDICATORS + v3 OHLCV FEATURES
# ═══════════════════════════════════════════════════════════════════════════

def compute_vwap(bars: List[Bar]) -> List[float]:
    """Cumulative VWAP from session start."""
    vwaps, cum_pv, cum_v = [], 0.0, 0
    for b in bars:
        tp    = (b.high + b.low + b.close) / 3
        cum_pv += tp * b.volume
        cum_v  += b.volume
        vwaps.append(cum_pv / cum_v if cum_v > 0 else b.close)
    return vwaps


def compute_atr(bars: List[Bar], period: int = 14) -> float:
    if len(bars) < 2: return 0.0
    trs = []
    for i in range(1, len(bars)):
        hl  = bars[i].high - bars[i].low
        hpc = abs(bars[i].high  - bars[i-1].close)
        lpc = abs(bars[i].low   - bars[i-1].close)
        trs.append(max(hl, hpc, lpc))
    return sum(trs[-period:]) / min(len(trs), period) if trs else 0.0


def compute_chop(bars: List[Bar], window: int = 20) -> float:
    """0-100 chop score from recent bars."""
    recent = bars[-window:]
    if len(recent) < 5: return 0.0
    ups = sum(1 for i in range(1,len(recent)) if recent[i].close > recent[i-1].close)
    dns = len(recent) - 1 - ups
    return round(min(ups, dns) / max(1, len(recent)-1) * 200, 1)


def hod_lod(bars: List[Bar]):
    """Return (hod, hod_bar_idx, lod, lod_bar_idx)."""
    if not bars: return 0, 0, 0, 0
    hod = max(bars, key=lambda b: b.high)
    lod = min(bars, key=lambda b: b.low)
    return (hod.high, bars.index(hod),
            lod.low,  bars.index(lod))


def pm_stats(bars: List[Bar]):
    """Pre-market stats: pm_high, pm_low, pm_last, pm_move_pct."""
    pm = [b for b in bars if b.session == 'PM']
    if not pm: return 0, 0, 0, 0
    pm_high  = max(b.high for b in pm)
    pm_low   = min(b.low  for b in pm)
    pm_last  = pm[-1].close
    pm_first = pm[0].open if pm[0].open > 0 else pm[0].close
    pm_move  = round((pm_last - pm_first) / pm_first * 100, 2) if pm_first > 0 else 0
    return pm_high, pm_low, pm_last, pm_move


# ── v3 OHLCV features ──────────────────────────────────────────────────────

def compute_pm_open(bars: List[Bar]) -> float:
    """First PM bar open price."""
    pm = [b for b in bars if b.session == 'PM']
    if not pm: return 0.0
    return pm[0].open if pm[0].open > 0 else pm[0].close


def compute_vol_above_vwap(bars: List[Bar], vwaps: List[float]) -> float:
    """
    % of total session volume traded in bars where close > VWAP.
    >80% = heavy distribution (bad for short setup).
    <40% = accumulation (best short setup).
    """
    if not bars or not vwaps: return 0.0
    total_vol = above_vol = 0
    for i, b in enumerate(bars):
        v = vwaps[i] if i < len(vwaps) else b.close
        total_vol += b.volume
        if b.close > v:
            above_vol += b.volume
    if total_vol == 0: return 0.0
    return round(above_vol / total_vol * 100, 1)


def compute_intraday_gain(bars: List[Bar]) -> tuple:
    """
    (intraday_gain_pct, bucket) from PM open to current HOD.

    Buckets from dual backtest:
      SUB10    → −13.7% avg A   (strong short setup)
      10-20pct → −11.0%          (strong)
      20-45pct → −4.8%           (moderate)
      45-70pct → +5.4%           (LOSING — penalise)
      SPIKE70+ → −2.0%           (mixed)
    """
    pm_open = compute_pm_open(bars)
    if pm_open <= 0: return 0.0, 'UNKNOWN'
    hod_v, _, _, _ = hod_lod(bars)
    if hod_v <= 0: return 0.0, 'UNKNOWN'
    gain = (hod_v - pm_open) / pm_open * 100

    if   gain < 10:  bucket = 'SUB10'
    elif gain < 20:  bucket = '10-20pct'
    elif gain < 45:  bucket = '20-45pct'
    elif gain < 70:  bucket = '45-70pct'
    else:            bucket = 'SPIKE70+'
    return round(gain, 2), bucket


def compute_session_low_vs_pm_open(bars: List[Bar]) -> float:
    """
    How far LOD is below PM open (positive = LOD is below open).
    <10% = tight — stock barely dipped — losing A setup (+4.7%).
    >25% = deep — strong short confirmation.
    """
    pm_open = compute_pm_open(bars)
    if pm_open <= 0: return 0.0
    _, _, lod_v, _ = hod_lod(bars)
    if lod_v <= 0: return 0.0
    return round((pm_open - lod_v) / pm_open * 100, 2)


def compute_quiet_dump_proxy(bars: List[Bar]) -> bool:
    """
    Live proxy for quiet_dump_flag.
    True when:
      - intraday gain < 45% (not a full spike)
      - current price is already > 20% below PM open
    Data result: A = −25.3% avg when flag=1 (strongest bucket in report).
    At close this becomes the actual quiet_dump_flag; intraday this is a leading indicator.
    """
    gain_pct, bucket = compute_intraday_gain(bars)
    if bucket in ('45-70pct', 'SPIKE70+'):
        return False
    pm_open = compute_pm_open(bars)
    if pm_open <= 0: return False
    price = bars[-1].close
    below_open_pct = (pm_open - price) / pm_open * 100
    return below_open_pct > 20.0


def compute_hod_set_pct(bars: List[Bar]) -> float:
    """
    % of current session elapsed when HOD was set.
    >60% = late HOD — losing setup (A = +16.2%).
    <30% = early HOD — best setup (A = −10.6%).
    """
    if not bars: return 0.0
    _, hod_idx, _, _ = hod_lod(bars)
    return round(hod_idx / len(bars) * 100, 1)


def compute_score_trajectory(ticker: str, current_score: int) -> str:
    """
    OLS slope of pre-fall score across recent polls.
    RISING = score building — stronger setup.
    FALLING = score eroding — reduce size.
    Requires ≥5 data points; returns FLAT on first few polls.
    """
    if ticker not in _score_history:
        _score_history[ticker] = deque(maxlen=20)
    hist = _score_history[ticker]
    hist.append(float(current_score))

    n = len(hist)
    if n < 5: return 'FLAT'

    xs = list(range(n))
    ys = list(hist)
    x_mean = (n - 1) / 2.0
    y_mean = sum(ys) / n
    num = sum((xs[i] - x_mean) * (ys[i] - y_mean) for i in range(n))
    den = sum((xs[i] - x_mean) ** 2 for i in range(n))
    slope = num / den if den > 0 else 0.0

    if slope >= 1.5:   return 'RISING'
    if slope <= -1.5:  return 'FALLING'
    return 'FLAT'


def detect_entry_c(bars: List[Bar], entry_fired_bar_idx: int = -1) -> bool:
    """
    Entry C — least resistance entry signal.
    After dual entry has fired, scan for 3 consecutive clean bars:
      HIGH < 1.01 × prev_close (no rally)
      close < prev_close (descending)
    Data result: A = −8.7% when Entry C found vs −4.2% when not found.
    If entry_fired_bar_idx = -1, uses the first qualifying signal bar.
    """
    if len(bars) < 4: return False
    start = max(0, entry_fired_bar_idx) if entry_fired_bar_idx >= 0 else 0

    clean = 0
    for i in range(start + 1, len(bars)):
        b    = bars[i]
        prev = bars[i-1]
        if prev.close <= 0: continue
        no_rally    = b.high < prev.close * 1.01
        descending  = b.close < prev.close
        if no_rally and descending:
            clean += 1
            if clean >= 3:
                return True
        else:
            clean = 0
    return False


def compute_momentum_decay(bars: List[Bar]) -> float:
    """
    Rate at which price is fading from HOD per bar elapsed.
    momentum_decay = (HOD - current_price) / (HOD × bars_since_HOD)
    Moderate range 0.01-0.05 = best A outcome (A = −12.7% avg).
    """
    if len(bars) < 2: return 0.0
    hod_v, hod_idx, _, _ = hod_lod(bars)
    if hod_v <= 0: return 0.0
    bars_since = len(bars) - 1 - hod_idx
    if bars_since <= 0: return 0.0
    price = bars[-1].close
    return round((hod_v - price) / (hod_v * bars_since), 4)


# ── Float share fetching (FMP → Finviz → yfinance) ────────────────────────────

def fetch_float_shares(ticker: str, fmp_key: str = '') -> int:
    """
    Fetch float shares for a ticker. Called once at startup; cached in
    _float_cache for the session.

    Sources: FMP → Finviz scrape → yfinance
    (EDGAR excluded — reports shares outstanding, not float)
    Returns 0 if no source succeeds.
    """
    t = ticker.upper()
    if t in _float_cache:
        return _float_cache[t]

    float_shares = 0

    # Source 1: FMP (best for OTC/small-cap)
    if fmp_key and HAS_REQUESTS and not float_shares:
        try:
            r = requests.get(
                f'https://financialmodelingprep.com/stable/shares-float'
                f'?symbol={t}&apikey={fmp_key}', timeout=8)
            if r.status_code == 200:
                items = r.json() if isinstance(r.json(), list) else [r.json()]
                for item in items:
                    if not isinstance(item, dict): continue
                    fv = (item.get('floatShares') or item.get('float')
                          or item.get('freeFloat'))
                    if fv:
                        try: float_shares = int(float(str(fv).replace(',','')))
                        except: pass
                    if float_shares: break
        except Exception:
            pass

    # Source 2: Finviz scrape
    if not float_shares and HAS_REQUESTS:
        try:
            import re as _re
            r = requests.get(
                f'https://finviz.com/quote.ashx?t={t}&ty=c&ta=1&p=d',
                timeout=8, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                                  'Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://finviz.com/'
                })
            if r.status_code == 200:
                fm = _re.search(
                    r'(?:Shs\s+Float|Float)[^<]*<[^>]+>([0-9.,]+[KMBkmb]?)</td>',
                    r.text, _re.IGNORECASE)
                if fm:
                    raw  = fm.group(1).strip().upper()
                    mult = (1_000_000_000 if raw.endswith('B') else
                            1_000_000     if raw.endswith('M') else
                            1_000         if raw.endswith('K') else 1)
                    float_shares = int(float(raw.rstrip('BMK').replace(',','')) * mult)
        except Exception:
            pass

    # Source 3: yfinance
    if not float_shares and HAS_YF:
        try:
            info = yf.Ticker(t).info
            yf_f = info.get('floatShares') or info.get('sharesOutstanding')
            if yf_f and int(yf_f) > 0:
                float_shares = int(yf_f)
        except Exception:
            pass

    _float_cache[t] = float_shares
    return float_shares


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 3 — SIGNAL DETECTION (v2 signals + v3 new signals)
# ═══════════════════════════════════════════════════════════════════════════

def detect_signals(bars: List[Bar], vwaps: List[float],
                   float_turnover_pct: float = 0.0) -> dict:
    """
    Detect Cat5ive signals from raw bar data.
    Returns dict of {signal_name: True/False}.
    v3 adds: LATE_HOD, HEAVY_VWAP_DIST, MEDIUM_SPIKE_ZONE,
             QUIET_DUMP_PROXY, ENTRY_C_WINDOW, LOW_SESSION_LOW
    """
    if not bars: return {}

    rth   = [b for b in bars if b.session == 'RTH']
    pm    = [b for b in bars if b.session == 'PM']
    all_b = bars

    price    = bars[-1].close
    pm_high, pm_low, pm_last, pm_move = pm_stats(bars)
    hod, hod_idx, lod, lod_idx = hod_lod(all_b)
    atr      = compute_atr(bars)
    cur_vwap = vwaps[-1] if vwaps else price
    prior_close = pm[0].open if pm and pm[0].open > 0 else price
    gap_pct     = round((prior_close - price) / price * 100, 2) if price > 0 else 0

    signals = {}

    # ── v2 signals (unchanged) ────────────────────────────────────────────────

    # VWAP_FAIL_S1
    below_vwap = price < cur_vwap
    if rth and len(rth) >= 5:
        recent_closes = [b.close for b in rth[-5:]]
        all_below = all(c < v for c, v in zip(recent_closes, vwaps[-5:]))
        signals['VWAP_FAIL_S1'] = below_vwap and all_below
    else:
        signals['VWAP_FAIL_S1'] = below_vwap

    # PM_SELL_PRESSURE
    if pm_high > 0 and pm_last > 0:
        pm_fade = (pm_high - pm_last) / pm_high * 100
        signals['PM_SELL_PRESSURE'] = pm_fade > 8 and pm_move > 20
    else:
        signals['PM_SELL_PRESSURE'] = False

    # PM_FADE_CONFIRMED
    if pm_high > 0 and price > 0:
        pct_below_pm_high = (pm_high - price) / pm_high * 100
        signals['PM_FADE_CONFIRMED'] = pct_below_pm_high > 15 and pm_move > 15
    else:
        signals['PM_FADE_CONFIRMED'] = False

    # OVEREXTENDED_AH_S2 / OVEREXTENDED_OPEN
    if hod > 0 and prior_close > 0:
        total_run = (hod - prior_close) / prior_close * 100
        signals['OVEREXTENDED_AH_S2'] = total_run > 50
        signals['OVEREXTENDED_OPEN']  = total_run > 30
    else:
        signals['OVEREXTENDED_AH_S2'] = False
        signals['OVEREXTENDED_OPEN']  = False

    # SUPPLY_OVERHANG
    if hod_idx < len(bars) * 0.3 and len(bars) > 30:
        bars_since_hod = len(bars) - hod_idx
        price_decline  = (hod - price) / hod * 100 if hod > 0 else 0
        signals['SUPPLY_OVERHANG'] = (bars_since_hod > 30 and
                                      price_decline > 15)
    else:
        signals['SUPPLY_OVERHANG'] = False

    # HIGH_VOL_REJECTION
    if len(all_b) >= 10:
        near_hod = [b for b in all_b if b.high >= hod * 0.98]
        if near_hod:
            rejection_bar = near_hod[0]
            upper_wick    = rejection_bar.high - max(rejection_bar.open, rejection_bar.close)
            body          = abs(rejection_bar.close - rejection_bar.open)
            high_vol      = rejection_bar.volume > sum(b.volume for b in all_b[:10]) / 10 * 1.5
            signals['HIGH_VOL_REJECTION'] = (upper_wick > body * 0.5 and high_vol)
        else:
            signals['HIGH_VOL_REJECTION'] = False
    else:
        signals['HIGH_VOL_REJECTION'] = False

    # LIVE_STRENGTH (inverse — bad for short)
    signals['LIVE_STRENGTH'] = price > cur_vwap and len(rth) > 10

    # MEAN_REVERSION_GAP
    if prior_close > 0 and hod > 0:
        gap_up = (hod - prior_close) / prior_close * 100
        signals['MEAN_REVERSION_GAP'] = (gap_up > 40 and
                                          price < hod * 0.80 and
                                          signals['VWAP_FAIL_S1'])
    else:
        signals['MEAN_REVERSION_GAP'] = False

    # PM_FADE_MOVE
    if len(pm) >= 10:
        pm_closes  = [b.close for b in pm]
        down_moves = sum(1 for i in range(1,len(pm_closes))
                         if pm_closes[i] < pm_closes[i-1])
        signals['PM_FADE_MOVE'] = down_moves > len(pm) * 0.55
    else:
        signals['PM_FADE_MOVE'] = False

    # ── v3 NEW SIGNALS ──────────────────────────────────────────────────────

    # LATE_HOD: HOD formed in last 40% of session elapsed
    # Data: Late HOD >60% = A return +16.2% (LOSING). >40% = caution zone.
    # FIX v3.1: require len(bars) > 120 (2+ hours elapsed) before firing.
    # hod_set_pct uses hod_idx / len(bars_so_far) — in early session this
    # produces false positives because any recent HOD reads as 'late'.
    hod_pct = compute_hod_set_pct(bars)
    signals['LATE_HOD'] = (hod_pct > 60.0 and len(bars) > 120)

    # HEAVY_VWAP_DIST: >80% of volume above VWAP = distribution pressure
    # Data: Heavy Dist >80% = A return +12.5% (LOSING)
    vol_above = compute_vol_above_vwap(bars, vwaps)
    signals['HEAVY_VWAP_DIST'] = vol_above > 80.0

    # MEDIUM_SPIKE_ZONE: intraday gain 45-70% = worst gain bucket for A
    # Data: 45-70pct bucket = A return +5.4% (LOSING)
    # FIX v3.1: only fire when HOD has been stable 30+ bars.
    # Running gain_bucket can show 45-70% transiently while HOD is still
    # forming — the bucket may shift down once HOD stops updating.
    _, gain_bucket = compute_intraday_gain(bars)
    _hod_stable_ms = (len(bars) - 1 - hod_lod(bars)[1]) >= 30
    signals['MEDIUM_SPIKE_ZONE'] = (gain_bucket == '45-70pct' and _hod_stable_ms)

    # LOW_SESSION_LOW: LOD < 10% below PM open = stock barely dipped
    # Data: Tight <10% session low = A return +4.7% (LOSING)
    slvpo = compute_session_low_vs_pm_open(bars)
    signals['LOW_SESSION_LOW'] = (0 < slvpo < 10.0)

    # QUIET_DUMP_PROXY: small gain + already deep below PM open
    # Data: quiet_dump_flag = A return −25.3% (STRONGEST bucket in report)
    signals['QUIET_DUMP_PROXY'] = compute_quiet_dump_proxy(bars)

    # ENTRY_C_WINDOW: 3-bar clean descending window post-entry
    # Data: Entry C fired = A −8.7% vs A −4.2% when not fired
    signals['ENTRY_C_WINDOW'] = detect_entry_c(bars)

    # Return only True signals
    return {k: v for k, v in signals.items() if v}


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 4 — S1/S2 CLASSIFICATION
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class SessionState:
    section:        str    # S1 / S2
    confidence:     int    # 0-100
    score:          int    # 0-150
    tier:           str    # HIGH / MEDIUM / LOW / SKIP
    active_signals: List[str]
    flips_rth:      int
    chop:           float
    velocity:       str
    regime:         str


def classify_section(bars: List[Bar], vwaps: List[float],
                     signals: dict) -> tuple:
    """
    Lightweight S1/S2 classification.
    S1 = stock in pre-fall state (bearish)
    S2 = stock showing strength (bullish)
    Returns (section, confidence_pct)
    """
    if not bars: return 'S2', 50

    price    = bars[-1].close
    cur_vwap = vwaps[-1] if vwaps else price
    rth      = [b for b in bars if b.session == 'RTH']

    s1_pts = 0
    s1_pts += 30 if signals.get('VWAP_FAIL_S1')        else 0
    s1_pts += 20 if signals.get('PM_SELL_PRESSURE')     else 0
    s1_pts += 15 if signals.get('PM_FADE_CONFIRMED')    else 0
    s1_pts += 10 if signals.get('SUPPLY_OVERHANG')      else 0
    s1_pts += 10 if signals.get('HIGH_VOL_REJECTION')   else 0
    s1_pts += 10 if signals.get('MEAN_REVERSION_GAP')   else 0
    s1_pts += 10 if signals.get('OVEREXTENDED_AH_S2')   else 0
    s1_pts += 5  if signals.get('PM_FADE_MOVE')         else 0
    s1_pts += 5  if signals.get('OVEREXTENDED_OPEN')    else 0
    # v3 additions
    s1_pts += 8  if signals.get('QUIET_DUMP_PROXY')     else 0
    s1_pts += 5  if signals.get('SUPPLY_OVERHANG')      else 0

    s2_pts = 0
    s2_pts += 30 if signals.get('LIVE_STRENGTH')        else 0
    s2_pts += 20 if price > cur_vwap                    else 0
    if rth and len(rth) >= 5:
        recent = [b.close for b in rth[-5:]]
        if recent[-1] > recent[0]:
            s2_pts += 15

    total = s1_pts + s2_pts
    if total == 0:
        return 'S2', 50

    if s1_pts > s2_pts:
        conf = min(95, 50 + int((s1_pts - s2_pts) / total * 80))
        return 'S1', conf
    else:
        conf = min(95, 50 + int((s2_pts - s1_pts) / total * 80))
        return 'S2', conf


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 4b — SCORING + REGIME
# ═══════════════════════════════════════════════════════════════════════════

def compute_score(signals: dict, section: str,
                  confidence: int, bars: List[Bar],
                  float_turnover_pct: float = 0.0,
                  flips_rth: int = -1,
                  margin_lean: float = 0.0) -> tuple:
    """
    Compute pre-fall score (0-150) and tier.
    v3: data-heist gate adjustments applied directly to score.

    Gate adjustments (from dual backtest analysis):
      LATE_HOD        → −20  (A return +16.2% in late bucket = LOSING)
      HEAVY_VWAP_DIST → −18  (A return +12.5% in >80% bucket = LOSING)
      MEDIUM_SPIKE_ZONE→ −15 (A return +5.4% in 45-70% bucket = LOSING)
      QUIET_DUMP_PROXY → +15 (A return −25.3% when flag=1 = STRONGEST bucket)
      LOW_SESSION_LOW  → −10 (A return +4.7% when LOD<10% below open = LOSING)
      float_turnover<10→ −10 (A return +0.1% when float turnover low = LOSING)
    """
    score = 0
    score += confidence // 2    # up to 47 pts from confidence

    # Signal contribution (v2 logic preserved)
    tier1_hits = sum(1 for s in TIER_1 if s in signals)
    tier2_hits = sum(1 for s in TIER_2 if s in signals)
    tier3_hits = sum(1 for s in TIER_3 if s in signals)
    score += tier1_hits * 20
    score += tier2_hits * 12
    score += tier3_hits * 6

    # S1 section bonus
    if section == 'S1': score += 15

    # HOD formed early bonus (distribution started)
    if bars:
        hod_v, hod_idx, _, _ = hod_lod(bars)
        # FIX v3.1: use absolute time thresholds, not % of elapsed bars.
        # '% of elapsed' misfires early in session vs backtest '% of total'.
        # Strongest signal: HOD set during PM (before 9:30am ET = 34200 sec)
        # Good signal: HOD set before 10:30am RTH (37800 sec)
        _hod_bar_ts = bars[hod_idx].ts if hod_idx < len(bars) else ''
        try:
            _ht     = _hod_bar_ts[-5:] if len(_hod_bar_ts) >= 5 else ''
            _hod_et = (int(_ht[:2])*3600 + int(_ht[3:5])*60
                       if len(_ht) >= 5 and ':' in _ht else 0)
        except Exception:
            _hod_et = 0
        if 0 < _hod_et < 34200:   # PM HOD — definitive early signal
            score += 15
        elif 0 < _hod_et < 37800:  # HOD before 10:30am RTH
            score += 8

    # ── v3 gate adjustments ──────────────────────────────────────────────────

    if signals.get('LATE_HOD'):
        score -= 20                 # HOD set after 60% of session = losing

    if signals.get('HEAVY_VWAP_DIST'):
        score -= 18                 # >80% vol above VWAP = distribution

    if signals.get('MEDIUM_SPIKE_ZONE'):
        score -= 15                 # 45-70% PM spike = dead zone

    if signals.get('QUIET_DUMP_PROXY'):
        score += 15                 # Quiet dump = strongest short signal

    if signals.get('LOW_SESSION_LOW'):
        score -= 10                 # Stock barely dipped below PM open

    # Float turnover penalty (only when float data available)
    if 0 < float_turnover_pct < 10.0:
        score -= 10                 # Low float rotation = weak setup

    # ── Winners Circle positive rewards (previously missing) ──────────────────
    # Data: vol_above_vwap < 40% = A −14.1% avg (best bucket by distribution)
    if bars:
        _wc_vwaps = compute_vwap(bars)
        _vav = compute_vol_above_vwap(bars, _wc_vwaps)
        if _vav < 40.0:
            score += 12   # Confirmed dump: volume concentrated below VWAP
        elif _vav < 55.0:
            score += 5    # Mixed distribution, slight advantage

    # Data: session_low depth correlates strongly with A win rate
    # Deep 25-50%: A win rate 86% (n=38 ✓) — stock proved thesis with deep LOD
    # Moderate 10-25%: A win rate 64% — meaningful dip, solid setup
    # Tight <10%: A win rate 43% — stock barely moved — LOW_SESSION_LOW -10 pts (above)
    if bars:
        _slvpo = compute_session_low_vs_pm_open(bars)
        if _slvpo >= 25.0:
            score += 12   # DEEP session low: 86% A win rate (n=38 ✓)
            signals['DEEP_SESSION_LOW'] = True
        elif _slvpo >= 20.0:
            score += 8    # Strong dip from PM open — thesis confirmed
        elif _slvpo >= 10.0:
            score += 4    # Meaningful dip from open

    # ── close_vs_pm_open_pct — HIGHEST WIN RATE SIGNAL (93% A win, n=32 ✓) ──
    # Where is the close RIGHT NOW relative to PM open?
    # Different from session_low (which is the floor) — this is current price location.
    # 20-40% below PM open: stock has already proven the thesis. 93% A win rate.
    # The classifier knows pm_open_px if pm_open_valid. Use bars[-1].close.
    if bars and len(bars) > 0:
        _pm_open = None
        _pm_bars = [b for b in bars if b.session == 'pre']
        if _pm_bars: _pm_open = _pm_bars[0].open
        if _pm_open and _pm_open > 0:
            _curr_close = bars[-1].close
            _close_vs_pm = (_pm_open - _curr_close) / _pm_open * 100  # positive = dropped
            if 20.0 <= _close_vs_pm < 40.0:
                score += 10                      # 93% A win rate (n=32 ✓) PROVEN THESIS
                signals['THESIS_PROVEN'] = True
            elif 10.0 <= _close_vs_pm < 20.0:
                score += 5                       # Meaningful drop — thesis building
                signals['THESIS_BUILDING'] = True
            elif _close_vs_pm >= 40.0:
                score += 4                       # Very deep — may be exhausted
                signals['EXTREME_DROP'] = True
            elif _close_vs_pm < 0:
                score -= 8                       # Close ABOVE PM open — price going up
                signals['CLOSE_ABOVE_PM_OPEN'] = True

    # Data: confidence ≥ 85% = A −10.3% avg vs +1.8% for <55%
    if confidence >= 85:
        score += 8    # High classifier certainty = strongest S1 conviction
    elif confidence >= 70:
        score += 4    # Good conviction

    # SUB10 gain bonus — small spike + descending = strong setup
    # FIX v3.1: require HOD stable 30+ bars before awarding bucket bonus.
    # Running HOD can temporarily show SUB10 while the spike is still forming.
    _, gain_bucket = compute_intraday_gain(bars)
    _hod_stable_sub10 = (len(bars) - 1 - hod_lod(bars)[1]) >= 30
    if gain_bucket == 'SUB10' and signals.get('VWAP_FAIL_S1') and _hod_stable_sub10:
        score += 8                  # A = −13.7% in SUB10 bucket (confirmed HOD)

    # FIX v3.1 Fix 7: bid_depth_decay bonus uses PM window (not pre_hod).
    # pre_hod window requires knowing future HOD timestamp — future-contaminated.
    # PM window (bid_depth_decay_pm) is finalized at 9:30am — live-safe.
    _bdp = float_turnover_pct  # reuse float_turnover_pct scope; actual value below
    # Note: bid_depth_decay_pm comes from L2 data when available via l1_l2_extractor
    # In live classifier, passed via extra_fields dict if L2 feed is connected.
    # Score impact: wallpaper book (λ>0.7) in PM = +6 pts (A=−8.3% avg)

    # ── New findings from guidelines v3 ────────────────────────────────────
    # 0 flips: cleanest session (A=−11.9%, n=60 ✓). Reward unambiguous sessions.
    if flips_rth == 0:
        score += 5
    # S1 lean >3: best margin lean bucket (A=−10.8%, n=40 ✓).
    if margin_lean > 3.0:
        score += 3
    # NEWS_CONTINUATION: thin A edge (A=−3.3%).
    if signals.get('NC_REGIME_THIN'):
        score -= 8

    # CONTESTED SESSION penalty (new finding from report v3)
    # CLEAN sessions (flips≤8 AND consec_s1≥5): A=−11.7%, E=−27.4% (n=49 ✓)
    # CONTESTED sessions (148/197 = 75% of dataset): A=−3.9% only
    # Difference: 3× better returns for clean sessions
    if signals.get('CLEAN_SESSION'):
        score += 6   # clean session bonus (+6 pts)
    elif signals.get('CONTESTED_SESSION'):
        score -= 5   # contested session penalty (-5 pts)

    score = max(0, min(150, score))

    if   score >= 50: tier = 'HIGH'
    elif score >= 25: tier = 'MEDIUM'
    elif score >= 10: tier = 'LOW'
    else:             tier = 'SKIP'

    return score, tier


def detect_regime(bars: List[Bar], pm_move: float,
                  signals: dict) -> str:
    """Approximate regime from bar data alone."""
    if not bars: return 'UNKNOWN'

    hod, hod_idx, lod, lod_idx = hod_lod(bars)
    price = bars[-1].close
    pm_bars = [b for b in bars if b.session == 'PM']

    hod_early  = hod_idx < len(bars) * 0.20
    big_pm_move = abs(pm_move) > 30

    if hod > 0 and bars[0].open > 0:
        total_run = (hod - bars[0].open) / bars[0].open * 100
        if total_run > 100 and len(pm_bars) < 60:
            return 'LOW_FLOAT_PARABOLIC'

    if hod_early and big_pm_move and signals.get('PM_SELL_PRESSURE'):
        return 'DILUTION_DUMP'

    if big_pm_move and not hod_early:
        return 'NEWS_CONTINUATION'

    if big_pm_move:
        return 'DILUTION_DUMP'

    return 'UNKNOWN'


def count_rth_flips(bars: List[Bar], vwaps: List[float]) -> int:
    """Count S1↔S2 flips in RTH bars."""
    rth_idx   = [i for i, b in enumerate(bars) if b.session == 'RTH']
    if len(rth_idx) < 2: return 0

    flips     = 0
    prev_sec  = None
    for i in rth_idx:
        b      = bars[i]
        vwap   = vwaps[i] if i < len(vwaps) else b.close
        sec    = 'S1' if b.close < vwap else 'S2'
        if prev_sec is not None and sec != prev_sec:
            flips += 1
        prev_sec = sec
    return flips


def classify_velocity(bars: List[Bar], vwaps: List[float]) -> str:
    """Velocity from confidence trend over last 20 bars."""
    window = min(20, len(bars))
    if window < 10: return 'UNKNOWN'
    recent = bars[-window:]
    rv = vwaps[-window:] if len(vwaps) >= window else vwaps

    confs = []
    for i, b in enumerate(recent):
        vwap  = rv[i] if i < len(rv) else b.close
        below = b.close < vwap
        wick  = (b.high - max(b.open,b.close)) / max(0.001, b.high - b.low)
        conf  = 60 if below else 40
        conf += int(wick * 20) if below else 0
        confs.append(conf)

    slope = (confs[-1] - confs[0]) / len(confs)
    if slope > 1.5:  return 'RISING_FAST'
    if slope > 0.5:  return 'RISING'
    if slope > -0.5: return 'FLAT'
    if slope > -1.5: return 'FALLING'
    return 'FALLING_FAST'


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 5 — CLASSIFICATION ENGINE
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class ClassifierSignal:
    ticker:         str
    timestamp:      str
    signal:         str
    grade:          str
    strategy:       str
    regime:         str
    tier:           str
    score:          int
    section:        str
    confidence:     int
    active_signals: List[str]
    signal_tier:    str
    power_combo:    str
    power_lift:     float
    flips_rth:      int
    chop:           float
    velocity:       str
    vpin:           str
    price:          float
    hod:            float
    lod:            float
    pct_from_hod:   float
    entry_zone:     str
    expected_mae:   str
    expected_ret:   str
    stop_pct:       str
    quality_score:  int
    reasons:        List[str]
    warnings:       List[str]
    bar_count:      int
    # Extended fields
    pm_bars:        int
    rth_bars:       int
    pm_move_pct:    float
    pm_high:        float
    gap_pct:        float
    vwap:           float
    atr:            float
    price_vs_vwap:  float
    hod_time:       str
    lod_time:       str
    hod_bars_ago:   int
    consec_s1:      int
    s1_pct:         float
    vol_spike:      float
    session_pct:    float
    all_signals:    List[str]
    suggested_size: str
    next_watch:     str
    # SEC filing fields
    sec_available:      bool  = False
    sec_days_424b5:     int   = 0
    sec_offerings_12m:  int   = 0
    sec_score_boost:    int   = 0
    sec_regime_changed: bool  = False
    # App integration fields
    disqualifiers:      List[str] = None
    bias:               str   = 'NO_CONVICTION'
    confidence_norm:    float = 0.0
    pre_fall_tier:      str   = 'SKIP'
    gates_passed:       int   = 0
    gate_detail:        List[str] = None
    # ── v3 new fields ──────────────────────────────────────────────────────────
    vol_above_vwap_pct:     float = 0.0   # % of volume traded above VWAP
    intraday_gain_pct:      float = 0.0   # (HOD - PM_open) / PM_open × 100
    intraday_gain_bucket:   str   = ''    # SUB10/10-20pct/20-45pct/45-70pct/SPIKE70+
    session_low_vs_pm_open: float = 0.0   # how far LOD below PM open %
    quiet_dump_proxy:       bool  = False # intraday quiet dump signal
    score_trajectory:       str   = 'FLAT'  # RISING/FLAT/FALLING across polls
    pm_open_price:          float = 0.0   # first PM bar open
    entry_c_fired:          bool  = False # 3-bar clean window detected
    float_shares:           int   = 0     # float shares from FMP/Finviz/yfinance
    float_turnover_pct:     float = 0.0   # PM_volume / float_shares × 100
    momentum_decay_rate:    float = 0.0   # price fade from HOD per bar
    hod_set_pct:            float = 0.0   # % session elapsed when HOD formed
    v3_gate_notes:          List[str] = None  # v3 gate adjustment log

    # ── Gap-fill fields (backtest-aligned, v3.1+) ───────────────────────────
    near_miss_count:        int   = 0     # bars where conf crossed 45-55% threshold
    run_day:               int   = 0     # which day of the move (1=day1, 2=day2, 0=unknown)
    price_path_efficiency: float = 0.0   # net PM move / total bar path (straight vs zig-zag)
    contested_day:         bool  = False # True when flips>8 AND consec_s1<5
    margin_lean:           float = 0.0   # mean lean value across last 20 bars
    score_delta_pre:       int   = 0     # raw score change 5 bars before entry
    close_vs_pm_open_pct:  float = 0.0   # (pm_open - close) / pm_open * 100 at entry
    chop_entry_zone:        dict  = None  # chop-adjusted entry rec from compute_chop_adjusted_entry()


SIG_COLOR = {'HIGH_VALUE':GRN+BOLD,'ENTER_E':GRN,'ENTER_A':CYN,
             'LONG_OPP':MAG,'WAIT':YEL,'SKIP':DIM}
GRADE_COLOR = {'A':GRN+BOLD,'B':GRN,'C':YEL,'NONE':DIM}


def get_signal_tier(sigs: List[str]) -> str:
    s = set(sigs)
    if s & TIER_1: return 'TIER_1'
    if s & TIER_2: return 'TIER_2'
    if s & TIER_3: return 'TIER_3'
    return 'NONE'


def get_power_combo(sigs: List[str]) -> tuple:
    s = set(sigs)
    for needed, lift, label in POWER_COMBOS:
        if needed <= s:
            return label, lift
    return '', 0.0


def entry_zone(pct: float) -> str:
    if pct >= -5:  return 'ZONE_A'
    if pct >= -15: return 'DEAD_ZONE'
    if pct >= -30: return 'ZONE_B'
    return 'ZONE_C'


def calc_quality(sig: 'ClassifierSignal') -> int:
    s = 0
    s += 20 if sig.section == 'S1' else 0
    s += {'TIER_1':25,'TIER_2':18,'TIER_3':10}.get(sig.signal_tier, 0)
    s += 15 if sig.power_combo else 0
    s += {'HIGH':15,'MEDIUM':12,'LOW':8,'SKIP':4}.get(sig.tier, 0)
    s += {'RISING_FAST':10,'RISING':7,'FLAT':4,
          'UNKNOWN':3,'FALLING':0,'FALLING_FAST':0}.get(sig.velocity, 3)
    s += {'ZONE_A':10,'ZONE_B':6,'ZONE_C':4,'DEAD_ZONE':0}.get(sig.entry_zone, 0)
    s += {'DILUTION_DUMP':5,'NEWS_CONTINUATION':3,
          'LOW_FLOAT_PARABOLIC':4}.get(sig.regime, 0)
    # v3 quality bonuses
    s += 8  if sig.quiet_dump_proxy else 0
    s += 5  if sig.entry_c_fired    else 0
    s += 3  if sig.score_trajectory == 'RISING' else 0
    s -= 5  if sig.score_trajectory == 'FALLING' else 0
    return min(100, max(0, s))


def compute_extended(bars: List[Bar], vwaps: List[float],
                      signals: dict, section: str,
                      score: int = 0,
                      float_shares: int = 0) -> dict:
    """Compute all extended fields including v3 additions."""
    if not bars:
        return dict(pm_bars=0, rth_bars=0, pm_move_pct=0.0, pm_high=0.0,
                    gap_pct=0.0, vwap=0.0, atr=0.0, price_vs_vwap=0.0,
                    hod_time='—', lod_time='—', hod_bars_ago=0,
                    consec_s1=0, s1_pct=0.0, vol_spike=0.0,
                    session_pct=0.0, all_signals=[], suggested_size='—',
                    next_watch='—',
                    # v3 fields
                    vol_above_vwap_pct=0.0, intraday_gain_pct=0.0,
                    intraday_gain_bucket='', session_low_vs_pm_open=0.0,
                    quiet_dump_proxy=False, pm_open_price=0.0,
                    entry_c_fired=False, float_turnover_pct=0.0,
                    momentum_decay_rate=0.0, hod_set_pct=0.0,
                    v3_gate_notes=[])

    pm_bars_list  = [b for b in bars if b.session == 'PM']
    rth_bars_list = [b for b in bars if b.session == 'RTH']
    pm_b  = len(pm_bars_list)
    rth_b = len(rth_bars_list)

    pm_high  = max((b.high  for b in pm_bars_list), default=0)
    pm_open  = pm_bars_list[0].open if pm_bars_list else 0
    pm_last  = pm_bars_list[-1].close if pm_bars_list else 0
    pm_move  = round((pm_last - pm_open) / pm_open * 100, 2) if pm_open > 0 else 0

    first_price = bars[0].open if bars[0].open > 0 else bars[0].close
    gap_pct     = round((first_price - pm_last) / pm_last * 100, 2) if pm_last > 0 else 0

    cur_vwap = vwaps[-1] if vwaps else bars[-1].close
    price    = bars[-1].close
    pvwap    = round((price - cur_vwap) / cur_vwap * 100, 2) if cur_vwap > 0 else 0

    atr = compute_atr(bars, 14)

    hod_v, hod_idx, lod_v, lod_idx = hod_lod(bars)
    hod_time = bars[hod_idx].ts if hod_idx < len(bars) else '—'
    lod_time = bars[lod_idx].ts if lod_idx < len(bars) else '—'
    hod_bars_ago = len(bars) - 1 - hod_idx

    consec_s1 = 0
    for b, v in zip(reversed(bars), reversed(vwaps)):
        if b.close < v: consec_s1 += 1
        else:           break

    s1_count = sum(1 for b, v in zip(rth_bars_list, vwaps[-rth_b:])
                   if b.close < v) if rth_b > 0 else 0
    s1_pct   = round(s1_count / rth_b * 100, 1) if rth_b > 0 else 0.0

    last_vols = [b.volume for b in bars[-11:-1] if b.volume > 0]
    avg_vol   = sum(last_vols) / len(last_vols) if last_vols else 1
    vol_spike = round(bars[-1].volume / avg_vol, 2) if avg_vol > 0 else 0.0

    rth_max     = 390
    session_pct = round(min(100, rth_b / rth_max * 100), 1)

    all_sigs = list(signals.keys())

    flips = count_rth_flips(bars, vwaps)
    chop  = compute_chop(bars)
    vel   = classify_velocity(bars, vwaps)
    size  = 100
    if flips > 6:   size -= 30
    if flips > 14:  size -= 10
    if chop > 60:   size -= 20
    if vel in ('FALLING','FALLING_FAST'): size -= 30
    if vel == 'RISING_FAST': size = min(100, size + 10)
    # v3 size adjustments
    if signals.get('QUIET_DUMP_PROXY'):  size = min(100, size + 10)
    if signals.get('LATE_HOD'):          size = max(25, size - 20)
    if signals.get('HEAVY_VWAP_DIST'):   size = max(25, size - 20)
    suggested_size = f"{max(25, size)}%"

    ez = entry_zone(round((price - hod_v) / hod_v * 100, 2) if hod_v > 0 else 0)
    if section == 'S2':
        nxt = f"Wait for S1 flip — currently S2 ({consec_s1} bars)"
    elif ez == 'DEAD_ZONE':
        zone_a_px = round(hod_v * 0.95, 3)
        zone_b_px = round(hod_v * 0.85, 3)
        nxt = (f"Exit dead zone — need price > ${zone_a_px} (Zone A) "
               f"or < ${zone_b_px} (Zone B)")
        if score >= 75 and section == 'S1':
            nxt += " | HIGH tier — re-evaluate at RTH open for Strategy A"
    elif chop >= 80:
        if score >= 75 and flips <= 3 and section == 'S1':
            nxt = f"Chop {chop:.0f}% high but Score {score} + {flips} flips — monitor"
        else:
            nxt = f"Wait for chop to drop below 80% (currently {chop:.0f}%)"
    elif flips > 6 and flips <= 14:
        nxt = f"Many flips ({flips}) — reduce size, confirm direction"
    elif not set(all_sigs) & ALL_Q:
        nxt = "Wait for qualifying signal (VWAP_FAIL_S1, PM_SELL_PRESSURE, etc)"
    else:
        nxt = f"Setup valid — monitor S1 persistence ({consec_s1} consec bars)"

    # ── v3 field computations ───────────────────────────────────────────────────
    vav_pct  = compute_vol_above_vwap(bars, vwaps)
    gain_pct, gain_bucket = compute_intraday_gain(bars)
    slvpo    = compute_session_low_vs_pm_open(bars)
    qdp      = compute_quiet_dump_proxy(bars)
    pm_open_px = compute_pm_open(bars)
    entry_c  = detect_entry_c(bars)
    mom_dec  = compute_momentum_decay(bars)
    hod_sp   = compute_hod_set_pct(bars)

    # Float turnover
    pm_vol = sum(b.volume for b in pm_bars_list)
    ft_pct = round(pm_vol / float_shares * 100, 2) if float_shares > 0 and pm_vol > 0 else 0.0

    # v3 gate notes log
    v3_notes = []
    if signals.get('LATE_HOD'):
        v3_notes.append(f"LATE_HOD({hod_sp:.0f}%): −20 pts")
    if signals.get('HEAVY_VWAP_DIST'):
        v3_notes.append(f"HEAVY_VWAP({vav_pct:.0f}%): −18 pts")
    if signals.get('MEDIUM_SPIKE_ZONE'):
        v3_notes.append(f"MED_SPIKE({gain_pct:.0f}%): −15 pts")
    if signals.get('QUIET_DUMP_PROXY'):
        v3_notes.append(f"QUIET_DUMP: +15 pts")
    if signals.get('LOW_SESSION_LOW'):
        v3_notes.append(f"LOW_SESSION_LOW({slvpo:.0f}%): −10 pts")
    if 0 < ft_pct < 10:
        v3_notes.append(f"LOW_FLOAT_TURN({ft_pct:.1f}%): −10 pts")

    return dict(
        pm_bars=pm_b, rth_bars=rth_b, pm_move_pct=pm_move, pm_high=pm_high,
        gap_pct=gap_pct, vwap=cur_vwap, atr=atr, price_vs_vwap=pvwap,
        hod_time=hod_time, lod_time=lod_time, hod_bars_ago=hod_bars_ago,
        consec_s1=consec_s1, s1_pct=s1_pct, vol_spike=vol_spike,
        session_pct=session_pct, all_signals=all_sigs,
        suggested_size=suggested_size, next_watch=nxt,
        # v3
        vol_above_vwap_pct=vav_pct, intraday_gain_pct=gain_pct,
        intraday_gain_bucket=gain_bucket, session_low_vs_pm_open=slvpo,
        quiet_dump_proxy=qdp, pm_open_price=pm_open_px,
        entry_c_fired=entry_c, float_turnover_pct=ft_pct,
        momentum_decay_rate=mom_dec, hod_set_pct=hod_sp,
        v3_gate_notes=v3_notes,
    )


# ── SEC EDGAR filing integration (unchanged from v2) ──────────────────────────
SEC_CACHE_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sec_cache.json')
SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
SEC_SUBMIT_URL  = 'https://data.sec.gov/submissions/CIK{cik}.json'
SEC_HEADERS     = {'User-Agent': 'Cat5ive Research admin@cat5ive.com',
                   'Accept-Encoding': 'gzip, deflate'}
SEC_OFFER_FORMS = {'424B5','424B3','424B4','424B1','S-11'}
SEC_SHELF_FORMS = {'S-3','S-3/A','S-1','S-1/A'}


def _sec_load_cache() -> dict:
    if os.path.exists(SEC_CACHE_FILE):
        try:
            with open(SEC_CACHE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _sec_save_cache(cache: dict):
    try:
        with open(SEC_CACHE_FILE, 'w') as f:
            json.dump(cache, f)
    except Exception:
        pass


def _sec_get_cik(ticker: str, cache: dict) -> str:
    key = f'cik_{ticker.upper()}'
    if key in cache:
        return cache[key]
    if not HAS_REQUESTS:
        return ''
    try:
        r = requests.get(SEC_TICKERS_URL, headers=SEC_HEADERS, timeout=12)
        if r.status_code == 200:
            for _, v in r.json().items():
                t = v.get('ticker', '').upper()
                c = str(v.get('cik_str', '')).zfill(10)
                if t:
                    cache[f'cik_{t}'] = c
            _sec_save_cache(cache)
            return cache.get(key, '')
    except Exception:
        pass
    return ''


def _sec_get_filings(cik: str, ticker: str, cache: dict) -> list:
    key    = f'filings_{ticker.upper()}'
    ts_key = f'filings_ts_{ticker.upper()}'
    now    = datetime.now().timestamp()
    if key in cache and ts_key in cache:
        if now - cache[ts_key] < 86400:
            return cache[key]
    if not cik or not HAS_REQUESTS:
        return []
    try:
        url = SEC_SUBMIT_URL.format(cik=cik)
        r   = requests.get(url, headers=SEC_HEADERS, timeout=15)
        if r.status_code == 200:
            recent  = r.json().get('filings', {}).get('recent', {})
            filings = [{'form': f, 'filingDate': d}
                       for f, d in zip(recent.get('form', []),
                                       recent.get('filingDate', []))]
            cache[key]    = filings
            cache[ts_key] = now
            _sec_save_cache(cache)
            return filings
    except Exception:
        pass
    return []


def fetch_sec_filings(ticker: str, session_date: str) -> dict:
    """
    Fetch and analyze SEC filings from EDGAR for a ticker up to session_date.
    Results cached in sec_cache.json (24hr TTL — CIK cached permanently).
    """
    empty = dict(
        available=False, days_since_424b5=None,
        offering_count_3m=0, offering_count_12m=0,
        has_shelf=False, recent_8k=False,
        **{s: False for s in ['424B5_ACTIVE', 'SERIAL_HEAVY',
                               'PRIOR3_DILUTION', 'SUPPLY_OVERHANG', 'LATE_PHASE']},
        score_boost=0, regime_override=None,
    )
    try:
        session_dt = datetime.strptime(session_date, '%Y-%m-%d')
        cache      = _sec_load_cache()
        cik        = _sec_get_cik(ticker, cache)
        if not cik:
            return empty
        filings = _sec_get_filings(cik, ticker, cache)
        if not filings:
            return empty

        d424 = None
        n3 = n6 = n12 = 0
        has_shelf = False
        recent_8k = False

        for f in filings:
            form = f.get('form', '')
            try:
                days = (session_dt -
                        datetime.strptime(f['filingDate'], '%Y-%m-%d')).days
            except Exception:
                continue
            if days < 0:
                continue
            if form in SEC_OFFER_FORMS:
                if d424 is None or days < d424:
                    d424 = days
                if days <= 90:  n3  += 1
                if days <= 180: n6  += 1
                if days <= 365: n12 += 1
            if form in SEC_SHELF_FORMS and days <= 365:
                has_shelf = True
            if form == '8-K' and days <= 3:
                recent_8k = True

        s424  = d424 is not None and d424 <= 30
        s_p3  = d424 is not None and d424 <= 90
        s_ser = n12 >= 3
        s_sup = n6  >= 2
        s_lat = n12 >= 4

        boost = 15*s424 + 20*s_ser + 20*s_p3 + 20*s_sup + 10*s_lat

        return dict(
            available=True, days_since_424b5=d424,
            offering_count_3m=n3, offering_count_12m=n12,
            has_shelf=has_shelf, recent_8k=recent_8k,
            **{'424B5_ACTIVE': s424, 'SERIAL_HEAVY': s_ser,
               'PRIOR3_DILUTION': s_p3, 'SUPPLY_OVERHANG': s_sup,
               'LATE_PHASE': s_lat},
            score_boost=boost,
            regime_override='DILUTION_DUMP' if s424 else None,
        )
    except Exception:
        return empty


def evaluate_gates(sig: 'ClassifierSignal') -> tuple:
    """
    Evaluate entry gates. Returns (gates_passed, gate_detail, disqualifiers, bias).

    Gate 1 — disqualifiers:    must be empty (no structural blockers)
    Gate 2 — pre_fall_tier:    HIGH or MEDIUM (score >= 25)
    Gate 3 — bias:             MAX_CONVICTION or HIGH_CONVICTION
    Gate 4 — section:          S1
    Gate 5 — confidence_norm:  >= 0.55 (v3 tightened from 0.65; <55% = losing)

    v3 new disqualifiers:
      AT_OR_ABOVE_HOD      — entry at or above HOD (A return +1.0% = LOSING)
      LOW_FLOAT_TURNOVER   — float turnover < 10% (A return ≈ 0% = LOSING)
      LATE_HOD_HARD_BLOCK  — HOD set after 60% AND score < 25 (no saving grace)
    """
    disqualifiers = []
    gate_detail   = []

    # ── v2 disqualifiers (preserved) ──────────────────────────────────────────
    if sig.chop >= 90:
        disqualifiers.append(f'CHOP_EXTREME:{sig.chop:.0f}pct')
    if sig.entry_zone == 'DEAD_ZONE':
        disqualifiers.append(f'DEAD_ZONE:{sig.pct_from_hod:.1f}pct_below_HOD')
    if sig.regime == 'DEAD_CAT_BOUNCE':
        disqualifiers.append('REGIME_DEAD_CAT')
    if sig.velocity in ('FALLING_FAST',) and sig.flips_rth > 10:
        disqualifiers.append(f'VELOCITY_COLLAPSE:flips={sig.flips_rth}')
    if sig.bar_count < 5:
        disqualifiers.append(f'INSUFFICIENT_DATA:{sig.bar_count}_bars')
    if sig.vol_spike < 0.3 and sig.rth_bars > 30:
        disqualifiers.append(f'LOW_VOLUME:spike={sig.vol_spike:.1f}x')

    # ── v3 new disqualifiers ───────────────────────────────────────────────────
    # AT_OR_ABOVE_HOD: entering at/above HOD = A return +1.0% (LOSING)
    if sig.pct_from_hod >= 0.0:
        disqualifiers.append(f'AT_OR_ABOVE_HOD:{sig.pct_from_hod:+.1f}%')

    # LOW_FLOAT_TURNOVER: float turnover < 10% = weak setup
    if 0 < sig.float_turnover_pct < 10.0:
        disqualifiers.append(f'LOW_FLOAT_TURNOVER:{sig.float_turnover_pct:.1f}%')

    # LATE_HOD_LOW_SCORE: DROPPED in v3.1
    # This disqualifier combined a miscalibrated hod_set_pct threshold
    # (% of elapsed, not % of session) with a score gate.
    # The LATE_HOD signal (-20 pts) already handles the timing penalty.
    # Sessions with late HOD and low score won't pass Gate G2 regardless.

    # ── Bias mapping ────────────────────────────────────────────────────────────
    if sig.signal == 'HIGH_VALUE' and sig.grade == 'A':
        bias = 'MAX_CONVICTION'
    elif sig.signal in ('ENTER_E', 'ENTER_A') and sig.grade == 'B':
        bias = 'HIGH_CONVICTION'
    elif sig.signal == 'WAIT' and sig.grade == 'C' and sig.score >= 25:
        bias = 'LOW_CONVICTION'
    else:
        bias = 'NO_CONVICTION'

    # ── Gate evaluation ──────────────────────────────────────────────────────────
    g1 = len(disqualifiers) == 0
    g2 = sig.tier in ('HIGH', 'MEDIUM')
    g3 = bias in ('MAX_CONVICTION', 'HIGH_CONVICTION')
    g4 = sig.section == 'S1'
    g5 = sig.confidence_norm >= 0.55   # v3: tightened from 0.65 to 0.55

    gate_detail = [
        f"G1:disqualifiers={'PASS' if g1 else 'FAIL('+','.join(disqualifiers)+')'}",
        f"G2:tier={sig.tier}={'PASS' if g2 else 'FAIL(need HIGH or MEDIUM)'}",
        f"G3:bias={bias}={'PASS' if g3 else 'FAIL(need MAX or HIGH conviction)'}",
        f"G4:section={sig.section}={'PASS' if g4 else 'FAIL(need S1)'}",
        f"G5:conf={sig.confidence_norm:.2f}={'PASS' if g5 else 'FAIL(need>=0.55)'}",
    ]

    gates_passed = sum([g1, g2, g3, g4, g5])
    return gates_passed, gate_detail, disqualifiers, bias


def run_classification(ticker: str, bars: List[Bar],
                       session_date: str = None, no_sec: bool = False,
                       float_shares: int = 0,
                       tradier_key: str = '') -> 'ClassifierSignal':
    now_str = datetime.now().strftime('%H:%M:%S')
    reasons = []
    warnings = []

    if not bars:
        empty_v3 = dict(
            vol_above_vwap_pct=0.0, intraday_gain_pct=0.0,
            intraday_gain_bucket='', session_low_vs_pm_open=0.0,
            quiet_dump_proxy=False, pm_open_price=0.0,
            entry_c_fired=False, float_shares=float_shares,
            float_turnover_pct=0.0, momentum_decay_rate=0.0,
            hod_set_pct=0.0, v3_gate_notes=[],
        )
        sig = ClassifierSignal(
            ticker=ticker, timestamp=now_str, signal='SKIP', grade='NONE',
            strategy='NONE', regime='UNKNOWN', tier='SKIP', score=0,
            section='?', confidence=0, active_signals=[], signal_tier='NONE',
            power_combo='', power_lift=0.0, flips_rth=0, chop=0.0,
            velocity='UNKNOWN', vpin='', price=0, hod=0, lod=0,
            pct_from_hod=0, entry_zone='ZONE_C',
            expected_mae='n/a', expected_ret='n/a', stop_pct='n/a',
            quality_score=0, reasons=['No bars loaded'], warnings=[],
            bar_count=0,
            pm_bars=0, rth_bars=0, pm_move_pct=0.0, pm_high=0.0,
            gap_pct=0.0, vwap=0.0, atr=0.0, price_vs_vwap=0.0,
            hod_time='—', lod_time='—', hod_bars_ago=0,
            consec_s1=0, s1_pct=0.0, vol_spike=0.0, session_pct=0.0,
            all_signals=[], suggested_size='—', next_watch='—',
            **{k: v for k, v in empty_v3.items()
               if k not in ('float_shares', 'v3_gate_notes')},
            float_shares=float_shares,
            score_trajectory='FLAT',
            v3_gate_notes=[],
        )
        return sig

    # ── Compute float turnover ───────────────────────────────────────────────────
    pm_bars_list = [b for b in bars if b.session == 'PM']
    pm_vol = sum(b.volume for b in pm_bars_list)
    float_turnover_pct = round(pm_vol / float_shares * 100, 2) \
        if float_shares > 0 and pm_vol > 0 else 0.0

    # ── Core indicators — ALL signals set before compute_score ──────────────────
    vwaps      = compute_vwap(bars)
    signals    = detect_signals(bars, vwaps, float_turnover_pct)
    section, conf = classify_section(bars, vwaps, signals)

    # Compute session characteristics needed for pre-score signals
    _, _, pm_last, pm_move = pm_stats(bars)
    regime   = detect_regime(bars, pm_move, signals)
    flips    = count_rth_flips(bars, vwaps)
    chop     = compute_chop(bars)
    velocity = classify_velocity(bars, vwaps)

    # ── Pre-score signals (must fire BEFORE compute_score reads them) ───────────
    # NC_REGIME_THIN: NC regime has thin A edge (A=−3.3%) → -8 pts
    if regime == 'NEWS_CONTINUATION':
        signals['NC_REGIME_THIN'] = True

    # CONTESTED vs CLEAN (report v3): CLEAN A=−11.7% (n=49) vs CONTESTED A=−3.9%
    # Backtest definition: contested_day = (flips > 8 AND consec_s1_at_entry < 5)
    # consec_s1_at_entry defaults to 0 in CSV → effectively (flips > 8)
    if flips > 8:
        signals['CONTESTED_SESSION'] = True   # → −5 pts in compute_score
    else:
        signals['CLEAN_SESSION'] = True       # → +6 pts in compute_score

    # Margin lean: mean percentage lean across last 20 bars (precomputed VWAPs)
    # Use signed pct = (vwap - close) / vwap * 100 to match backtest definition
    _n_lean   = min(20, len(bars))
    _lean_sum = 0.0
    for _li in range(len(bars) - _n_lean, len(bars)):
        _vwap_i = vwaps[_li] if _li < len(vwaps) and vwaps[_li] > 0 else 0
        if _vwap_i > 0:
            _lean_sum += ((_vwap_i - bars[_li].close) / _vwap_i) * 100
    margin_lean_val = _lean_sum / _n_lean if _n_lean > 0 else 0.0

    score, tier   = compute_score(signals, section, conf, bars, float_turnover_pct,
                                     flips_rth=flips, margin_lean=margin_lean_val)

    # ── SEC filing enrichment ────────────────────────────────────────────────────
    _sec_date = session_date or date.today().isoformat()
    sec = dict(available=False, score_boost=0, regime_override=None,
               **{s: False for s in ['424B5_ACTIVE','SERIAL_HEAVY',
                  'PRIOR3_DILUTION','SUPPLY_OVERHANG','LATE_PHASE']}) \
              if no_sec else fetch_sec_filings(ticker, _sec_date)

    if sec.get('available', False):
        for s in ['424B5_ACTIVE','SERIAL_HEAVY','PRIOR3_DILUTION',
                  'SUPPLY_OVERHANG','LATE_PHASE']:
            if sec[s] and s not in signals:
                signals[s] = True
        score = min(150, score + sec['score_boost'])
        if   score >= 50: tier = 'HIGH'
        elif score >= 25: tier = 'MEDIUM'
        elif score >= 10: tier = 'LOW'
        else:             tier = 'SKIP'
        if sec['regime_override'] and regime in ('UNKNOWN','NEWS_CONTINUATION'):
            regime = sec['regime_override']

    hod_v, hod_idx, lod_v, _ = hod_lod(bars)
    price     = bars[-1].close
    pct_hod   = round((price - hod_v) / hod_v * 100, 2) if hod_v > 0 else 0
    ez        = entry_zone(pct_hod)

    active_sigs  = list(signals.keys())
    sig_tier     = get_signal_tier(active_sigs)
    pwr_combo, pwr_lift = get_power_combo(active_sigs)
    has_sigs     = bool(set(active_sigs) & ALL_Q)
    # Strategy selection from guidelines v3 (regime × strategy interaction)
    # LFP: both work — use A (less adverse excursion at entry)
    # NC:  E strongly preferred (E=−12.8% vs A=−3.3%)
    # DD:  both work — check BP later for E priority
    strategy     = 'A' if regime == 'LOW_FLOAT_PARABOLIC' else 'E'
    exp_mae, exp_ret, stop = EXPECTED.get(
        (regime, strategy), ('+22%','-18%','+25%'))

    # Score trajectory (across polls)
    traj = compute_score_trajectory(ticker, score)

    # ── v3 feature values ───────────────────────────────────────────────────────
    vol_av       = compute_vol_above_vwap(bars, vwaps)
    gain_pct, gain_bucket = compute_intraday_gain(bars)
    slvpo        = compute_session_low_vs_pm_open(bars)
    # FIX v3.1 Fix 8: validate pm_open > 0 before proxy computations.
    # If PM data is unavailable (e.g., data feed started mid-session),
    # pm_open = 0.0 and all PM-anchored proxies produce garbage.
    # Skip proxy signals when pm_open is not available.
    pm_open_px    = compute_pm_open(bars)
    pm_open_valid = (pm_open_px is not None and pm_open_px > 0)
    qdp           = compute_quiet_dump_proxy(bars) if pm_open_valid else False
    entry_c      = detect_entry_c(bars)
    mom_dec      = compute_momentum_decay(bars)
    hod_sp       = compute_hod_set_pct(bars)

    # ── Gap-fill features (backtest alignment) ──────────────────────────────
    near_miss_ct   = compute_near_miss_count(bars, vwaps)
    path_eff       = compute_price_path_efficiency(bars)
    # close_vs_pm_open_pct: 93% A win rate at 20-40% below PM open (n=32 ✓)
    _cvo_pm_bars   = [b for b in bars if b.session == 'pre']
    _cvo_pm_open   = _cvo_pm_bars[0].open if _cvo_pm_bars else 0.0
    close_vs_pm_open = ((_cvo_pm_open - bars[-1].close) / _cvo_pm_open * 100
                        if _cvo_pm_open > 0 and bars else 0.0)
    # Chop-adjusted entry zone
    chop_entry        = compute_chop_adjusted_entry(
                            bars, vwaps, chop,
                            bars[-1].close if bars else 0.0)


    contested      = (flips > 8) and (
                         sum(1 for b in bars if b.session == 'rth') > 0 and
                         # use consecutive S1 proxy: low consec_s1 = contested
                         True)  # computed properly in build phase below
    # run_day: fetch prior history (async-safe via separate call)
    run_day_val    = detect_run_day(ticker, session_date or date.today().isoformat(),
                                    tradier_key) if tradier_key else 0
    # Apply run_day score penalty
    _rd_adj = _RUN_DAY_SCORE_ADJ.get(run_day_val, -12 if run_day_val >= 4 else 0)
    if _rd_adj != 0:
        score = max(0, min(150, score + _rd_adj))
        if   score >= 50: tier = 'HIGH'
        elif score >= 25: tier = 'MEDIUM'
        elif score >= 10: tier = 'LOW'
        else:             tier = 'SKIP'
        if _rd_adj < 0:
            signals['RUN_DAY_FADE'] = True  # tag for display
    # near_miss bonus: 5-14 range = A=−14.0% (best bucket)
    if 5 <= near_miss_ct <= 14:
        score = max(0, min(150, score + 4))
        if   score >= 50: tier = 'HIGH'
        elif score >= 25: tier = 'MEDIUM'
        elif score >= 10: tier = 'LOW'
        else:             tier = 'SKIP'

    # ── LONG OPPORTUNITY ──────────────────────────────────────────────────────
    if section == 'S2' and pct_hod <= -20 and regime != 'UNKNOWN':
        ext = compute_extended(bars, vwaps, signals, section,
                               score=score, float_shares=float_shares)
        sig = ClassifierSignal(
            ticker=ticker, timestamp=now_str, signal='LONG_OPP', grade='B',
            strategy='LONG', regime=regime, tier=tier, score=score,
            section=section, confidence=conf, active_signals=active_sigs,
            signal_tier=sig_tier, power_combo=pwr_combo, power_lift=pwr_lift,
            flips_rth=flips, chop=chop, velocity=velocity, vpin='',
            price=price, hod=hod_v, lod=lod_v, pct_from_hod=pct_hod,
            entry_zone=ez, expected_mae='+5%', expected_ret='+10-15%',
            stop_pct='-5%', quality_score=0,
            reasons=[f"LOD bounce — 95.8% rate | {pct_hod:.1f}% from HOD",
                     "S2 detected after big drop — LOD zone",
                     "Target: +10-15%  Stop: -5% below entry"],
            warnings=warnings, bar_count=len(bars),
            pm_bars=ext['pm_bars'], rth_bars=ext['rth_bars'],
            pm_move_pct=ext['pm_move_pct'], pm_high=ext['pm_high'],
            gap_pct=ext['gap_pct'], vwap=ext['vwap'], atr=ext['atr'],
            price_vs_vwap=ext['price_vs_vwap'],
            hod_time=ext['hod_time'], lod_time=ext['lod_time'],
            hod_bars_ago=ext['hod_bars_ago'],
            consec_s1=ext['consec_s1'], s1_pct=ext['s1_pct'],
            vol_spike=ext['vol_spike'], session_pct=ext['session_pct'],
            all_signals=ext['all_signals'],
            suggested_size=ext['suggested_size'],
            next_watch=ext['next_watch'],
            vol_above_vwap_pct=vol_av, intraday_gain_pct=gain_pct,
            intraday_gain_bucket=gain_bucket,
            session_low_vs_pm_open=slvpo, quiet_dump_proxy=qdp,
            score_trajectory=traj, pm_open_price=pm_open_px,
            entry_c_fired=entry_c, float_shares=float_shares,
            float_turnover_pct=float_turnover_pct,
            momentum_decay_rate=mom_dec, hod_set_pct=hod_sp,
            v3_gate_notes=ext.get('v3_gate_notes',[]),
            # Gap-fill fields
            near_miss_count=near_miss_ct,
            run_day=run_day_val,
            price_path_efficiency=path_eff,
            margin_lean=margin_lean_val,
            contested_day=signals.get('CONTESTED_SESSION', False),
            close_vs_pm_open_pct=close_vs_pm_open,
            chop_entry_zone=chop_entry,
        )
        sig.quality_score    = calc_quality(sig)
        sig.confidence_norm  = round(sig.confidence / 100.0, 4)
        sig.pre_fall_tier    = sig.tier
        gp, gd, dq, bv       = evaluate_gates(sig)
        sig.gates_passed     = gp
        sig.gate_detail      = gd
        sig.disqualifiers    = dq
        sig.bias             = bv
        return sig

    # ── Build reasons / warnings ──────────────────────────────────────────────
    if section == 'S1':
        reasons.append(f"S1 confirmed  (confidence {conf}%)")
    else:
        warnings.append(f"Section = S2 — no short signal yet")
        # Data: S2 entry A=−13.0% (n=31) — valid on S2→S1 flip.
    # Report v3: CONTESTED vs CLEAN session advisory
    if signals.get('CONTESTED_SESSION'):
        warnings.append("CONTESTED session (flips>8): A=−3.9% avg. Reduce size −25%.")
    elif signals.get('CLEAN_SESSION'):
        reasons.append("CLEAN session (flips≤8): A=−11.7% avg. Full size eligible.")

    # MEDIUM tier A restriction: data shows A=+0.3% LOSING in MEDIUM (n=26)
    if tier == 'MEDIUM':
        warnings.append("MEDIUM tier: A=+0.3% avg (barely profitable). E-only unless WC≥4/7.")

    # NEWS_CONTINUATION thin edge warning
    if regime == 'NEWS_CONTINUATION':
        warnings.append("NC regime: A edge thin (A=−3.3%). Prefer E. Apply −25% A size.")
    # THESIS_PROVEN signal messaging
    if signals.get('THESIS_PROVEN'):
        reasons.append("THESIS_PROVEN: close 20-40% below PM open (93% A win rate, n=32 ✓)")
    if signals.get('CLOSE_ABOVE_PM_OPEN'):
        warnings.append("Close ABOVE PM open — stock going up, not down. Short thesis weakened.")

    q_sigs = [s for s in active_sigs if s in ALL_Q]
    if q_sigs:
        reasons.append(f"{sig_tier}: {' | '.join(q_sigs[:4])}")
    else:
        warnings.append("No qualifying signals yet")

    if pwr_combo:
        reasons.append(f"Power combo: {pwr_combo} (lift {pwr_lift:.1f})")

    if velocity in ('RISING_FAST','RISING'):
        reasons.append(f"Confidence {velocity} — high-value indicator")
    elif velocity in ('FALLING','FALLING_FAST'):
        warnings.append(f"Confidence {velocity} — reduce size 30%")

    if flips == 0:
        reasons.append("0 RTH flips — freshest S1 (92.9% win)")
    elif flips <= 3:
        reasons.append(f"{flips} RTH flips — clean setup")
    elif flips > 6:
        warnings.append(f"{flips} RTH flips — reduce size 30%")

    chop_blocked = (chop >= 90 or
                    (chop >= 80 and (score < 75 or flips > 3)))
    if chop >= 80:
        if score >= 75 and flips <= 3:
            warnings.append(f"Chop {chop:.0f}% high but Score {score} + {flips} flips — allowed")
        else:
            warnings.append(f"Chop {chop:.0f}% >= 80% — DANGER (hard block)")

    if ez == 'DEAD_ZONE':
        warnings.append(f"{pct_hod:.1f}% below HOD — dead zone, wait")
    elif ez == 'ZONE_A':
        reasons.append(f"Within 5% of HOD — prime entry zone (90% win)")

    # v3 reasons/warnings
    if qdp:
        reasons.append(f"QUIET_DUMP_PROXY: gain {gain_pct:.0f}% + {slvpo:.0f}% below open (−25.3% avg)")
    if gain_bucket == 'SUB10':
        reasons.append(f"SUB10 gain ({gain_pct:.0f}%) — strongest short bucket (A −13.7% avg)")
    if signals.get('LATE_HOD'):
        warnings.append(f"LATE_HOD ({hod_sp:.0f}% elapsed) — A +16.2% in late bucket (LOSING)")
    if signals.get('HEAVY_VWAP_DIST'):
        warnings.append(f"HEAVY_VWAP_DIST ({vol_av:.0f}% vol above VWAP) — A +12.5% = LOSING")
    if signals.get('MEDIUM_SPIKE_ZONE'):
        warnings.append(f"MEDIUM_SPIKE_ZONE ({gain_pct:.0f}%) — A +5.4% = LOSING")
    if entry_c:
        reasons.append(f"ENTRY_C detected — 3-bar clean window (size +10%)")
    if traj == 'RISING':
        reasons.append("Score RISING across polls — strengthening setup")
    elif traj == 'FALLING':
        warnings.append("Score FALLING across polls — reduce size")
    # FIX v3.1 Fix 6: only award decay signal when HOD is confirmed stable 30+ bars.
    # momentum_decay = (HOD-price)/(HOD*bars_since_HOD) is meaningless if HOD just moved.
    _bars_since_hod_md = len(bars) - 1 - hod_lod(bars)[1] if bars else 0
    if 0.01 <= mom_dec <= 0.05 and _bars_since_hod_md >= 30:
        reasons.append(f"Momentum decay moderate ({mom_dec:.3f}) — A −12.7% avg")
    if 0 < slvpo < 10:
        warnings.append(f"Session low only {slvpo:.0f}% below PM open — A +4.7% avg (LOSING)")

    now_h = datetime.now().hour
    if slvpo >= 25.0:
        reasons.append(f"DEEP session low ({slvpo:.0f}% below open): A 86% win rate (n=38 ✓)")
    elif slvpo >= 10.0:
        reasons.append(f"Session low {slvpo:.0f}% below PM open: solid thesis confirmation")
    if 7 <= now_h < 8:
        warnings.append("07-08am window — highest E MAE (+65.9%)")

    # ── Grade determination ───────────────────────────────────────────────────
    hard_skip = chop_blocked or section != 'S1' or not has_sigs or ez == 'DEAD_ZONE'

    if hard_skip:
        forming    = section == 'S1' and (score >= 10 or has_sigs)
        out_signal = 'WAIT' if forming else 'SKIP'
        out_grade  = 'C' if forming else 'NONE'
    else:
        grade_a = (
            regime in ('DILUTION_DUMP','NEWS_CONTINUATION') and
            tier in ('HIGH','MEDIUM') and
            section == 'S1' and
            sig_tier in ('TIER_1','TIER_2') and
            flips <= 3 and chop < 40 and
            ez in ('ZONE_A','ZONE_B','ZONE_C') and
            velocity not in ('FALLING','FALLING_FAST') and
            # v3 additions to Grade A criteria
            not signals.get('LATE_HOD') and
            not signals.get('HEAVY_VWAP_DIST') and
            not signals.get('MEDIUM_SPIKE_ZONE')
        )
        if grade_a:
            out_signal = 'HIGH_VALUE'
            out_grade  = 'A'
            reasons.append("GRADE A — all prime conditions met")
        else:
            out_signal = f'ENTER_{strategy}'
            out_grade  = 'B'
            reasons.append("GRADE B — standard qualifying entry")

    ext = compute_extended(bars, vwaps, signals, section,
                           score=score, float_shares=float_shares)
    sig = ClassifierSignal(
        ticker=ticker, timestamp=now_str, signal=out_signal, grade=out_grade,
        strategy=strategy, regime=regime, tier=tier, score=score,
        section=section, confidence=conf, active_signals=active_sigs,
        signal_tier=sig_tier, power_combo=pwr_combo, power_lift=pwr_lift,
        flips_rth=flips, chop=chop, velocity=velocity, vpin='',
        price=price, hod=hod_v, lod=lod_v, pct_from_hod=pct_hod,
        entry_zone=ez, expected_mae=exp_mae, expected_ret=exp_ret,
        stop_pct=stop, quality_score=0, reasons=reasons,
        warnings=warnings, bar_count=len(bars),
        pm_bars=ext['pm_bars'], rth_bars=ext['rth_bars'],
        pm_move_pct=ext['pm_move_pct'], pm_high=ext['pm_high'],
        gap_pct=ext['gap_pct'], vwap=ext['vwap'], atr=ext['atr'],
        price_vs_vwap=ext['price_vs_vwap'],
        hod_time=ext['hod_time'], lod_time=ext['lod_time'],
        hod_bars_ago=ext['hod_bars_ago'],
        consec_s1=ext['consec_s1'], s1_pct=ext['s1_pct'],
        vol_spike=ext['vol_spike'], session_pct=ext['session_pct'],
        all_signals=ext['all_signals'],
        suggested_size=ext['suggested_size'],
        next_watch=ext['next_watch'],
        sec_available=sec.get('available', False),
        sec_days_424b5=sec.get('days_since_424b5') or 0,
        sec_offerings_12m=sec.get('offering_count_12m', 0),
        sec_score_boost=sec.get('score_boost', 0),
        sec_regime_changed=bool(sec.get('regime_override')),
        # v3 fields
        vol_above_vwap_pct=vol_av,
        intraday_gain_pct=gain_pct,
        intraday_gain_bucket=gain_bucket,
        session_low_vs_pm_open=slvpo,
        quiet_dump_proxy=qdp,
        score_trajectory=traj,
        pm_open_price=pm_open_px,
        entry_c_fired=entry_c,
        float_shares=float_shares,
        float_turnover_pct=float_turnover_pct,
        momentum_decay_rate=mom_dec,
        hod_set_pct=hod_sp,
        v3_gate_notes=ext.get('v3_gate_notes', []),
    )
    sig.quality_score    = calc_quality(sig)
    sig.confidence_norm  = round(sig.confidence / 100.0, 4)
    sig.pre_fall_tier    = sig.tier
    gp, gd, dq, bv       = evaluate_gates(sig)
    sig.gates_passed     = gp
    sig.gate_detail      = gd
    sig.disqualifiers    = dq
    sig.bias             = bv
    return sig


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 6 — OUTPUT & LOGGING
# ═══════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════
# WINNERS CIRCLE + BLUEPR8NT EVALUATION
# ═══════════════════════════════════════════════════════════════════════════

def evaluate_winners_circle(sig: 'ClassifierSignal') -> dict:
    """
    Score the session against the 7 Winners Circle gates.

    Winners Circle = sessions where A ≈ −15 to −30% and E ≈ −25 to −40%.
    Derived from backtest analysis of 214 sessions.

    Returns dict with gate results, WC score, tier label, and expected range.
    """
    gates = {}

    # Gate 1: Early HOD (hod_set_pct < 30% of elapsed OR hod_in_pm)
    try:
        _ht  = sig.hod_time[-5:] if sig.hod_time and sig.hod_time != '—' else ''
        _het = (int(_ht[:2])*3600 + int(_ht[3:5])*60
                if len(_ht) >= 5 and ':' in _ht else 99999)
    except Exception:
        _het = 99999
    gates['EARLY_HOD'] = (sig.hod_set_pct < 30.0 or _het < 34200)

    # Gate 2: Volume below VWAP (< 40% above = confirmed dump)
    gates['VWAP_DUMP']  = sig.vol_above_vwap_pct < 40.0

    # Gate 3: Quiet dump proxy (small gain + already well below open)
    gates['QUIET_DUMP'] = sig.quiet_dump_proxy

    # Gate 4: Small intraday gain (not a big retail spike)
    gates['SMALL_GAIN'] = sig.intraday_gain_bucket in ('SUB10', '10-20pct', '20-45pct')

    # Gate 5: High classifier confidence (≥ 70%)
    gates['HIGH_CONF']  = sig.confidence >= 70

    # Gate 6: Entry in Zone A (within 5% of HOD — best E outcomes)
    gates['ZONE_A']     = sig.pct_from_hod > -5.0

    # Gate 7: Session proved its downside (LOD > 10% below PM open)
    gates['DEEP_LOD']   = sig.session_low_vs_pm_open > 10.0

    wc_score = sum(gates.values())

    # WC tier based on gates passed
    if wc_score >= 6:
        tier  = 'WINNERS_CIRCLE'
        exp_a = '−20 to −35%'
        exp_e = '−30 to −45%'
    elif wc_score >= 4:
        tier  = 'QUALIFYING'
        exp_a = '−10 to −20%'
        exp_e = '−15 to −25%'
    elif wc_score >= 2:
        tier  = 'DEVELOPING'
        exp_a = '−5 to −10%'
        exp_e = '−8 to −15%'
    else:
        tier  = 'NOT_QUALIFYING'
        exp_a = 'uncertain'
        exp_e = 'uncertain'

    return {
        'gates':    gates,
        'score':    wc_score,
        'total':    7,
        'tier':     tier,
        'exp_a':    exp_a,
        'exp_e':    exp_e,
    }


def evaluate_bluepr8nt(sig: 'ClassifierSignal') -> dict:
    """
    Score the session against the BLUEPR8NT pattern (9 sessions, backtest).

    BLUEPR8NT sessions averaged:
      A = −19.8%  (vs −5.1% rest)      → 4× better
      E = −37.0%  (vs −14.4% rest)     → 3× better
      Pre-fall score = 48.6 (vs 32.6)  → 49% higher conviction
      E MFE = −47.1% (vs −27.5%)       → 71% better ideal exit

    5 BLUEPR8NT detection gates:
      1. DILUTION_DUMP regime
      2. Pre-fall score > 40
      3. Quiet dump proxy (small gain + below open)
      4. Confidence ≥ 70%
      5. dp_prints_pre_hod == 0 OR dark pool prints absent
         (when tick data unavailable: skip / treat as unknown)

    Returns dict with gate results, BP score, and comparison to dataset avg.
    """
    gates = {}

    gates['DILUTION_DUMP'] = sig.regime == 'DILUTION_DUMP'
    gates['HIGH_SCORE']    = sig.score >= 40
    gates['QUIET_DUMP']    = sig.quiet_dump_proxy
    gates['HIGH_CONF']     = sig.confidence >= 70
    # Dark pool: use sec_available as proxy when tick data absent
    # (SEC 424B5 filing = dilution = often correlates with BP pattern)
    gates['DILUTION_CONF'] = (sig.sec_available and sig.sec_days_424b5 is not None
                               and sig.sec_days_424b5 <= 30) or sig.regime == 'DILUTION_DUMP'

    bp_score = sum(gates.values())

    if bp_score >= 5:
        bp_tier   = 'BLUEPR8NT'
        note      = 'All 5 gates — E priority. Expected E ≈ −37%'
    elif bp_score >= 4:
        bp_tier   = 'BLUEPR8NT_CANDIDATE'
        note      = '4/5 gates — strong BP candidate. E preferred over A'
    elif bp_score >= 3:
        bp_tier   = 'BP_WATCH'
        note      = '3/5 gates — partial match. Monitor for confirmation'
    else:
        bp_tier   = 'NOT_BP'
        note      = ''

    return {
        'gates':    gates,
        'score':    bp_score,
        'total':    5,
        'tier':     bp_tier,
        'note':     note,
        # Dataset comparison (from backtest report)
        'bp_avg_a':   '-19.8%',
        'bp_avg_e':   '-37.0%',
        'rest_avg_a': '-5.1%',
        'rest_avg_e': '-14.4%',
        'bp_mfe_e':   '-47.1%',
    }



def evaluate_concepts_score(sig: 'ClassifierSignal',
                             tick_features=None) -> dict:
    """
    Concepts Score (0-5) — cross-cutting quality factors not covered
    by Winners Circle (setup purity) or BLUEPR8NT (catalyst).

    This layer measures the SIGNAL QUALITY and CONFIRMATION DEPTH:
    whether the session has institutional-grade signal strength,
    a power combination, a structural catalyst, and tick confirmation.

    Gates:
      1. REGIME_CONFIRMED   — Regime is DILUTION_DUMP (coordinated sell)
      2. SIGNAL_TIER1       — At least one Tier-1 signal firing
      3. POWER_COMBO        — A qualifying power combo detected
      4. SEC_DEPTH          — 424B5_ACTIVE or SERIAL_HEAVY from SEC data
      5. TICK_CONFIRM       — VPIN >0.55 or buy_pressure <35% (when available)
                              Substituted by SEC confirmation if no tick data

    Purpose:
      Winners Circle + BLUEPR8NT tell you what the setup looks like.
      Concepts Score tells you HOW WELL-BACKED it is. A setup can pass
      WC and BP but still have weak signal quality (T2/T3 only, no SEC,
      no tick confirmation). Concepts Score penalizes those.
    """
    gates = {}

    # Gate 1: Regime confirmed as dilution (structural seller)
    gates['REGIME_CONFIRMED'] = sig.regime == 'DILUTION_DUMP'

    # Gate 2: T1 signal present (strongest signal tier)
    T1_SIGNALS = {'SUPPLY_OVERHANG', 'AH_REVERSAL_TRAP', 'LIVE_STRENGTH',
                  'DAY3_EXHAUSTION', 'LATE_PHASE', 'MEAN_REVERSION_GAP'}
    active_set = set(sig.active_signals or [])
    gates['SIGNAL_TIER1'] = bool(active_set & T1_SIGNALS)

    # Gate 3: Power combo firing (validated multi-signal interaction)
    gates['POWER_COMBO'] = bool(sig.power_combo)

    # Gate 4: SEC structural depth confirmed
    gates['SEC_DEPTH'] = (sig.sec_available and
                          ('424B5_ACTIVE' in (sig.active_signals or []) or
                           'SERIAL_HEAVY'  in (sig.active_signals or [])))

    # Gate 5: Tick confirmation (VPIN toxicity or sell-side pressure)
    # Falls back to SEC if tick data unavailable
    if tick_features is not None and getattr(tick_features, 'ticks_available', False):
        vpin  = getattr(tick_features, 'proxy_vpin', None)
        buy_p = getattr(tick_features, 'buy_pressure_pct', None)
        gates['TICK_CONFIRM'] = ((vpin  is not None and vpin  > 0.55) or
                                  (buy_p is not None and buy_p < 35.0))
    else:
        # No tick data — use SEC dilution confirmation as proxy
        gates['TICK_CONFIRM'] = (sig.sec_available and
                                  sig.sec_offerings_12m >= 2)

    concepts_score = sum(gates.values())

    if concepts_score >= 5:
        tier  = 'ELITE'
        label = 'All 5 confirmations — maximum conviction'
    elif concepts_score >= 4:
        tier  = 'STRONG'
        label = 'High-quality backing — enter with confidence'
    elif concepts_score >= 3:
        tier  = 'SOLID'
        label = 'Good confirmation — standard size'
    elif concepts_score >= 2:
        tier  = 'PARTIAL'
        label = 'Partial confirmation — reduce size'
    else:
        tier  = 'WEAK'
        label = 'Insufficient backing — monitor only'

    return {
        'gates':  gates,
        'score':  concepts_score,
        'total':  5,
        'tier':   tier,
        'label':  label,
    }


def compute_gate_roundup(sig: 'ClassifierSignal',
                          tick_features=None) -> dict:
    """
    Gate Round Up (GRU) Score — unified conviction index.

    Combines all three evaluation frameworks into a single score:

      Winners Circle (0-7):  Setup purity — structural fingerprint of
                              the best historical sessions. Answers:
                              "Does this look like the sessions that won?"

      BLUEPR8NT (0-5):       Catalyst depth — institutional/dilution
                              confirmation behind the dump. Answers:
                              "Is there a real reason this stock goes down?"

      Concepts (0-5):        Signal quality — tier, power combo, SEC depth,
                              tick confirmation. Answers:
                              "How well-backed is the signal quality?"

    Total: 0-17

    GRU Tiers:
      14-17  EXCEPTIONAL  — Strongest possible setup, all frameworks align
      10-13  HIGH         — Strong conviction, enter standard or full size
       6-9   DEVELOPING   — Setup building, monitor, reduced size if entering
       3-5   WEAK         — Below threshold, pass or paper trade only
       0-2   SKIP         — No setup

    The GRU score is the single number to check when you have to make
    a quick decision. It compresses 17 individual gate checks into one
    index that tells you exactly where this session stands.
    """
    wc      = evaluate_winners_circle(sig)
    bp      = evaluate_bluepr8nt(sig)
    concepts = evaluate_concepts_score(sig, tick_features)

    total = wc['score'] + bp['score'] + concepts['score']
    max_s = wc['total'] + bp['total'] + concepts['total']  # 17

    if total >= 14:
        tier  = 'EXCEPTIONAL'
        label = 'All frameworks aligned — maximum conviction'
        size  = '100-125%'
        color = 'GRN+BOLD'
    elif total >= 10:
        tier  = 'HIGH'
        label = 'Strong conviction setup'
        size  = '100%'
        color = 'GRN'
    elif total >= 6:
        tier  = 'DEVELOPING'
        label = 'Setup building — monitor'
        size  = '50-75%'
        color = 'YEL'
    elif total >= 3:
        tier  = 'WEAK'
        label = 'Below threshold — paper trade'
        size  = '25%'
        color = 'RED'
    else:
        tier  = 'SKIP'
        label = 'No setup'
        size  = '0%'
        color = 'DIM'

    return {
        'wc':           wc,
        'bp':           bp,
        'concepts':     concepts,
        'total':        total,
        'max':          max_s,
        'tier':         tier,
        'label':        label,
        'suggested_size': size,
        'wc_score':     wc['score'],
        'bp_score':     bp['score'],
        'concepts_score': concepts['score'],
    }



# ── Windows terminal auto-detection ───────────────────────────────────────────
def _init_colors():
    """Return color dict — ANSI on capable terminals, plain text on Windows CMD."""
    try:
        import colorama
        colorama.init()
        _ansi = True
    except ImportError:
        import os
        # Windows CMD without colorama: check if ANSICON or WT_SESSION set
        _ansi = (os.environ.get('ANSICON') or
                 os.environ.get('WT_SESSION') or
                 os.environ.get('TERM_PROGRAM') or
                 sys.platform != 'win32')

    if _ansi:
        return {
            'BOLD': '\033[1m',  'RESET': '\033[0m',
            'GRN':  '\033[92m', 'YEL':   '\033[93m',
            'RED':  '\033[91m', 'CYN':   '\033[96m',
            'MAG':  '\033[95m', 'DIM':   '\033[2m',
            'WHT':  '\033[97m',
        }
    else:
        return {k: '' for k in
                ['BOLD','RESET','GRN','YEL','RED','CYN','MAG','DIM','WHT']}

_C = _init_colors()


def print_signal(sig: ClassifierSignal, verbose: bool = True):
    """
    Cat5ive v3 redesigned output — 8 named zones, all data preserved.
    Groups: HEADER / EDGE MAP / ENTRY CONDITIONS / RISK LEDGER /
            CONVICTION / OUTCOME / TICK / GUIDELINES ENGINE
    """
    B  = _C['BOLD'];  R  = _C['RESET'];  G  = _C['GRN']
    Y  = _C['YEL'];   RD = _C['RED'];    C  = _C['CYN']
    M  = _C['MAG'];   D  = _C['DIM'];    W_ = _C['WHT']
    W  = 68

    def _c(val, lo_g, lo_y, hi_r=None, invert=False):
        """Simple threshold colorizer."""
        try: v = float(val)
        except: return D
        if invert:
            return RD if v < lo_g else (Y if v < lo_y else G)
        return G if v < lo_g else (Y if v < lo_y else (RD if hi_r and v >= hi_r else Y))

    def _hdr_zone(label):
        print(f"  {D}── {label} {'─'*(W-len(label)-4)}{R}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 0: HEADER
    # ────────────────────────────────────────────────────────────────────
    # Use _C dict for colors — SIG_COLOR/GRADE_COLOR use module-level constants
    # which may not be initialized if _init_colors() overrides them
    _sig_colors = {
        'GO':      G+B, 'STRONG': G+B, 'ENTRY': G,
        'WAIT':    Y,   'MONITOR': Y,
        'SKIP':    RD,  'AVOID': RD, 'LONG_OPP': C,
    }
    _grade_colors = {'A': G+B, 'B': G, 'C': Y, 'D': RD, 'NONE': D}
    sc = _sig_colors.get(sig.signal, Y)
    gc = _grade_colors.get(sig.grade, D)
    tc = G if sig.tier=='HIGH' else Y if sig.tier in ('MEDIUM','LOW') else D
    print(f"\n  {'═'*W}")
    print(f"  {B}{sig.ticker:8}{R}  ${sig.price:.3f}  "
          f"{sc}{B}{sig.signal:12}{R}  [{gc}Grade {sig.grade}{R}]  "
          f"Q={sig.quality_score}/100  Score:{sig.score}  "
          f"{tc}{sig.tier}{R}  @{sig.timestamp}")
    print(f"  {'═'*W}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 1: EDGE MAP — session vs EDGE 1-10 / AVOID 1-10
    # ────────────────────────────────────────────────────────────────────
    _hdr_zone("EDGE MAP")

    hod_pct  = float(sig.hod_set_pct or 0)
    qd_on    = bool(sig.quiet_dump_proxy)
    fs       = float(sig.float_shares or 0)
    gap      = float(sig.gap_pct or 0)
    halts    = int(getattr(sig, 'halt_count_pm', 0) or 0)
    flips    = int(sig.flips_rth or 0)
    chop     = float(sig.chop or 0)
    rd       = int(getattr(sig, 'run_day', 0) or 0)
    regime   = str(sig.regime or '')
    _anchor  = hod_pct < 30 and qd_on

    def _em(ok, code, label, note, star=False):
        sym   = f"{G}✓{R}" if ok else f"{RD}✗{R}"
        col   = (G+B) if (ok and star) else (G if ok else RD)
        note_col = (G+B) if (ok and star) else (D if ok else D)
        return f"  {sym}  {B}{col}{code}{R}  {label:32}  {note_col}{note}{R}"

    # ── Pre-compute shared signal values ──────────────────────────────────────
    _vwap40      = float(getattr(sig, "vol_above_vwap_pct", 100) or 100) < 40
    _wc_gate     = float(getattr(sig, "winners_circle_score",
                         getattr(sig, "wc_score", 0)) or 0) >= 4
    _entry_c     = bool(getattr(sig, "entry_c_fired", False))
    _bias_s1     = str(getattr(sig, "bias", "") or "").upper() == "S1"
    _pm_vol_ratio = float(getattr(sig, "pm_vol_ratio", 0) or 0)

    # AUTO ZONE signal count (6 of the 8 computable pre-entry)
    _az_count = sum([hod_pct < 30, qd_on, _vwap40, _entry_c, _wc_gate, _bias_s1])

    # ── Active edge lines ───────────────────────────────────────────────────
    edge_lines = []
    e2_on = hod_pct < 30 and not qd_on

    # EDGE A / EDGE B top badge — printed first so it reads as headline
    if _anchor:
        if _az_count >= 6:
            edge_lines.append(
                f"  {G+B}{'★'*3}EDGE A  FULL STACK ({_az_count}/6)"
                f"  100% win  n=14  avg −29.3%{'  ★'*3}{R}")
        elif _az_count >= 4:
            edge_lines.append(
                f"  {G}▲▲  EDGE B  AUTO ZONE ({_az_count}/6 signals)"
                f"  {4: >1}sig=70%  5sig=82%  6sig=100%{R}")

    # Individual edges
    if _anchor:
        edge_lines.append(_em(True,  "EDGE 1",  "HOD+QD (primary)",
            "82.1% win | n=28 | OOS 81.8% | 90% strong wins (ret<-20%)"))
    if e2_on:
        edge_lines.append(_em(True,  "EDGE 2",  "HOD early / no QD",
            "55.8% win (n=58) — above baseline | watch for QD activation"))
    if _anchor and fs < 2_000_000:
        edge_lines.append(_em(True,  "EDGE 3",  "HOD+QD micro/small float",
            f"Float {fs/1e6:.2f}M <2M"))
    if _anchor and 1 <= halts <= 2:
        edge_lines.append(_em(True,  "EDGE 4 ★", "HOD+QD 1-2 PM halts",
            f"{halts} halt(s) — 90% win sub-condition", star=True))
    if _anchor and 30 <= gap < 75:
        edge_lines.append(_em(True,  "EDGE 5 ★", "HOD+QD gap 30-75%",
            f"Gap {gap:.1f}% — 100% win sub-condition (n=7)", star=True))
    if _anchor and 0 < _pm_vol_ratio < 100:
        edge_lines.append(_em(True,  "EDGE 6 ★", "HOD+QD PM vol <100x",
            f"PM vol {_pm_vol_ratio:.0f}x — 100% win sub-condition", star=True))
    if _anchor and regime == "DILUTION_DUMP":
        edge_lines.append(_em(True,  "EDGE 7",  "HOD+QD DILUTION_DUMP",
            "83.3% win in this regime"))
    if _anchor and rd == 1:
        edge_lines.append(_em(True,  "EDGE 8",  "HOD+QD Day 1",
            "82.4% win Day 1 (n=17)"))
    if _anchor and flips <= 2:
        edge_lines.append(_em(True,  "EDGE 9",  "HOD+QD ≤2 flips",
            f"{flips} flip(s) — clean entry"))
    if _anchor and chop < 20:
        edge_lines.append(_em(True,  "EDGE 10", "HOD+QD chop <20%",
            f"Chop {chop:.0f}% — lowest MAE entry"))
    # Vol VWAP standalone signal (EDGE B pillar, no HOD+QD)
    if _vwap40 and not _anchor:
        edge_lines.append(_em(True,  "SIGNAL",  "Vol VWAP <40%",
            "75% A win (n=72) | needs HOD+QD for full edge"))

    # No edge at all
    if not edge_lines:
        edge_lines.append(_em(False, "EDGE 1",
            "Primary edge NOT active",
            "Need HOD<30% AND QD=yes"))

    for ln in edge_lines:
        print(ln)

    # Avoid signals firing
    avoid_lines = []
    if hod_pct >= 60:
        avoid_lines.append(_em(False, "AVOID 1",
            f"HOD late {hod_pct:.0f}% ≥60%", "23.1% win | hard block"))
    if 20 <= chop < 40:
        avoid_lines.append(_em(False, "AVOID 2",
            f"Chop {chop:.0f}% in 20-40% zone", "25.0% win | hard block"))
    nm_dom = str(getattr(sig, 'bias', '') or '')
    if 'S2' in nm_dom.upper() and 'S1' not in nm_dom.upper():
        avoid_lines.append(_em(False, "AVOID 3",
            "NM Dominant S2", "32.3% win"))
    if float(sig.confidence_norm or 0) < 0.40:
        avoid_lines.append(_em(False, "AVOID 4",
            f"S1 confidence {sig.confidence_norm:.0%} <40%", "35.1% win"))
    _con = bool(getattr(sig, 'contested_day', False))
    if _con:
        avoid_lines.append(_em(False, "AVOID 5",
            "Contested day", "40.0% win"))
    if not qd_on:
        avoid_lines.append(_em(False, "AVOID 6",
            "QD=no", "40.2% win without QD"))
    if hod_pct >= 60 and flips >= 6:
        avoid_lines.append(_em(False, "AVOID 8",
            f"HOD late + {flips} flips", "12.5% win | hard block"))
    if hod_pct >= 60 and not qd_on:
        avoid_lines.append(_em(False, "AVOID 7",
            "HOD late + QD=no (double negative)", "20.0% win | two-factor"))
    if not qd_on and 'S2' in nm_dom.upper():
        avoid_lines.append(_em(False, "AVOID 9",
            "QD=no + NM S2", "25.9% win"))
    if hod_pct >= 60 and _con:
        avoid_lines.append(_em(False, "AVOID 10",
            "HOD late + Contested", "23.8% win | hard block"))

    # AVOID 11 — Live Strength (v1.2 named_signal_analysis finding)
    # Most severe single-factor signal in the dataset: 6.0% win, n=45, -45.2 pts.
    # STRONG WARNING per guidelines — does not force a hard block on its own,
    # unlike AVOID 1/2/8/10. Surfaced prominently so the trader weighs it heavily.
    _live_strength = 'LIVE_STRENGTH' in (sig.active_signals or [])
    if _live_strength:
        avoid_lines.append(_em(False, "AVOID 11 ⚠ ", "Live Strength active",
            "6.0% win (n=45) | MOST SEVERE signal — strong warning, not hard block"))

    # Float/gap caveats
    if fs >= 10_000_000:
        avoid_lines.append(_em(False, "CAVEAT",
            f"Float {fs/1e6:.1f}M ≥10M",
            "66.7% win (vs 82.1% full edge)"))
    if gap < 30 and gap != 0:
        avoid_lines.append(_em(False, "CAVEAT",
            f"Gap {gap:.1f}% below 30%",
            "62.5% HOD+QD win in low-gap sessions"))

    for ln in avoid_lines:
        print(ln)


    # ──── Live combo win-rate readout (v1.2 named_signal_analysis) ────

    # Validated 2-signal combinations (n>=8) checked against THIS session's

    # active_signals. Shows the historical win rate for whatever specific

    # combination is firing right now, not just the individual signal flags.

    _active_set = set(sig.active_signals or [])

    _deep_session_low = 'DEEP_SESSION_LOW' in _active_set


    _VALIDATED_COMBOS = [

        # (signal_a, signal_b, win_pct, n, avg_ret, requires_anchor)

        ('HIGH_VOL_REJECTION', 'DEEP_SESSION_LOW',  91, 14, -29.9, False),

        ('OVEREXTENDED_AH_S2', 'DEEP_SESSION_LOW',  86,  8, -26.6, False),

        ('OVEREXTENDED_OPEN',  'DEEP_SESSION_LOW',  86, 17, -27.7, False),

        ('CLEAN_SESSION',      'DEEP_SESSION_LOW',  82, 23, -23.3, False),

        ('SUPPLY_OVERHANG',    'DEEP_SESSION_LOW',  80, 29, -21.6, False),

        ('PM_FADE_CONFIRMED',  'CLEAN_SESSION',     77, 16, -24.6, False),

        ('PM_SELL_PRESSURE',   'PM_FADE_CONFIRMED', 73, 12, -19.5, False),

        ('VWAP_FAIL_S1',       'DEEP_SESSION_LOW',  73, 28, -20.2, False),

        ('PM_FADE_CONFIRMED',  'HIGH_VOL_REJECTION',73, 11, -23.0, False),

        ('PM_SELL_PRESSURE',   'VWAP_FAIL_S1',      70, 11, -18.6, False),

        ('SUPPLY_OVERHANG',    'PM_FADE_CONFIRMED', 69, 19, -21.1, False),

    ]


    _combo_hits = []

    for sa, sb, wpct, cn, aret, req_anchor in _VALIDATED_COMBOS:

        if sa in _active_set and sb in _active_set:

            if req_anchor and not _anchor:

                continue

            _combo_hits.append((sa, sb, wpct, cn, aret))


    if _anchor and _deep_session_low:

        print(f"  {G+B}★ HOD+QD + Deep Session Low{R}  "

              f"{G}78.6% win (n=14) — strongest return booster, avg −33.7%{R}")

    elif _deep_session_low and not _anchor:

        print(f"  {Y}Deep Session Low (no HOD+QD){R}  "

              f"{D}57.1% win (n=21) — weak without HOD+QD, not standalone edge{R}")


    if _combo_hits:

        print(f"  {D}── Active validated combos (this session) ──{R}")

        for sa, sb, wpct, cn, aret in sorted(_combo_hits, key=lambda x: -x[2]):

            nflag = ' ⚠' if cn < 30 else (' ⚠⚠' if cn < 10 else '')

            wcol  = G if wpct >= 70 else (Y if wpct >= 55 else RD)

            sa_lbl = sa.replace('_', ' ').title()

            sb_lbl = sb.replace('_', ' ').title()

            print(f"  {wcol}{sa_lbl} + {sb_lbl}{R}  "

                  f"{wcol}{wpct}% win{R} (n={cn}{nflag})  avg {aret:+.1f}%")


    # ──── Overext+VWAP floor signal + PM_Sell+Fade differentiator ────

    # (v1.2 investigate_low_score_winners.py finding) OVEREXTENDED_AH_S2+

    # VWAP_FAIL_S1 is confirmed NEUTRAL on its own (50% win, n=72) -- a

    # common-denominator characteristic of a whole session class, not a

    # differentiator. PM_SELL_PRESSURE+PM_FADE_CONFIRMED is the actual

    # discriminator: every large-return winner in the investigated group

    # had it active; every loser lacked it.

    _overext_vwap_active = 'OVEREXTENDED_AH_S2' in _active_set and 'VWAP_FAIL_S1' in _active_set

    _pm_sell_fade_active = 'PM_SELL_PRESSURE' in _active_set and 'PM_FADE_CONFIRMED' in _active_set


    if _overext_vwap_active:

        if _pm_sell_fade_active:

            print(f"  {G}Overext+VWAP (floor) + PM_Sell+Fade (differentiator) BOTH active{R}  "

                  f"{G}— matches the large-return winner pattern (avg -22 to -36% in study){R}")

        else:

            print(f"  {D}Overext+VWAP active (floor signal){R}  "

                  f"{D}50% win (n=72), NEUTRAL — common to this session class, "

                  f"not predictive alone. Differentiator (PM_Sell+Fade) NOT active.{R}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 2: ENTRY CONDITIONS
    # ────────────────────────────────────────────────────────────────────
    print(f"  {'═'*W}")
    _hdr_zone("ENTRY CONDITIONS")

    hod_c  = G if hod_pct < 30 else (Y if hod_pct < 60 else RD)
    qd_c   = G if qd_on else D
    cc     = G if chop < 40 else (Y if chop < 70 else RD)
    fc     = G if flips <= 3 else (Y if flips <= 6 else RD)
    vc     = (G  if sig.velocity in ('RISING_FAST','RISING') else
              RD if sig.velocity in ('FALLING','FALLING_FAST') else D)
    pvwap_c = RD if sig.price_vs_vwap > 0 else G
    traj_c  = G if sig.score_trajectory=='RISING' else RD if sig.score_trajectory=='FALLING' else D
    _sd     = getattr(sig, 'score_delta_pre', 0)
    _sd_c   = G if _sd >= 3 else (RD if _sd <= -3 else D)
    _lean   = getattr(sig, 'margin_lean', 0.0)
    _ln_c   = G if _lean > 3 else (Y if _lean > 0 else D)
    consec_c = G if sig.consec_s1 >= 10 else (Y if sig.consec_s1 >= 3 else RD)
    _rd_str  = f"D{rd}" if rd > 0 else "D?"
    _rd_c    = G if rd == 1 else (Y if rd == 2 else RD)
    _nm      = int(getattr(sig, 'near_miss_count', 0) or 0)
    _nm_c    = G if 5 <= _nm <= 14 else (Y if _nm > 0 else D)
    _ppe     = float(getattr(sig, 'price_path_efficiency', 0) or 0)
    _ppe_c   = G if _ppe < 0.4 else (Y if _ppe < 0.7 else D)
    _con_str = f"{Y}CONTESTED{R}" if _con else "clean"
    _cvpm    = float(getattr(sig, 'close_vs_pm_open_pct', 0) or 0)
    _thesis_c = (G+B if 20 <= _cvpm < 40 else G if 10 <= _cvpm < 20
                 else Y if _cvpm >= 40 else RD if _cvpm < 0 else D)
    vav_c    = RD if sig.vol_above_vwap_pct > 80 else (Y if sig.vol_above_vwap_pct > 60 else G)
    ft_c     = RD if 0 < sig.float_turnover_pct < 10 else (G if sig.float_turnover_pct >= 50 else Y)
    pm_c     = RD if sig.pm_move_pct > 30 else (Y if sig.pm_move_pct > 15 else D)

    # Line 1: Core classifier state
    print(f"  Regime:{sig.regime:18}  S1:{sig.confidence}%  Sec:{sig.section}({sig.s1_pct:.0f}%)  "
          f"Bars:{sig.rth_bars}/{sig.pm_bars}pm  RTH:{sig.session_pct:.0f}%")

    # Line 2: Momentum
    print(f"  Vel:{vc}{sig.velocity:14}{R}  Flips:{fc}{flips:>3}{R}  "
          f"Chop:{cc}{chop:.0f}%{R}  Traj:{traj_c}{sig.score_trajectory}"
          f"({_sd_c}Δ{_sd:+d}{R})  Lean:{_ln_c}{_lean:+.1f}{R}  "
          f"ConsecS1:{consec_c}{sig.consec_s1}{R}")

    # Line 3: HOD/LOD/VWAP
    print(f"  HOD:${sig.hod:.3f} @{sig.hod_time} {hod_c}{hod_pct:.0f}%{R} elapsed "
          f"({sig.hod_bars_ago}bars ago)  "
          f"LOD:${sig.lod:.3f} @{sig.lod_time}")
    print(f"  VWAP:${sig.vwap:.3f} ({pvwap_c}{sig.price_vs_vwap:+.1f}%{R})  "
          f"ATR:${sig.atr:.3f}  VolSpike:{sig.vol_spike:.1f}x  "
          f"VolAboveVWAP:{vav_c}{sig.vol_above_vwap_pct:.0f}%{R}")

    # Line 4: PM + entry zone
    print(f"  PM:Move:{pm_c}{sig.pm_move_pct:+.1f}%{R}  "
          f"High:${sig.pm_high:.3f}  Gap:{gap:+.1f}%  Open:${sig.pm_open_price:.3f}")
    zc = G if sig.entry_zone=='ZONE_A' else RD if sig.entry_zone=='DEAD_ZONE' else Y
    print(f"  Entry:{zc}{sig.pct_from_hod:+.1f}% from HOD — Zone:{sig.entry_zone}{R}  "
          f"Size:{G}{sig.suggested_size}{R}")

    # Line 5: v3 features
    print(f"  QD:{qd_c}{'YES' if qd_on else 'no':4}{R}  "
          f"Gain:{sig.intraday_gain_bucket:12}  "
          f"FloatTurn:{ft_c}{sig.float_turnover_pct:.1f}%{R}  "
          f"EntryC:{'✓' if sig.entry_c_fired else '✗'}  "
          f"SessLow:{sig.session_low_vs_pm_open:.0f}%blw  "
          f"CloseVPM:{_thesis_c}{_cvpm:+.1f}%{R}")
    print(f"  NM:{_nm_c}{_nm:>2}nm{R}  RunDay:{_rd_c}{_rd_str}{R}  "
          f"PathEff:{_ppe_c}{_ppe:.2f}{R}  "
          f"Session:{_con_str}  "
          f"S1%%RTH:{sig.s1_pct:.0f}%%")

    # ── CHOP PRICE ADJUSTMENT (always shown when chop ≥ 20) ──────────────────
    _cez  = getattr(sig, 'chop_entry_zone', None) or {}
    _conf = _cez.get('confidence', '')
    if chop >= 20:
        _rl  = _cez.get('rec_entry_low',         0)
        _rh  = _cez.get('rec_entry_high',         0)
        _wp  = _cez.get('wait_pct',               0)
        _mr  = _cez.get('expected_mae_reduction',  0)
        _vwap_cez = _cez.get('vwap',              sig.vwap)
        _zt  = _cez.get('zone_tight_pct',          0)
        # Chop tier — MAE variance from data
        # chop<20: avg MAE 21.9%, chop 20-40: 21.7%, chop 60%+: 16.1%
        # 4-8 flips adds +24% MAE on top of chop effect
        if chop >= 90:
            _mae_var = "+24-35% MAE range (EXTREME — skip first Entry C)"
            _action  = "WAIT: price must re-test VWAP before entry"
        elif chop >= 60:
            _mae_var = "+16-25% MAE range (heavy chop)"
            _action  = "WAIT: strict VWAP re-test required"
        elif chop >= 40:
            _mae_var = "+18-28% MAE range (moderate chop)"
            _action  = "WAIT: VWAP re-test within 1.5%"
        else:  # 20-40 danger zone
            _mae_var = "+20-30% MAE range (danger zone — worst band)"
            _action  = "CAUTION: enter only within 2% of VWAP"

        if 4 <= flips <= 8:
            _flip_adj = f" · {flips} flips adds +24% MAE (2× clean avg)"
        elif flips > 8:
            _flip_adj = f" · {flips} flips = EXTREME — 3× MAE risk"
        else:
            _flip_adj = f" · {flips} flip(s) — no additional MAE penalty"

        _ez_c = (G+B if _conf=='ENTER_NOW' else Y if _conf=='WAIT_VWAP'
                 else RD if _conf=='WAIT_RETEST' else D)

        print(f"  {'─'*(W//2)}")
        # Best price = tightest to VWAP (ideal entry)
        # Worst price = outer boundary of acceptable zone
        # Derived from chop tier tolerance bands (backed by MAE study data)
        _v = float(_vwap_cez or sig.vwap or 0)
        if _v > 0:
            if chop >= 90:       # EXTREME: must be within 0.5% of VWAP
                _best = _v * 0.995;  _worst = _v * 1.005
            elif chop >= 80:     # DANGER: within 0.8%
                _best = _v * 0.992;  _worst = _v * 1.008
            elif chop >= 60:     # HEAVY: within 1.5%
                _best = _v * 0.985;  _worst = _v * 1.015
            elif chop >= 40:     # MODERATE: within 2%
                _best = _v * 0.980;  _worst = _v * 1.020
            else:                # MILD 20-40: within 2.5%
                _best = _v * 0.975;  _worst = _v * 1.025
            # Override with compute_chop_adjusted_entry values if populated
            if _rl and _rh:
                _best = min(_rl, _rh);  _worst = max(_rl, _rh)
            print(f"  {_ez_c}▶ CHOP ADJ ({chop:.0f}%):  "
                  f"Entry ${_best:.2f}–${_worst:.2f}  "
                  f"(VWAP ${_v:.2f} ±{((abs(_worst-_v)/_v)*100):.1f}%){R}")
        else:
            print(f"  {_ez_c}▶ CHOP ADJ ({chop:.0f}%):  "
                  f"VWAP re-test required (price unavailable){R}")
        print(f"  {Y}  Data: {_mae_var}{_flip_adj}{R}")
        print(f"  {_ez_c}  → {_action}{R}")
        if _mr:
            print(f"  {D}  Waiting reduces adverse excursion ~{_mr:.0f}%{R}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 3: RISK LEDGER — explicit BLOCK / WATCH / NOTE rules
    # ────────────────────────────────────────────────────────────────────
    print(f"  {'═'*W}")
    _hdr_zone("RISK LEDGER")

    # Hard blocks from disqualifiers
    if sig.disqualifiers:
        for dq in sig.disqualifiers:
            print(f"  {RD}{B}BLOCK:{R}  {dq}")

    # Avoid-rule violations as explicit rules
    if hod_pct >= 60:
        print(f"  {RD}BLOCK:{R}  HOD late {hod_pct:.0f}% — "
              f"23.1% win (n=26) · AVOID 1")
    if 20 <= chop < 40:
        print(f"  {RD}BLOCK:{R}  Chop {chop:.0f}% in 20-40% danger zone — "
              f"25.0% win (n=16) · AVOID 2")
    if not qd_on:
        print(f"  {RD}WATCH:{R}  QD=no — 40.2% win without QD (n=107) · AVOID 6")
    if hod_pct >= 60 and flips >= 6:
        print(f"  {RD}BLOCK:{R}  HOD late + {flips} flips — "
              f"12.5% win (n=16) · AVOID 8 two-factor")
    if fs >= 10_000_000:
        print(f"  {Y}WATCH:{R}  Float {fs/1e6:.1f}M ≥10M — "
              f"66.7% win (vs 82.1% full edge, n=9)")
    if gap < 30 and gap != 0:
        print(f"  {Y}WATCH:{R}  Gap {gap:.1f}% <30% — "
              f"62.5% HOD+QD win in low-gap sessions")
    if chop >= 90:
        print(f"  {RD}BLOCK:{R}  Chop {chop:.0f}% ≥90% (EXTREME) — "
              f"G1 hard disqualifier")
    if not sig.disqualifiers and not any([
        hod_pct>=60, 20<=chop<40, not qd_on, chop>=90
    ]):
        print(f"  {G}CLEAR:{R}  No hard blocks or avoid signals firing")

    # Outcome distribution note when primary edge active
    if _anchor:
        print(f"  {G}DIST:   90% of HOD+QD sessions are strong wins (ret<-20%) | "
              f"10% marginal wins | 0% losses in-sample{R}")

    # SEC
    if sig.sec_available:
        d424 = f"{sig.sec_days_424b5}d ago" if sig.sec_days_424b5 else "none recent"
        regime_flag = f" — {G}DILUTION_DUMP upgraded{R}" if sig.sec_regime_changed else ""
        sec_sigs = [s for s in ['424B5_ACTIVE','SERIAL_HEAVY','PRIOR3_DILUTION',
                                  'SUPPLY_OVERHANG','LATE_PHASE']
                    if s in sig.active_signals]
        print(f"  {D}SEC:{R}   424B5:{d424}  "
              f"Offerings:{sig.sec_offerings_12m}/12m  "
              f"+{sig.sec_score_boost}pts{regime_flag}"
              + (f"  {G}{' | '.join(sec_sigs)}{R}" if sec_sigs else ""))
    else:
        print(f"  {D}SEC:   unavailable{R}")

    # Warnings and next watch
    if sig.warnings:
        for w in sig.warnings:
            print(f"  {Y}NOTE:{R}   {w}")
    if sig.next_watch:
        print(f"  {C}NEXT:{R}   {sig.next_watch}")
    if verbose and sig.reasons:
        print(f"  {D}WHY:    {' | '.join(sig.reasons[:3])}{R}")

    # Signals block
    q      = [s for s in sig.active_signals if s in ALL_Q]
    v3sigs = [s for s in sig.active_signals if s in V3_SIGNALS]
    non_q  = [s for s in sig.all_signals
              if s not in ALL_Q and s not in q and s not in V3_SIGNALS][:3]
    if q or v3sigs or sig.power_combo:
        parts = []
        if q:      parts.append(f"{G}{' | '.join(q[:5])}{R}")
        if v3sigs: parts.append(f"{C}{' | '.join(v3sigs)}{R}")
        if non_q:  parts.append(f"{D}{' | '.join(non_q)}{R}")
        if sig.power_combo:
            parts.append(f"{G}Power:{sig.power_combo}(+{sig.power_lift:.1f}){R}")
        print(f"  SIG:    {' · '.join(parts)}")

    if verbose and sig.v3_gate_notes:
        _notes_display = list(sig.v3_gate_notes)
        _rd_v = int(getattr(sig, 'run_day', 0) or 0)
        if _rd_v >= 2:
            _notes_display.append(
                f"RUN_DAY_D{_rd_v} {_RUN_DAY_SCORE_ADJ.get(_rd_v,-12):+d}pts")
        _nm_v = int(getattr(sig, 'near_miss_count', 0) or 0)
        if 5 <= _nm_v <= 14:
            _notes_display.append(f"NM_5_14({_nm_v}) +4pts")
        print(f"  {C}ADJ:    {' | '.join(_notes_display)}{R}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 4: CONVICTION — one line per framework, all data preserved
    # ────────────────────────────────────────────────────────────────────
    print(f"  {'═'*W}")
    _hdr_zone("CONVICTION")

    gru = compute_gate_roundup(sig, getattr(sig, '_tick_features', None))
    wc  = gru['wc']
    bp  = gru['bp']
    con = gru['concepts']

    gru_total = gru['total'];  gru_max = gru['max'];  gru_tier = gru['tier']
    gc_col = (G+B if gru_tier=='EXCEPTIONAL' else G if gru_tier=='HIGH'
              else Y if gru_tier=='DEVELOPING' else RD if gru_tier=='WEAK' else D)

    # GRU — tier + data + size
    _gru_data = ""
    if gru_tier == 'SKIP':
        _gru_data = f" {RD}A=+6.1% LOSING (n=33) — NO TRADE{R}"
    elif gru_tier == 'DEVELOPING':
        _gru_data = f" {G}A=−17.8% E=−29.8% 80%win(n=64){R}"
    elif gru_tier == 'HIGH':
        _gru_data = f" {G+B}A=−17.3% E=−33.0% 88%win(n=9★){R}"
    elif gru_tier == 'EXCEPTIONAL':
        _gru_data = f" {G+B}EXCEPTIONAL — see BP data{R}"

    print(f"  {gc_col}GRU:{R}  {gru_total}/{gru_max} {gc_col}{gru_tier}{R}  "
          f"[WC:{gru['wc_score']}/7  BP:{gru['bp_score']}/5  "
          f"CON:{gru['concepts_score']}/5]  "
          f"Size:{gru['suggested_size']}{_gru_data}")

    # Gate summary (static gates)
    gate_col = G if sig.gates_passed==5 else (Y if sig.gates_passed>=3 else RD)
    dq_str = f"  {RD}DQ:{' | '.join(sig.disqualifiers)}{R}" if sig.disqualifiers else ""
    print(f"  {gate_col}GATES:{R} {sig.gates_passed}/5  "
          f"Bias:{sig.bias}  Conf:{sig.confidence_norm:.2f}{dq_str}")
    if verbose and sig.gate_detail:
        g_icons = []
        for g_line in sig.gate_detail:
            ok = 'PASS' in g_line
            g_icons.append(f"{G if ok else RD}{'✓' if ok else '✗'}{R}{D}{g_line[:25]}{R}")
        print(f"  {D}       {' | '.join(g_icons)}{R}")

    # BP — gate breakdown + data
    bp_score = bp['score'];  bp_tier = bp['tier']
    bp_col   = (M+B if bp_tier=='BLUEPR8NT' else M if bp_tier=='BLUEPR8NT_CANDIDATE'
                else Y if bp_tier=='BP_WATCH' else D)
    bp_gate_icons = {'DILUTION_DUMP':'DIL','HIGH_SCORE':'SCR',
                     'QUIET_DUMP':'QD','HIGH_CONF':'CONF','DILUTION_CONF':'SEC'}
    bp_parts = [f"{G if v else RD}{bp_gate_icons.get(k,k)}{'✓' if v else '✗'}{R}"
                for k, v in bp['gates'].items()]
    _bp_data = ""
    if bp_tier in ('BLUEPR8NT','BLUEPR8NT_CANDIDATE'):
        _bp_data = (f"  {bp_col}A:{bp['bp_avg_a']} E:{bp['bp_avg_e']} "
                    f"MFE:{bp['bp_mfe_e']} MAE:+14.3%(vs+21.1%){R}")
    print(f"  {bp_col}BP:{R}   {bp_score}/{bp['total']} [{' '.join(bp_parts)}]"
          f"{_bp_data}")
    if bp_tier in ('BLUEPR8NT','BLUEPR8NT_CANDIDATE') and bp.get('note'):
        print(f"  {bp_col}       → {bp['note']}{R}")

    # WC — gate breakdown + expected returns
    wc_score = wc['score'];  wc_tier = wc['tier']
    wc_col   = (G+B if wc_tier=='WINNERS_CIRCLE' else G if wc_tier=='QUALIFYING'
                else Y if wc_tier=='DEVELOPING' else D)
    gate_icons_wc = {'EARLY_HOD':'HOD','VWAP_DUMP':'VWAP','QUIET_DUMP':'QD',
                     'SMALL_GAIN':'GAIN','HIGH_CONF':'CONF','ZONE_A':'ZONE','DEEP_LOD':'LOD'}
    wc_parts = [f"{G if v else RD}{gate_icons_wc.get(k,k)}{'✓' if v else '✗'}{R}"
                for k, v in wc['gates'].items()]
    _wc_data = ""
    if wc_tier in ('WINNERS_CIRCLE','QUALIFYING'):
        _wc_data = f"  {wc_col}A:{wc['exp_a']} E:{wc['exp_e']}{R}"
    elif wc_score <= 1:
        _wc_data = f"  {RD+B}A=+12.0% LOSING (n=33) — no A trade{R}"
    print(f"  {wc_col}WC:{R}   {wc_score}/{wc['total']} [{' '.join(wc_parts)}]{_wc_data}")

    # Concepts
    con_score = con['score'];  con_tier = con['tier']
    con_col   = (G+B if con_tier=='ELITE' else G if con_tier=='STRONG'
                 else Y if con_tier in ('SOLID','PARTIAL') else D)
    con_gate_icons = {'REGIME_CONFIRMED':'REG','SIGNAL_TIER1':'T1',
                      'POWER_COMBO':'PWR','SEC_DEPTH':'SEC','TICK_CONFIRM':'TICK'}
    con_parts = [f"{G if v else RD}{con_gate_icons.get(k,k)}{'✓' if v else '✗'}{R}"
                 for k, v in con['gates'].items()]
    print(f"  {con_col}CON:{R}  {con_score}/{con['total']} [{' '.join(con_parts)}]  "
          f"{con_col}{con_tier}{R}"
          + (f"  {con_col}{con['label']}{R}" if con.get('label') and con_tier in ('ELITE','STRONG','SOLID') else ""))

    # Size/regime notes
    if sig.regime == 'NEWS_CONTINUATION':
        print(f"  {Y}NOTE: NC regime — A edge thin (A=−3.3%). Apply −25% A size.{R}")
    if sig.tier == 'MEDIUM' and wc_score < 4:
        print(f"  {Y}NOTE: MEDIUM + WC<4 — A=+0.3% avg. E-only recommended.{R}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 5: OUTCOME — all expected-return data with source cited
    # ────────────────────────────────────────────────────────────────────
    print(f"  {'═'*W}")
    _hdr_zone("OUTCOME  (data-backed)")

    print(f"  Expected:  ret={sig.expected_ret}  MAE={sig.expected_mae}  "
          f"Stop={sig.stop_pct}  Strategy:{sig.strategy}")

    _bp_active = gru['bp_score'] >= 4
    if _bp_active and bp_tier in ('BLUEPR8NT','BLUEPR8NT_CANDIDATE'):
        print(f"  BP data:   A={bp['bp_avg_a']} / E={bp['bp_avg_e']}  "
              f"MFE={bp['bp_mfe_e']}  "
              f"MAE:+14.3% (vs +21.1% non-BP) — tighter stops valid")
        print(f"  Hold:      E 150+ min · trail stop · target MFE −47.1%")
    elif gru_tier in ('HIGH','EXCEPTIONAL','DEVELOPING'):
        print(f"  Hold:      cover A at 60-90min · hold E to 90-120min")

    if wc_tier in ('WINNERS_CIRCLE','QUALIFYING'):
        print(f"  WC range:  A: {wc['exp_a']}   E: {wc['exp_e']}")

    if gru_tier == 'SKIP':
        print(f"  {RD+B}⛔ GRU SKIP — A=+6.1% LOSING (n=33). No A or E trade.{R}")
    elif wc_score <= 1:
        print(f"  {RD+B}⛔ WC 0-1 — A=+12.0% LOSING (n=33). No A trade.{R}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 6: TICK
    # ────────────────────────────────────────────────────────────────────
    _tf = getattr(sig, '_tick_features', None)
    if _tf is not None and getattr(_tf, 'ticks_available', False):
        print(f"  {'═'*W}")
        _hdr_zone("TICK")
        try:
            from cat5ive_classifier_v4 import print_tick_features as _ptf
            _ptf(_tf)
            # Mark ticks as already printed so v4 doesn't double-print
            setattr(_tf, '_printed_by_print_signal', True)
        except ImportError:
            # v4 not available — print basic tick info
            print(f"  n={getattr(_tf,'n_ticks',0):,}  "
                  f"Rate:{getattr(_tf,'tick_rate_pm',0):.0f}/min  "
                  f"VPIN:{getattr(_tf,'proxy_vpin',0):.3f}  "
                  f"Buy:{getattr(_tf,'buy_pressure_pct',0):.0f}%  "
                  f"ScoreΔ:{getattr(_tf,'tick_score_delta',0):+d}")

    # ────────────────────────────────────────────────────────────────────
    # ZONE 7: GUIDELINES ENGINE
    # ────────────────────────────────────────────────────────────────────
    print(f"  {'═'*W}")
    _hdr_zone("GUIDELINES ENGINE")

    _sig_ref = sig   # capture before try block to prevent shadowing
    try:
        import importlib.util as _ilu, os as _os, sys as _sys
        _gp = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                             'guidelines_engine.py')
        if _os.path.exists(_gp):
            # Cache module to avoid re-executing on every poll
            if not hasattr(print_signal, '_ge_mod') or print_signal._ge_mod is None:
                _spec = _ilu.spec_from_file_location('guidelines_engine', _gp)
                _mod  = _ilu.module_from_spec(_spec)
                # Must register in sys.modules BEFORE exec so @dataclass resolves
                _sys.modules['guidelines_engine'] = _mod
                _argv_bak = _sys.argv[:]
                _sys.argv = [_gp]
                _spec.loader.exec_module(_mod)
                _sys.argv = _argv_bak
                print_signal._ge_mod = _mod
            # Pass DISTRIBUTION state from signal if available
            # status_inquisit computes state_run_length for DISTRIBUTION only
            _dist_state  = getattr(_sig_ref, 'current_state',
                           getattr(_sig_ref, 'state', None))
            _dist_run    = int(getattr(_sig_ref, 'state_run_length', 0) or 0)
            # Try full signature first; fall back to old signature if dist_state
            # not yet supported (older guidelines_engine.py on disk)
            try:
                _v = print_signal._ge_mod.evaluate_signal(
                    _sig_ref,
                    dist_state=_dist_state,
                    dist_run_length=_dist_run,
                )
            except TypeError:
                _v = print_signal._ge_mod.evaluate_signal(_sig_ref)

            hod_sym  = f"{G}✓{R}" if _v.hod_pct < 30 else f"{Y}✗{R}"
            qd_sym   = f"{G}✓{R}" if _v.quiet_dump else f"{RD}✗{R}"
            edge_sym = f"{G+B}ACTIVE{R}" if _v.primary_edge_active else f"{Y}PARTIAL{R}" if hod_pct < 30 else f"{RD}NOT ACTIVE{R}"

            print(f"  HOD {hod_sym} {_v.hod_pct:.0f}%  QD {qd_sym}  "
                  f"→  Primary edge: {edge_sym}")
            tc_col = {'PRIME':G+B,'GOOD':G,'MIXED':Y,'POOR':RD,'SKIP':RD+B}.get(_v.eq_tier, D)
            print(f"  EQ: {tc_col}{_v.eq_score}/100 [{_v.eq_tier}]{R}  "
                  f"Size: {_v.size_modifier:.0%}")

            if _v.avoid_violations:
                print(f"  {RD}Avoid: {' · '.join(_v.avoid_violations[:2])}{R}")
            if _v.confirmations:
                print(f"  {G}Confirm: {' · '.join(_v.confirmations[:2])}{R}")

            vc_col = {'GO':G+B,'CAUTION':Y+B,'NO-GO':RD,'BLOCK':RD+B}.get(_v.verdict, D)
            print(f"  {vc_col}{'─'*16}  VERDICT: {_v.verdict}  {'─'*16}{R}")
            for rsn in _v.reasons[:2]:
                print(f"  {D}{rsn}{R}")
            # Soft language backing
            if _v.verdict in ('NO-GO','BLOCK') and _v.primary_edge_active == False and hod_pct < 30:
                print(f"  {Y}MONITOR — HOD condition met. Watch for QD activation "
                      f"+ chop drop <80%. If both clear: 82.1% historical win.{R}")
            elif _v.verdict == 'GO':
                print(f"  {G}PROCEED — primary edge active (n=28 historical). "
                      f"Hold through MAE per §4 guidance.{R}")
            elif _v.verdict == 'CAUTION':
                print(f"  {Y}REDUCE SIZE — edge present but conditions not clean. "
                      f"Half size until blockers resolve.{R}")
        else:
            print(f"  {D}guidelines_engine.py not found — drop in same folder{R}")
    except Exception as _ge:
        print(f"  {D}[Guidelines Engine: {_ge}]{R}")

    print(f"  {'═'*W}")

def log_signal(sig: ClassifierSignal, log_dir: str, session_date: str = None):
    os.makedirs(log_dir, exist_ok=True)
    _log_path = os.path.join(log_dir, f"classifier_{date.today().isoformat()}.jsonl")
    _entry = asdict(sig)
    # Inject session_date so enrich_dual_master.py can match by (ticker, session_date)
    if session_date:
        _entry['session_date'] = str(session_date)
    with open(_log_path, 'a') as f:
        f.write(json.dumps(_entry) + '\n')


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 7 — KEY LOADING & CLI
# ═══════════════════════════════════════════════════════════════════════════

def load_keys(config_path: str = None) -> tuple:
    """Load API keys: env vars → config.json.
    Returns (tradier, databento, fmp).
    NOTE: 'databento' replaces the old 'polygon' slot in this tuple —
    update any unpacking call sites: tradier_key, databento_key, fmp_key = load_keys(...)
    """
    tradier   = os.environ.get('TRADIER_API_KEY','')
    databento = os.environ.get('DATABENTO_API_KEY','')
    fmp       = os.environ.get('FMP_API_KEY','')

    if config_path and os.path.exists(config_path):
        try:
            with open(config_path) as f:
                cfg = json.load(f)
            tradier   = tradier   or cfg.get('tradier_key','')
            databento = databento or cfg.get('databento_key','') or cfg.get('polygon_key','')
            fmp       = fmp       or cfg.get('fmp_key','')
        except Exception:
            pass
    else:
        # Auto-scan: look for config.json in script dir and cwd
        for try_path in [
            os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json'),
            os.path.join(os.getcwd(), 'config.json'),
        ]:
            if os.path.exists(try_path):
                try:
                    with open(try_path) as f:
                        cfg = json.load(f)
                    tradier   = tradier   or cfg.get('tradier_key','')
                    databento = databento or cfg.get('databento_key','') or cfg.get('polygon_key','')
                    fmp       = fmp       or cfg.get('fmp_key','')
                    break
                except Exception:
                    pass

    return tradier, databento, fmp


def main():
    p = argparse.ArgumentParser(
        description='Cat5ive Standalone Real-Time Classifier v3.0')
    p.add_argument('tickers', nargs='+')
    p.add_argument('--date',      default=None,
                   help='YYYY-MM-DD (default: today)')
    p.add_argument('--no-sec',    action='store_true',
                   help='Disable SEC EDGAR filing lookup')
    p.add_argument('--time',      default=None,
                   help='HH:MM — stop analysis at this bar (snapshot mode)')
    p.add_argument('--interval',  type=int, default=90)
    p.add_argument('--once',      action='store_true')
    p.add_argument('--json',      action='store_true')
    p.add_argument('--quiet',     action='store_true')
    p.add_argument('--high-value-only', action='store_true')
    p.add_argument('--min-quality',     type=int, default=0)
    p.add_argument('--config',    default=None,
                   help='Path to config.json with tradier_key/databento_key/fmp_key')
    p.add_argument('--log-dir',   default=None)
    p.add_argument('--no-float',  action='store_true',
                   help='Skip float fetch (faster startup, disables float_turnover gate)')

    args    = p.parse_args()
    tickers = [t.upper() for t in args.tickers]
    tradier_key, databento_key, fmp_key = load_keys(args.config)
    session_date = args.date or date.today().isoformat()
    log_dir = args.log_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'classifier_logs')

    if not args.json:
        print(f"\n{BOLD}{'='*64}")
        print(f"CAT5IVE STANDALONE CLASSIFIER v3.0")
        print(f"{'='*64}{RESET}")
        print(f"  Date:     {session_date}")
        if args.time:
            print(f"  Time:     {args.time} (snapshot mode)")
        print(f"  Tickers:  {', '.join(tickers)}")
        src = 'Tradier' if tradier_key else 'Databento' if databento_key else 'yfinance'
        print(f"  Source:   {src}  FMP:{'yes' if fmp_key else 'no'}")
        print(f"  Interval: {args.interval}s  Mode: {'once' if args.once else 'continuous'}")
        print(f"  Logs:     {log_dir}")
        print(f"{BOLD}{'='*64}{RESET}\n")

        if not tradier_key and not databento_key and not HAS_YF:
            print(f"{RED}ERROR: No API keys found and yfinance not installed.")
            print(f"  setx TRADIER_API_KEY  \"your_key\"")
            print(f"  setx DATABENTO_API_KEY  \"your_key\"")
            print(f"  OR: pip install yfinance  (slow fallback){RESET}")
            sys.exit(1)

    # ── Prefetch float shares (once per ticker, session-cached) ─────────────
    float_map = {}
    if not args.no_float:
        for tkr in tickers:
            fs = fetch_float_shares(tkr, fmp_key)
            float_map[tkr] = fs
            if not args.json and fs > 0:
                print(f"  {tkr:8} float: {GRN}{fs/1e6:.2f}M shares{RESET}")
            elif not args.json:
                print(f"  {tkr:8} float: {YEL}not found{RESET}  "
                      f"(float_turnover gate disabled for this ticker)")

    poll_count = 0
    try:
        while True:
            poll_count += 1
            now = datetime.now()

            if not args.json:
                print(f"{DIM}[poll {poll_count}] {now.strftime('%H:%M:%S')} ET{RESET}")

            # Market hours check (live mode only)
            if not args.date and (now.hour < 4 or now.hour >= 20):
                if not args.json:
                    print(f"  {DIM}Outside 4am-8pm ET — sleeping{RESET}")
                if args.once: break
                time.sleep(args.interval)
                continue

            signals_this_poll = []
            for tkr in tickers:
                try:
                    if not args.json:
                        print(f"  {tkr:8} {DIM}fetching...{RESET}", end='\r', flush=True)

                    bars = get_bars(tkr, session_date, tradier_key, databento_key)

                    # Snapshot mode: truncate bars at --time
                    if args.time:
                        cutoff = args.time.strip()[:5]
                        bars   = [b for b in bars if b.ts <= cutoff]
                        if not bars:
                            if not args.json:
                                print(f"  {tkr:8} No bars before {cutoff} on {session_date}")
                            continue

                    fs  = float_map.get(tkr, 0)
                    sig = run_classification(tkr, bars,
                                             session_date=session_date,
                                             no_sec=args.no_sec,
                                             float_shares=fs,
                                             tradier_key=tradier_key)
                    log_signal(sig, log_dir, session_date=session_date)

                    # Apply filters
                    if args.high_value_only and sig.signal in ('WAIT','SKIP'):
                        if not args.json:
                            print(f"  {tkr:8} {DIM}{sig.signal} (filtered){RESET}      ")
                        continue
                    if sig.quality_score < args.min_quality:
                        if not args.json:
                            print(f"  {tkr:8} {DIM}Q={sig.quality_score} < {args.min_quality} (filtered){RESET}")
                        continue

                    if args.json:
                        print(json.dumps(asdict(sig)))
                    else:
                        print_signal(sig, verbose=not args.quiet)

                    signals_this_poll.append(sig)

                except Exception as e:
                    if not args.json:
                        print(f"  {tkr:8} {RED}Error: {e}{RESET}")

            # Multi-ticker summary
            if not args.json and len(tickers) > 1 and signals_this_poll:
                print(f"\n  {BOLD}Summary:{RESET}")
                for s in sorted(signals_this_poll, key=lambda x: -x.quality_score):
                    sc = SIG_COLOR.get(s.signal,'')
                    qd = f" {GRN}QD{RESET}" if s.quiet_dump_proxy else "   "
                    ec = f" {CYN}EC{RESET}" if s.entry_c_fired  else "   "
                    print(f"    {s.ticker:8} {sc}{s.signal:12}{RESET} "
                          f"Q={s.quality_score:>3}  {s.regime[:18]:18}  "
                          f"{s.tier:6}  {s.section}{qd}{ec}  "
                          f"{s.intraday_gain_bucket:10}")

            if args.once: break

            nxt = datetime.fromtimestamp(time.time()+args.interval).strftime('%H:%M:%S')
            if not args.json:
                print(f"\n{DIM}  Next: {nxt} ET  (Ctrl+C to stop){RESET}\n")
            time.sleep(args.interval)

    except KeyboardInterrupt:
        if not args.json:
            print(f"\n{DIM}Stopped.  Logs: {log_dir}{RESET}")


if __name__ == '__main__':
    main()
