#!/usr/bin/env python3
"""
cat5ive_classifier_v3.py â Real-Time Trade Classifier
=======================================================
v3.0 â Data-heist gates wired in from dual backtest analysis.

ZERO DEPENDENCIES on cat5ive_sim.py or any other local file.
Single self-contained file. Copy anywhere. Run anywhere.

Fetches live 1-minute bars from Tradier â Polygon â yfinance.
Computes signals, S1/S2 classification, scoring, and alert grading
from raw OHLCV bar data only.

NEW IN v3 vs v2:
  â¦ vol_above_vwap_pct gate  (>80% â â18 score, confirmed disqualifier)
  â¦ hod_timing gate          (>60% elapsed â â20 score, hard gate)
  â¦ intraday_gain_bucket     (45-70% spike â â15 score; SUB10 â +bonus)
  â¦ quiet_dump_proxy         (intraday: gain<45% AND >20% below PM open â +15)
  â¦ at/above HOD block       (entry â¥ 0% from HOD â disqualifier)
  â¦ float_turnover gate      (<10% â disqualifier; fetched FMPâFinvizâyfinance)
  â¦ session_low gate         (LOD <10% below PM open â warning)
  â¦ score_trajectory         (OLS slope across polls â RISING/FLAT/FALLING)
  â¦ entry_c detection        (3 clean bars post-entry â position-add signal)
  â¦ momentum_decay_rate      (HOD fade rate; moderate = bonus)
  â¦ G5 threshold tightened   (0.65 â 0.55 per data; <55% conf = losing trade)

SETUP (one time):
  setx TRADIER_API_KEY  "your_production_key"
  setx POLYGON_API_KEY  "your_polygon_key"
  setx FMP_API_KEY      "your_fmp_key"        (optional â improves float fetch)

  OR create config.json anywhere and pass with --config:
  {
    "tradier_key": "...",
    "polygon_key": "...",
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
  # signal['signal']              â 'HIGH_VALUE' / 'ENTER_E' / 'WAIT' / 'SKIP'
  # signal['quality_score']       â 0-100
  # signal['grade']               â 'A' / 'B' / 'C'
  # signal['quiet_dump_proxy']    â True/False  (v3 new)
  # signal['intraday_gain_bucket']â 'SUB10' / '10-20pct' / '45-70pct' etc (v3)
  # signal['score_trajectory']    â 'RISING' / 'FLAT' / 'FALLING'  (v3)
  # signal['entry_c_fired']       â True/False  (v3 new)
"""

import os, sys, time, json, argparse, math
from collections import deque
from datetime import datetime, date, timedelta
from dataclasses import dataclass, field, asdict
from typing import Optional, List

# ââ Optional imports (graceful fallback) âââââââââââââââââââââââââââââââââââââ
try:    import requests;    HAS_REQUESTS = True
except: HAS_REQUESTS = False

try:    import yfinance as yf; HAS_YF = True
except: HAS_YF = False

# ââ Terminal colours ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
BOLD='\\033[1m'; RESET='\\033[0m'; GRN='\\033[92m'; YEL='\\033[93m'
RED='\\033[91m'; CYN='\\033[96m'; MAG='\\033[95m'; DIM='\\033[2m'

# ââ Signal definitions (guidelines v3.0) âââââââââââââââââââââââââââââââââââââ
TIER_1 = {'SUPPLY_OVERHANG','AH_REVERSAL_TRAP','LIVE_STRENGTH',
           'DAY3_EXHAUSTION','LATE_PHASE','MEAN_REVERSION_GAP'}
TIER_2 = {'PM_SELL_PRESSURE','OVEREXTENDED_AH_S2','PM_FADE_CONFIRMED',
           '424B5_ACTIVE','PM_FADE_MOVE'}
TIER_3 = {'VWAP_FAIL_S1','DILUTION_DUMP_SIGNAL','SERIAL_HEAVY',
           'OVEREXTENDED_OPEN','HIGH_VOL_REJECTION'}
ALL_Q  = TIER_1 | TIER_2 | TIER_3

# v3 â new signals (informational, used in score adjustments)
V3_SIGNALS = {'LATE_HOD', 'HEAVY_VWAP_DIST', 'MEDIUM_SPIKE_ZONE', 'DEEP_SESSION_LOW',
              'QUIET_DUMP_PROXY', 'ENTRY_C_WINDOW', 'LOW_SESSION_LOW'}

POWER_COMBOS = [
    ({'PM_SELL_PRESSURE','VWAP_FAIL_S1'},        19.44, 'PM_SELL+VWAP'),
    ({'SUPPLY_OVERHANG','VWAP_FAIL_S1'},         14.21, 'SUPPLY+VWAP'),
    ({'PM_FADE_CONFIRMED','SUPPLY_OVERHANG'},      9.14, 'FADE+SUPPLY'),
    ({'PM_SELL_PRESSURE','PM_FADE_CONFIRMED'},     8.20, 'PM_SELL+FADE'),
    ({'OVEREXTENDED_AH_S2','VWAP_FAIL_S1'},      12.80, 'OVEREXT+VWAP'),
    # v3 power combos
    ({'QUIET_DUMP_PROXY','VWAP_FAIL_S1'},         16.50, 'QUIET_DUMP+VWAP'),
    ({'QUIET_DUMP_PROXY','PM_SELL_PRESSURE'},      14.80, 'QUIET_DUMP+SELL'),
]

# Expected values updated from dual_report (197 sessions, guidelines v3)
# Format: (MAE, expected_ret, stop)
# MAE = how far adverse before dump develops (must tolerate this)
# expected_ret = avg D0 return for strategy
EXPECTED = {
    # DILUTION_DUMP â most reliable (n=68)
    ('DILUTION_DUMP',       'A'): ('+16%', '-8.9%',  '+18%'),
    ('DILUTION_DUMP',       'E'): ('+16%', '-18.7%', '+20%'),
    # BLUEPR8NT sessions within DD â separate category (n=9)
    ('DILUTION_DUMP',       'E_BP'): ('+14%', '-37.0%', '+16%'),
    # Deep session low within DD: 86% A win rate (n=38 â) â best size-up trigger
    ('DILUTION_DUMP',       'A_DEEP_LOD'): ('+12%', '-17.5%', '+14%'),
    # NEWS_CONTINUATION â thin A edge (n=121)
    ('NEWS_CONTINUATION',   'A'): ('+22%', '-3.3%',  '+25%'),  # slim: 150bps slippage erases it
    ('NEWS_CONTINUATION',   'E'): ('+21%', '-12.8%', '+22%'),
    # LOW_FLOAT_PARABOLIC â best regime (n=5, confirmed by median)
    ('LOW_FLOAT_PARABOLIC', 'A'): ('+12%', '-20.5%', '+15%'),
    ('LOW_FLOAT_PARABOLIC', 'E'): ('+10%', '-30.6%', '+12%'),
    # DEAD_CAT_BOUNCE â no data yet
    ('DEAD_CAT_BOUNCE',     'E'): ('+22%', '-??%',   '+25%'),
    # Fallback
    ('UNKNOWN',             'E'): ('+22%', '-18%',   '+25%'),
}

# ââ Score history for trajectory computation (per ticker, in-memory) âââââââââ
_score_history: dict = {}   # {ticker: deque(maxlen=20)}
_float_cache: dict   = {}   # {ticker: int}  â float shares, session-cached

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 1 â BAR DATA FETCHING
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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


# ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION â OHLCV GAP-FILL FEATURES (backtest alignment)
# ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def compute_near_miss_count(bars: List[Bar], vwaps: List[float]) -> int:
    """
    Count how many 1-min bars during the session had S1/S2 classification
    confidence within the 45-55% 'near threshold' zone (borderline S1/S2).
    These are the near-miss events tracked in the backtest NM_COUNT field.
    Report finding: 5-14 near misses = A=â14.0% (BEST A bucket).
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
    Report finding: choppy PM (<0.3) = A=â8.1% (n=109).
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
                # Found the spike origin â this is day N
                return days_back
        return 0  # No spike found in prior 7 days = fresh setup
    except Exception:
        return 0


# ââ Score bonus for run_day (from backtest combination analysis) âââââââââââ
_RUN_DAY_SCORE_ADJ = {
    1:  0,    # day1: no adj â standard setup
    2: -3,    # day2: slight fade â thesis still fresh but some bagholders
    3: -8,    # day3: significant fade â most bagholders aware now
    4: -12,   # day4+: heavy fade â exhaustion territory
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


def fetch_polygon(ticker: str, date_str: str, key: str) -> List[Bar]:
    if not HAS_REQUESTS or not key: return []
    try:
        dt_to = (datetime.strptime(date_str,'%Y-%m-%d')
                 + timedelta(days=1)).strftime('%Y-%m-%d')
        url = (f'https://api.polygon.io/v2/aggs/ticker/{ticker.upper()}'
               f'/range/1/minute/{date_str}/{dt_to}')
        r = requests.get(url, params={
            'adjusted':'true','sort':'asc',
            'limit':50000,'extended_hours':'true',
            'apiKey': key,
        }, timeout=15)
        data = r.json()
        raw  = data.get('results',[]) if data.get('status') in ('OK','DELAYED') else []
        bars = []
        for b in raw:
            ts = datetime.fromtimestamp(b['t']/1000).strftime('%Y-%m-%dT%H:%M')
            bars.append(Bar(
                ts=_ts_to_hhmm(ts), open=float(b.get('o',0)),
                high=float(b.get('h',0)), low=float(b.get('l',0)),
                close=float(b.get('c',0)), volume=int(b.get('v',0)),
                session=_et_session(ts),
            ))
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
             tradier_key: str, polygon_key: str) -> List[Bar]:
    """Fetch bars â Tradier â Polygon â yfinance."""
    bars = fetch_tradier(ticker, date_str, tradier_key)
    if bars: return bars
    bars = fetch_polygon(ticker, date_str, polygon_key)
    if bars: return bars
    return fetch_yfinance(ticker, date_str)


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 2 â TECHNICAL INDICATORS + v3 OHLCV FEATURES
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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


# ââ v3 OHLCV features âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
      SUB10    â â13.7% avg A   (strong short setup)
      10-20pct â â11.0%          (strong)
      20-45pct â â4.8%           (moderate)
      45-70pct â +5.4%           (LOSING â penalise)
      SPIKE70+ â â2.0%           (mixed)
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
    <10% = tight â stock barely dipped â losing A setup (+4.7%).
    >25% = deep â strong short confirmation.
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
    Data result: A = â25.3% avg when flag=1 (strongest bucket in report).
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
    >60% = late HOD â losing setup (A = +16.2%).
    <30% = early HOD â best setup (A = â10.6%).
    """
    if not bars: return 0.0
    _, hod_idx, _, _ = hod_lod(bars)
    return round(hod_idx / len(bars) * 100, 1)


def compute_score_trajectory(ticker: str, current_score: int) -> str:
    """
    OLS slope of pre-fall score across recent polls.
    RISING = score building â stronger setup.
    FALLING = score eroding â reduce size.
    Requires â¥5 data points; returns FLAT on first few polls.
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
    Entry C â least resistance entry signal.
    After dual entry has fired, scan for 3 consecutive clean bars:
      HIGH < 1.01 Ã prev_close (no rally)
      close < prev_close (descending)
    Data result: A = â8.7% when Entry C found vs â4.2% when not found.
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
    momentum_decay = (HOD - current_price) / (HOD Ã bars_since_HOD)
    Moderate range 0.01-0.05 = best A outcome (A = â12.7% avg).
    """
    if len(bars) < 2: return 0.0
    hod_v, hod_idx, _, _ = hod_lod(bars)
    if hod_v <= 0: return 0.0
    bars_since = len(bars) - 1 - hod_idx
    if bars_since <= 0: return 0.0
    price = bars[-1].close
    return round((hod_v - price) / (hod_v * bars_since), 4)


# ââ Float share fetching (FMP â Finviz â yfinance) âââââââââââââââââââââââââââ

def fetch_float_shares(ticker: str, fmp_key: str = '') -> int:
    """
    Fetch float shares for a ticker. Called once at startup; cached in
    _float_cache for the session.

    Sources: FMP â Finviz scrape â yfinance
    (EDGAR excluded â reports shares outstanding, not float)
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


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 3 â SIGNAL DETECTION (v2 signals + v3 new signals)
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

    # ââ v2 signals (unchanged) ââââââââââââââââââââââââââââââââââââââââââââââââ

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

    # LIVE_STRENGTH (inverse â bad for short)
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

    # ââ v3 NEW SIGNALS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

    # LATE_HOD: HOD formed in last 40% of session elapsed
    # Data: Late HOD >60% = A return +16.2% (LOSING). >40% = caution zone.
    # FIX v3.1: require len(bars) > 120 (2+ hours elapsed) before firing.
    # hod_set_pct uses hod_idx / len(bars_so_far) â in early session this
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
    # forming â the bucket may shift down once HOD stops updating.
    _, gain_bucket = compute_intraday_gain(bars)
    _hod_stable_ms = (len(bars) - 1 - hod_lod(bars)[1]) >= 30
    signals['MEDIUM_SPIKE_ZONE'] = (gain_bucket == '45-70pct' and _hod_stable_ms)

    # LOW_SESSION_LOW: LOD < 10% below PM open = stock barely dipped
    # Data: Tight <10% session low = A return +4.7% (LOSING)
    slvpo = compute_session_low_vs_pm_open(bars)
    signals['LOW_SESSION_LOW'] = (0 < slvpo < 10.0)

    # QUIET_DUMP_PROXY: small gain + already deep below PM open
    # Data: quiet_dump_flag = A return â25.3% (STRONGEST bucket in report)
    signals['QUIET_DUMP_PROXY'] = compute_quiet_dump_proxy(bars)

    # ENTRY_C_WINDOW: 3-bar clean descending window post-entry
    # Data: Entry C fired = A â8.7% vs A â4.2% when not fired
    signals['ENTRY_C_WINDOW'] = detect_entry_c(bars)

    # Return only True signals
    return {k: v for k, v in signals.items() if v}


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 4 â S1/S2 CLASSIFICATION
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 4b â SCORING + REGIME
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def compute_score(signals: dict, section: str,
                  confidence: int, bars: List[Bar],
                  float_turnover_pct: float = 0.0,
                  flips_rth: int = -1,
                  margin_lean: float = 0.0) -> tuple:
    """
    Compute pre-fall score (0-150) and tier.
    v3: data-heist gate adjustments applied directly to score.

    Gate adjustments (from dual backtest analysis):
      LATE_HOD        â â20  (A return +16.2% in late bucket = LOSING)
      HEAVY_VWAP_DIST â â18  (A return +12.5% in >80% bucket = LOSING)
      MEDIUM_SPIKE_ZONEâ â15 (A return +5.4% in 45-70% bucket = LOSING)
      QUIET_DUMP_PROXY â +15 (A return â25.3% when flag=1 = STRONGEST bucket)
      LOW_SESSION_LOW  â â10 (A return +4.7% when LOD<10% below open = LOSING)
      float_turnover<10â â10 (A return +0.1% when float turnover low = LOSING)
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
        if 0 < _hod_et < 34200:   # PM HOD â definitive early signal
            score += 15
        elif 0 < _hod_et < 37800:  # HOD before 10:30am RTH
            score += 8

    # ââ v3 gate adjustments âââââââââââââââââââââââââââââââââââââââââââââââââââ

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

    # ââ Winners Circle positive rewards (previously missing) âââââââââââââââââ
    # Data: vol_above_vwap < 40% = A â14.1% avg (best bucket by distribution)
    if bars:
        _wc_vwaps = compute_vwap(bars)
        _vav = compute_vol_above_vwap(bars, _wc_vwaps)
        if _vav < 40.0:
            score += 12   # Confirmed dump: volume concentrated below VWAP
        elif _vav < 55.0:
            score += 5    # Mixed distribution, slight advantage

    # Data: session_low depth correlates strongly with A win rate
    # Deep 25-50%: A win rate 86% (n=38 â) â stock proved thesis with deep LOD
    # Moderate 10-25%: A win rate 64% â meaningful dip, solid setup
    # Tight <10%: A win rate 43% â stock barely moved â LOW_SESSION_LOW -10 pts (above)
    if bars:
        _slvpo = compute_session_low_vs_pm_open(bars)
        if _slvpo >= 25.0:
            score += 12   # DEEP session low: 86% A win rate (n=38 â)
            signals['DEEP_SESSION_LOW'] = True
        elif _slvpo >= 20.0:
            score += 8    # Strong dip from PM open â thesis confirmed
        elif _slvpo >= 10.0:
            score += 4    # Meaningful dip from open

    # Data: confidence â¥ 85% = A â10.3% avg vs +1.8% for <55%
    if confidence >= 85:
        score += 8    # High classifier certainty = strongest S1 conviction
    elif confidence >= 70:
        score += 4    # Good conviction

    # SUB10 gain bonus â small spike + descending = strong setup
    # FIX v3.1: require HOD stable 30+ bars before awarding bucket bonus.
    # Running HOD can temporarily show SUB10 while the spike is still forming.
    _, gain_bucket = compute_intraday_gain(bars)
    _hod_stable_sub10 = (len(bars) - 1 - hod_lod(bars)[1]) >= 30
    if gain_bucket == 'SUB10' and signals.get('VWAP_FAIL_S1') and _hod_stable_sub10:
        score += 8                  # A = â13.7% in SUB10 bucket (confirmed HOD)

    # FIX v3.1 Fix 7: bid_depth_decay bonus uses PM window (not pre_hod).
    # pre_hod window requires knowing future HOD timestamp â future-contaminated.
    # PM window (bid_depth_decay_pm) is finalized at 9:30am â live-safe.
    _bdp = float_turnover_pct  # reuse float_turnover_pct scope; actual value below
    # Note: bid_depth_decay_pm comes from L2 data when available via l1_l2_extractor
    # In live classifier, passed via extra_fields dict if L2 feed is connected.
    # Score impact: wallpaper book (Î»>0.7) in PM = +6 pts (A=â8.3% avg)

    # ââ New findings from guidelines v3 ââââââââââââââââââââââââââââââââââââââ
    # 0 flips: cleanest session (A=â11.9%, n=60 â). Reward unambiguous sessions.
    if flips_rth == 0:
        score += 5
    # S1 lean >3: best margin lean bucket (A=â10.8%, n=40 â).
    if margin_lean > 3.0:
        score += 3
    # NEWS_CONTINUATION: thin A edge (A=â3.3%).
    if signals.get('NC_REGIME_THIN'):
        score -= 8

    # CONTESTED SESSION penalty (new finding from report v3)
    # CLEAN sessions (flipsâ¤8 AND consec_s1â¥5): A=â11.7%, E=â27.4% (n=49 â)
    # CONTESTED sessions (148/197 = 75% of dataset): A=â3.9% only
    # Difference: 3Ã better returns for clean sessions
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
    """Count S1âS2 flips in RTH bars."""
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


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 5 â CLASSIFICATION ENGINE
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
    t2_entry_type:      str   = 'NOT_QUALIFIED'
    last_bar_time:      str   = ''
    sec_cache_age_hrs:  float = 0.0
    # ââ v3 new fields ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    vol_above_vwap_pct:     float = 0.0   # % of volume traded above VWAP
    intraday_gain_pct:      float = 0.0   # (HOD - PM_open) / PM_open Ã 100
    intraday_gain_bucket:   str   = ''    # SUB10/10-20pct/20-45pct/45-70pct/SPIKE70+
    session_low_vs_pm_open: float = 0.0   # how far LOD below PM open %
    quiet_dump_proxy:       bool  = False # intraday quiet dump signal
    score_trajectory:       str   = 'FLAT'  # RISING/FLAT/FALLING across polls
    pm_open_price:          float = 0.0   # first PM bar open
    entry_c_fired:          bool  = False # 3-bar clean window detected
    float_shares:           int   = 0     # float shares from FMP/Finviz/yfinance
    float_turnover_pct:     float = 0.0   # PM_volume / float_shares Ã 100
    momentum_decay_rate:    float = 0.0   # price fade from HOD per bar
    hod_set_pct:            float = 0.0   # % session elapsed when HOD formed
    v3_gate_notes:          List[str] = None  # v3 gate adjustment log

    # ââ Gap-fill fields (backtest-aligned, v3.1+) ââââââââââââââââââââââââââ
    near_miss_count:        int   = 0     # bars where conf crossed 45-55% threshold
    run_day:               int   = 0     # which day of the move (1=day1, 2=day2, 0=unknown)
    price_path_efficiency: float = 0.0   # net PM move / total bar path (straight vs zig-zag)
    contested_day:         bool  = False # True when flips>8 AND consec_s1<5
    margin_lean:           float = 0.0   # mean lean value across last 20 bars
    score_delta_pre:       int   = 0     # raw score change 5 bars before entry
    # ── WC / BLUEPR8NT outputs ─────────────────────────────────────────────
    wc_score:              int   = 0     # Winners Circle gates passed (0-7)
    wc_tier:               str   = ''    # WINNERS_CIRCLE / QUALIFYING / DEVELOPING / NOT_QUALIFYING
    bp_score:              int   = 0     # BLUEPR8NT gates passed (0-5)
    bp_tier:               str   = ''    # BLUEPR8NT / BLUEPR8NT_CANDIDATE / BP_WATCH / NOT_BP


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
                    hod_time='â', lod_time='â', hod_bars_ago=0,
                    consec_s1=0, s1_pct=0.0, vol_spike=0.0,
                    session_pct=0.0, all_signals=[], suggested_size='â',
                    next_watch='â',
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
    hod_time = bars[hod_idx].ts if hod_idx < len(bars) else 'â'
    lod_time = bars[lod_idx].ts if lod_idx < len(bars) else 'â'
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
        nxt = f"Wait for S1 flip â currently S2 ({consec_s1} bars)"
    elif ez == 'DEAD_ZONE':
        zone_a_px = round(hod_v * 0.95, 3)
        zone_b_px = round(hod_v * 0.85, 3)
        nxt = (f"Exit dead zone â need price > ${zone_a_px} (Zone A) "
               f"or < ${zone_b_px} (Zone B)")
        if score >= 75 and section == 'S1':
            nxt += " | HIGH tier â re-evaluate at RTH open for Strategy A"
    elif chop >= 80:
        if score >= 75 and flips <= 3 and section == 'S1':
            nxt = f"Chop {chop:.0f}% high but Score {score} + {flips} flips â monitor"
        else:
            nxt = f"Wait for chop to drop below 80% (currently {chop:.0f}%)"
    elif flips > 6 and flips <= 14:
        nxt = f"Many flips ({flips}) â reduce size, confirm direction"
    elif not set(all_sigs) & ALL_Q:
        nxt = "Wait for qualifying signal (VWAP_FAIL_S1, PM_SELL_PRESSURE, etc)"
    else:
        nxt = f"Setup valid â monitor S1 persistence ({consec_s1} consec bars)"

    # ââ v3 field computations âââââââââââââââââââââââââââââââââââââââââââââââââ
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
        v3_notes.append(f"LATE_HOD({hod_sp:.0f}%): â20 pts")
    if signals.get('HEAVY_VWAP_DIST'):
        v3_notes.append(f"HEAVY_VWAP({vav_pct:.0f}%): â18 pts")
    if signals.get('MEDIUM_SPIKE_ZONE'):
        v3_notes.append(f"MED_SPIKE({gain_pct:.0f}%): â15 pts")
    if signals.get('QUIET_DUMP_PROXY'):
        v3_notes.append(f"QUIET_DUMP: +15 pts")
    if signals.get('LOW_SESSION_LOW'):
        v3_notes.append(f"LOW_SESSION_LOW({slvpo:.0f}%): â10 pts")
    if 0 < ft_pct < 10:
        v3_notes.append(f"LOW_FLOAT_TURN({ft_pct:.1f}%): â10 pts")

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


# ââ SEC EDGAR filing integration (unchanged from v2) âââââââââââââââââââââââââ
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
    Results cached in sec_cache.json (24hr TTL â CIK cached permanently).
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
        ts_key = f'filings_ts_{ticker.upper()}'
        cache_age_hrs = round((datetime.now().timestamp() - cache.get(ts_key, datetime.now().timestamp())) / 3600, 2)

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
            cache_age_hrs=cache_age_hrs,
        )
    except Exception:
        return empty


def evaluate_gates(sig: 'ClassifierSignal') -> tuple:
    """
    Evaluate entry gates. Returns (gates_passed, gate_detail, disqualifiers, bias).

    Gate 1 â disqualifiers:    must be empty (no structural blockers)
    Gate 2 â pre_fall_tier:    HIGH or MEDIUM (score >= 25)
    Gate 3 â bias:             MAX_CONVICTION or HIGH_CONVICTION
    Gate 4 â section:          S1
    Gate 5 â confidence_norm:  >= 0.55 (v3 tightened from 0.65; <55% = losing)

    v3 new disqualifiers:
      AT_OR_ABOVE_HOD      â entry at or above HOD (A return +1.0% = LOSING)
      LOW_FLOAT_TURNOVER   â float turnover < 10% (A return â 0% = LOSING)
      LATE_HOD_HARD_BLOCK  â HOD set after 60% AND score < 25 (no saving grace)
    """
    disqualifiers = []
    gate_detail   = []

    # ââ v2 disqualifiers (preserved) âââââââââââââââââââââââââââââââââââââââââ
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

    # ââ v3 new disqualifiers ââââââââââââââââââââââââââââââââââââââââââââââââââ
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

    # ââ Bias mapping ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if sig.signal == 'HIGH_VALUE' and sig.grade == 'A':
        bias = 'MAX_CONVICTION'
    elif sig.signal in ('ENTER_E', 'ENTER_A') and sig.grade == 'B':
        bias = 'HIGH_CONVICTION'
    elif sig.signal == 'WAIT' and sig.grade == 'C' and sig.score >= 25:
        bias = 'LOW_CONVICTION'
    else:
        bias = 'NO_CONVICTION'

    # ââ Gate evaluation âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    g1 = len(disqualifiers) == 0
    g2 = sig.tier in ('HIGH', 'MEDIUM')
    g3 = bias in ('MAX_CONVICTION', 'HIGH_CONVICTION')
    g4 = sig.section == 'S1'
    conf_norm = sig.confidence_norm
    g5_standard       = conf_norm >= 0.55
    g5_slightly_early = (0.50 <= conf_norm < 0.55
                         and sig.signal_tier in ('TIER_1', 'TIER_2')
                         and sig.section == 'S1')
    g5_early          = (0.45 <= conf_norm < 0.50 and sig.section == 'S1')
    g5_very_early     = (0.40 <= conf_norm < 0.45
                         and sig.signal_tier == 'TIER_1'
                         and sig.section == 'S1')
    g5 = g5_standard or g5_slightly_early

    if any('PREMATURE_RISK' in d for d in disqualifiers):
        t2 = 'PREMATURE_RISK'
    elif g5_standard:
        t2 = 'ON_TIME'
    elif g5_slightly_early:
        t2 = 'SLIGHTLY_EARLY'
    elif g5_early:
        t2 = 'EARLY'
    elif g5_very_early:
        t2 = 'VERY_EARLY'
    else:
        t2 = 'NOT_QUALIFIED'

    gate_detail = [
        f"G1:disqualifiers={'PASS' if g1 else 'FAIL('+','.join(disqualifiers)+')'}",
        f"G2:tier={sig.tier}={'PASS' if g2 else 'FAIL(need HIGH or MEDIUM)'}",
        f"G3:bias={bias}={'PASS' if g3 else 'FAIL(need MAX or HIGH conviction)'}",
        f"G4:section={sig.section}={'PASS' if g4 else 'FAIL(need S1)'}",
        f"G5:conf={conf_norm:.2f}={'PASS('+t2+')' if g5 else ('WATCH('+t2+')' if t2 in ('EARLY','VERY_EARLY') else 'FAIL')}",
    ]

    gates_passed = sum([g1, g2, g3, g4, g5])
    return gates_passed, gate_detail, disqualifiers, bias, t2


def run_classification(ticker: str, bars: List[Bar],
                       session_date: str = None, no_sec: bool = False,
                       float_shares: int = 0) -> 'ClassifierSignal':
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
            hod_time='â', lod_time='â', hod_bars_ago=0,
            consec_s1=0, s1_pct=0.0, vol_spike=0.0, session_pct=0.0,
            all_signals=[], suggested_size='â', next_watch='â',
            **{k: v for k, v in empty_v3.items()
               if k not in ('float_shares', 'v3_gate_notes')},
            float_shares=float_shares,
            score_trajectory='FLAT',
            v3_gate_notes=[],
        )
        return sig

    # ââ Compute float turnover âââââââââââââââââââââââââââââââââââââââââââââââââ
    pm_bars_list = [b for b in bars if b.session == 'PM']
    pm_vol = sum(b.volume for b in pm_bars_list)
    float_turnover_pct = round(pm_vol / float_shares * 100, 2) \
        if float_shares > 0 and pm_vol > 0 else 0.0

    # ââ Core indicators â ALL signals set before compute_score ââââââââââââââââââ
    vwaps      = compute_vwap(bars)
    signals    = detect_signals(bars, vwaps, float_turnover_pct)
    section, conf = classify_section(bars, vwaps, signals)

    # Compute session characteristics needed for pre-score signals
    _, _, pm_last, pm_move = pm_stats(bars)
    regime   = detect_regime(bars, pm_move, signals)
    flips    = count_rth_flips(bars, vwaps)
    chop     = compute_chop(bars)
    velocity = classify_velocity(bars, vwaps)

    # ââ Pre-score signals (must fire BEFORE compute_score reads them) ââââââââââ
    # NC_REGIME_THIN: NC regime has thin A edge (A=â3.3%) â -8 pts
    if regime == 'NEWS_CONTINUATION':
        signals['NC_REGIME_THIN'] = True

    # CONTESTED vs CLEAN (report v3): CLEAN A=â11.7% (n=49) vs CONTESTED A=â3.9%
    # Backtest definition: contested_day = (flips > 8 AND consec_s1_at_entry < 5)
    # consec_s1_at_entry defaults to 0 in CSV â effectively (flips > 8)
    if flips > 8:
        signals['CONTESTED_SESSION'] = True   # â â5 pts in compute_score
    else:
        signals['CLEAN_SESSION'] = True       # â +6 pts in compute_score

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

    # ââ SEC filing enrichment âââââââââââââââââââââââââââââââââââââââââââââââââ
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
    # Strategy selection from guidelines v3 (regime Ã strategy interaction)
    # LFP: both work â use A (less adverse excursion at entry)
    # NC:  E strongly preferred (E=â12.8% vs A=â3.3%)
    # DD:  both work â check BP later for E priority
    strategy     = 'A' if regime == 'LOW_FLOAT_PARABOLIC' else 'E'
    exp_mae, exp_ret, stop = EXPECTED.get(
        (regime, strategy), ('+22%','-18%','+25%'))

    # Score trajectory (across polls)
    traj = compute_score_trajectory(ticker, score)

    # ââ v3 feature values âââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

    # ââ Gap-fill features (backtest alignment) ââââââââââââââââââââââââââââ
    near_miss_ct   = compute_near_miss_count(bars, vwaps)
    path_eff       = compute_price_path_efficiency(bars)


    contested      = (flips > 8) and (
                         sum(1 for b in bars if b.session == 'rth') > 0 and
                         # use consecutive S1 proxy: low consec_s1 = contested
                         True)  # computed properly in build phase below
    # run_day: fetch prior history (async-safe via separate call)
    run_day_val    = detect_run_day(ticker, session_date or date.today().isoformat(),
                                    os.environ.get('TRADIER_API_KEY', ''))
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
    # near_miss bonus: 5-14 range = A=â14.0% (best bucket)
    if 5 <= near_miss_ct <= 14:
        score = max(0, min(150, score + 4))
        if   score >= 50: tier = 'HIGH'
        elif score >= 25: tier = 'MEDIUM'
        elif score >= 10: tier = 'LOW'
        else:             tier = 'SKIP'

    # ââ LONG OPPORTUNITY ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
            reasons=[f"LOD bounce â 95.8% rate | {pct_hod:.1f}% from HOD",
                     "S2 detected after big drop â LOD zone",
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
            last_bar_time=bars[-1].ts[:5] if bars else '',
            sec_cache_age_hrs=sec.get('cache_age_hrs', 0.0),
        )
        sig.quality_score    = calc_quality(sig)
        sig.confidence_norm  = round(sig.confidence / 100.0, 4)
        sig.pre_fall_tier    = sig.tier
        gp, gd, dq, bv, t2   = evaluate_gates(sig)
        sig.gates_passed     = gp
        sig.gate_detail      = gd
        sig.disqualifiers    = dq
        sig.bias             = bv
        sig.t2_entry_type    = t2
        return sig

    # ââ Build reasons / warnings ââââââââââââââââââââââââââââââââââââââââââââââ
    if section == 'S1':
        reasons.append(f"S1 confirmed  (confidence {conf}%)")
    else:
        warnings.append(f"Section = S2 â no short signal yet")
        # Data: S2 entry A=â13.0% (n=31) â valid on S2âS1 flip.
    # Report v3: CONTESTED vs CLEAN session advisory
    if signals.get('CONTESTED_SESSION'):
        warnings.append("CONTESTED session (flips>8): A=â3.9% avg. Reduce size â25%.")
    elif signals.get('CLEAN_SESSION'):
        reasons.append("CLEAN session (flipsâ¤8): A=â11.7% avg. Full size eligible.")

    # MEDIUM tier A restriction: data shows A=+0.3% LOSING in MEDIUM (n=26)
    if tier == 'MEDIUM':
        warnings.append("MEDIUM tier: A=+0.3% avg (barely profitable). E-only unless WCâ¥4/7.")

    # NEWS_CONTINUATION thin edge warning
    if regime == 'NEWS_CONTINUATION':
        warnings.append("NC regime: A edge thin (A=â3.3%). Prefer E. Apply â25% A size.")

    q_sigs = [s for s in active_sigs if s in ALL_Q]
    if q_sigs:
        reasons.append(f"{sig_tier}: {' | '.join(q_sigs[:4])}")
    else:
        warnings.append("No qualifying signals yet")

    if pwr_combo:
        reasons.append(f"Power combo: {pwr_combo} (lift {pwr_lift:.1f})")

    if velocity in ('RISING_FAST','RISING'):
        reasons.append(f"Confidence {velocity} â high-value indicator")
    elif velocity in ('FALLING','FALLING_FAST'):
        warnings.append(f"Confidence {velocity} â reduce size 30%")

    if flips == 0:
        reasons.append("0 RTH flips â freshest S1 (92.9% win)")
    elif flips <= 3:
        reasons.append(f"{flips} RTH flips â clean setup")
    elif flips > 6:
        warnings.append(f"{flips} RTH flips â reduce size 30%")

    chop_blocked = (chop >= 90 or
                    (chop >= 80 and (score < 75 or flips > 3)))
    if chop >= 80:
        if score >= 75 and flips <= 3:
            warnings.append(f"Chop {chop:.0f}% high but Score {score} + {flips} flips â allowed")
        else:
            warnings.append(f"Chop {chop:.0f}% >= 80% â DANGER (hard block)")

    if ez == 'DEAD_ZONE':
        warnings.append(f"{pct_hod:.1f}% below HOD â dead zone, wait")
    elif ez == 'ZONE_A':
        reasons.append(f"Within 5% of HOD â prime entry zone (90% win)")

    # v3 reasons/warnings
    if qdp:
        reasons.append(f"QUIET_DUMP_PROXY: gain {gain_pct:.0f}% + {slvpo:.0f}% below open (â25.3% avg)")
    if gain_bucket == 'SUB10':
        reasons.append(f"SUB10 gain ({gain_pct:.0f}%) â strongest short bucket (A â13.7% avg)")
    if signals.get('LATE_HOD'):
        warnings.append(f"LATE_HOD ({hod_sp:.0f}% elapsed) â A +16.2% in late bucket (LOSING)")
    if signals.get('HEAVY_VWAP_DIST'):
        warnings.append(f"HEAVY_VWAP_DIST ({vol_av:.0f}% vol above VWAP) â A +12.5% = LOSING")
    if signals.get('MEDIUM_SPIKE_ZONE'):
        warnings.append(f"MEDIUM_SPIKE_ZONE ({gain_pct:.0f}%) â A +5.4% = LOSING")
    if entry_c:
        reasons.append(f"ENTRY_C detected â 3-bar clean window (size +10%)")
    if traj == 'RISING':
        reasons.append("Score RISING across polls â strengthening setup")
    elif traj == 'FALLING':
        warnings.append("Score FALLING across polls â reduce size")
    # FIX v3.1 Fix 6: only award decay signal when HOD is confirmed stable 30+ bars.
    # momentum_decay = (HOD-price)/(HOD*bars_since_HOD) is meaningless if HOD just moved.
    _bars_since_hod_md = len(bars) - 1 - hod_lod(bars)[1] if bars else 0
    if 0.01 <= mom_dec <= 0.05 and _bars_since_hod_md >= 30:
        reasons.append(f"Momentum decay moderate ({mom_dec:.3f}) â A â12.7% avg")
    if 0 < slvpo < 10:
        warnings.append(f"Session low only {slvpo:.0f}% below PM open â A +4.7% avg (LOSING)")

    now_h = datetime.now().hour
    if slvpo >= 25.0:
        reasons.append(f"DEEP session low ({slvpo:.0f}% below open): A 86% win rate (n=38 â)")
    elif slvpo >= 10.0:
        reasons.append(f"Session low {slvpo:.0f}% below PM open: solid thesis confirmation")
    if 7 <= now_h < 8:
        warnings.append("07-08am window â highest E MAE (+65.9%)")

    # ââ Grade determination âââââââââââââââââââââââââââââââââââââââââââââââââââ
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
            reasons.append("GRADE A â all prime conditions met")
        else:
            out_signal = f'ENTER_{strategy}'
            out_grade  = 'B'
            reasons.append("GRADE B â standard qualifying entry")

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
    gp, gd, dq, bv, t2   = evaluate_gates(sig)
    sig.gates_passed     = gp
    sig.gate_detail      = gd
    sig.disqualifiers    = dq
    sig.bias             = bv
    sig.t2_entry_type    = t2
    _wc = evaluate_winners_circle(sig)
    sig.wc_score = _wc['score'];  sig.wc_tier = _wc['tier']
    _bp = evaluate_bluepr8nt(sig)
    sig.bp_score = _bp['score'];  sig.bp_tier = _bp['tier']
    return sig


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 6 â OUTPUT & LOGGING
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# WINNERS CIRCLE + BLUEPR8NT EVALUATION
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def evaluate_winners_circle(sig: 'ClassifierSignal') -> dict:
    """
    Score the session against the 7 Winners Circle gates.

    Winners Circle = sessions where A â â15 to â30% and E â â25 to â40%.
    Derived from backtest analysis of 214 sessions.

    Returns dict with gate results, WC score, tier label, and expected range.
    """
    gates = {}

    # Gate 1: Early HOD (hod_set_pct < 30% of elapsed OR hod_in_pm)
    try:
        _ht  = sig.hod_time[-5:] if sig.hod_time and sig.hod_time != 'â' else ''
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

    # Gate 5: High classifier confidence (â¥ 70%)
    gates['HIGH_CONF']  = sig.confidence >= 70

    # Gate 6: Entry in Zone A (within 5% of HOD â best E outcomes)
    gates['ZONE_A']     = sig.pct_from_hod > -5.0

    # Gate 7: Session proved its downside (LOD > 10% below PM open)
    gates['DEEP_LOD']   = sig.session_low_vs_pm_open > 10.0

    wc_score = sum(gates.values())

    # WC tier based on gates passed
    if wc_score >= 6:
        tier  = 'WINNERS_CIRCLE'
        exp_a = 'â20 to â35%'
        exp_e = 'â30 to â45%'
    elif wc_score >= 4:
        tier  = 'QUALIFYING'
        exp_a = 'â10 to â20%'
        exp_e = 'â15 to â25%'
    elif wc_score >= 2:
        tier  = 'DEVELOPING'
        exp_a = 'â5 to â10%'
        exp_e = 'â8 to â15%'
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
      A = â19.8%  (vs â5.1% rest)      â 4Ã better
      E = â37.0%  (vs â14.4% rest)     â 3Ã better
      Pre-fall score = 48.6 (vs 32.6)  â 49% higher conviction
      E MFE = â47.1% (vs â27.5%)       â 71% better ideal exit

    5 BLUEPR8NT detection gates:
      1. DILUTION_DUMP regime
      2. Pre-fall score > 40
      3. Quiet dump proxy (small gain + below open)
      4. Confidence â¥ 70%
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
        note      = 'All 5 gates â E priority. Expected E â â37%'
    elif bp_score >= 4:
        bp_tier   = 'BLUEPR8NT_CANDIDATE'
        note      = '4/5 gates â strong BP candidate. E preferred over A'
    elif bp_score >= 3:
        bp_tier   = 'BP_WATCH'
        note      = '3/5 gates â partial match. Monitor for confirmation'
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
    Concepts Score (0-5) â cross-cutting quality factors not covered
    by Winners Circle (setup purity) or BLUEPR8NT (catalyst).

    This layer measures the SIGNAL QUALITY and CONFIRMATION DEPTH:
    whether the session has institutional-grade signal strength,
    a power combination, a structural catalyst, and tick confirmation.

    Gates:
      1. REGIME_CONFIRMED   â Regime is DILUTION_DUMP (coordinated sell)
      2. SIGNAL_TIER1       â At least one Tier-1 signal firing
      3. POWER_COMBO        â A qualifying power combo detected
      4. SEC_DEPTH          â 424B5_ACTIVE or SERIAL_HEAVY from SEC data
      5. TICK_CONFIRM       â VPIN >0.55 or buy_pressure <35% (when available)
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
        # No tick data â use SEC dilution confirmation as proxy
        gates['TICK_CONFIRM'] = (sig.sec_available and
                                  sig.sec_offerings_12m >= 2)

    concepts_score = sum(gates.values())

    if concepts_score >= 5:
        tier  = 'ELITE'
        label = 'All 5 confirmations â maximum conviction'
    elif concepts_score >= 4:
        tier  = 'STRONG'
        label = 'High-quality backing â enter with confidence'
    elif concepts_score >= 3:
        tier  = 'SOLID'
        label = 'Good confirmation â standard size'
    elif concepts_score >= 2:
        tier  = 'PARTIAL'
        label = 'Partial confirmation â reduce size'
    else:
        tier  = 'WEAK'
        label = 'Insufficient backing â monitor only'

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
    Gate Round Up (GRU) Score â unified conviction index.

    Combines all three evaluation frameworks into a single score:

      Winners Circle (0-7):  Setup purity â structural fingerprint of
                              the best historical sessions. Answers:
                              "Does this look like the sessions that won?"

      BLUEPR8NT (0-5):       Catalyst depth â institutional/dilution
                              confirmation behind the dump. Answers:
                              "Is there a real reason this stock goes down?"

      Concepts (0-5):        Signal quality â tier, power combo, SEC depth,
                              tick confirmation. Answers:
                              "How well-backed is the signal quality?"

    Total: 0-17

    GRU Tiers:
      14-17  EXCEPTIONAL  â Strongest possible setup, all frameworks align
      10-13  HIGH         â Strong conviction, enter standard or full size
       6-9   DEVELOPING   â Setup building, monitor, reduced size if entering
       3-5   WEAK         â Below threshold, pass or paper trade only
       0-2   SKIP         â No setup

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
        label = 'All frameworks aligned â maximum conviction'
        size  = '100-125%'
        color = 'GRN+BOLD'
    elif total >= 10:
        tier  = 'HIGH'
        label = 'Strong conviction setup'
        size  = '100%'
        color = 'GRN'
    elif total >= 6:
        tier  = 'DEVELOPING'
        label = 'Setup building â monitor'
        size  = '50-75%'
        color = 'YEL'
    elif total >= 3:
        tier  = 'WEAK'
        label = 'Below threshold â paper trade'
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


def print_signal(sig: ClassifierSignal, verbose: bool = True):
    sc = SIG_COLOR.get(sig.signal,'')
    gc = GRADE_COLOR.get(sig.grade,'')
    tc = GRN if sig.tier=='HIGH' else YEL if sig.tier in ('MEDIUM','LOW') else DIM
    vc = (GRN if sig.velocity in ('RISING_FAST','RISING') else
          RED if sig.velocity in ('FALLING','FALLING_FAST') else DIM)
    zc = GRN if sig.entry_zone == 'ZONE_A' else RED if sig.entry_zone == 'DEAD_ZONE' else YEL
    pvwap_c = RED if sig.price_vs_vwap > 0 else GRN
    traj_c  = GRN if sig.score_trajectory=='RISING' else RED if sig.score_trajectory=='FALLING' else DIM

    W = 68
    print(f"\n  {'â'*W}")
    # Header
    print(f"  {BOLD}{sig.ticker:8}{RESET}  ${sig.price:.3f}  "
          f"{sc}{BOLD}{sig.signal:12}{RESET}  [{gc}Grade {sig.grade}{RESET}]  "
          f"Q={sig.quality_score}/100  @{sig.timestamp}  {DIM}v3{RESET}")
    print(f"  {'â'*W}")

    # Row 1: Regime + tier + score + section
    print(f"  Regime:  {sig.regime:22}  "
          f"Tier:{tc}{sig.tier:7}{RESET}  "
          f"Score:{sig.score:>4}  "
          f"Section:{sig.section}({sig.confidence}%)")

    # Row 2: Price structure
    vwap_diff = f"{pvwap_c}{sig.price_vs_vwap:+.1f}%{RESET}"
    print(f"  VWAP:   ${sig.vwap:.3f} ({vwap_diff} from VWAP)  "
          f"ATR:${sig.atr:.3f}  "
          f"VolSpike:{sig.vol_spike:.1f}x")

    # Row 3: HOD/LOD
    print(f"  HOD:    ${sig.hod:.3f} @{sig.hod_time} ({sig.hod_bars_ago} bars ago)  "
          f"LOD:${sig.lod:.3f} @{sig.lod_time}")
    print(f"  Entry:  {zc}{sig.pct_from_hod:+.1f}% from HOD â Zone:{sig.entry_zone}{RESET}  "
          f"Suggested size:{GRN}{sig.suggested_size}{RESET}")

    # Row 4: S1/S2 state
    consec_c = GRN if sig.consec_s1 >= 10 else YEL if sig.consec_s1 >= 3 else RED
    print(f"  S1/S2:  Consec S1 bars:{consec_c}{sig.consec_s1:>3}{RESET}  "
          f"S1% of RTH:{sig.s1_pct:.0f}%  "
          f"RTH progress:{sig.session_pct:.0f}%  "
          f"Bars:{sig.rth_bars}/{sig.pm_bars}pm")

    # Row 5: Momentum
    fc = GRN if sig.flips_rth <= 3 else YEL if sig.flips_rth <= 6 else RED
    cc = GRN if sig.chop < 40 else YEL if sig.chop < 70 else RED
    # Score delta and lean display
    _sd   = getattr(sig, 'score_delta_pre', 0)
    _lean = getattr(sig, 'margin_lean', 0.0)
    _sd_c = GRN if _sd >= 3 else (RED if _sd <= -3 else DIM)
    _ln_c = GRN if _lean > 3 else (YEL if _lean > 0 else DIM)
    print(f"  Momentum: {vc}Velocity:{sig.velocity:12}{RESET}  "
          f"Flips:{fc}{sig.flips_rth:>3}{RESET}  "
          f"Chop:{cc}{sig.chop:.0f}%{RESET}  "
          f"Traj:{traj_c}{sig.score_trajectory}({_sd_c}Î{_sd:+d}{RESET})  "
          f"Lean:{_ln_c}{_lean:+.1f}{RESET}")

    # Row 6: PM stats
    pm_c = RED if sig.pm_move_pct > 30 else YEL if sig.pm_move_pct > 15 else DIM
    print(f"  PM:     Move:{pm_c}{sig.pm_move_pct:+.1f}%{RESET}  "
          f"PM High:${sig.pm_high:.3f}  "
          f"Gap:{sig.gap_pct:+.1f}%  "
          f"PM Open:${sig.pm_open_price:.3f}")

    # Row 7 (v3): Data-heist features
    qd_c  = GRN if sig.quiet_dump_proxy else DIM
    vav_c = RED if sig.vol_above_vwap_pct > 80 else (
            YEL if sig.vol_above_vwap_pct > 60 else GRN)
    ft_c  = RED if 0 < sig.float_turnover_pct < 10 else (
            GRN if sig.float_turnover_pct >= 50 else YEL)
    hod_c = RED if sig.hod_set_pct > 60 else (
            GRN if sig.hod_set_pct < 30 else YEL)
    print(f"  v3:     QuietDump:{qd_c}{'YES' if sig.quiet_dump_proxy else 'no':4}{RESET}  "
          f"GainBucket:{sig.intraday_gain_bucket:10}  "
          f"VolAboveVWAP:{vav_c}{sig.vol_above_vwap_pct:.0f}%{RESET}")
    # Gap-fill display values
    _nm   = getattr(sig, 'near_miss_count', 0)
    _rd   = getattr(sig, 'run_day', 0)
    _ppe  = getattr(sig, 'price_path_efficiency', 0.0)
    _con  = getattr(sig, 'contested_day', False)
    _nm_c = GRN if 5 <= _nm <= 14 else (YEL if _nm > 0 else DIM)
    _rd_c = GRN if _rd == 1 else (YEL if _rd == 2 else RED)
    _ppe_c= GRN if _ppe < 0.4 else (YEL if _ppe < 0.7 else DIM)
    print(f"          HOD@:{hod_c}{sig.hod_set_pct:.0f}%{RESET} elapsed  "
          f"SessionLow:{sig.session_low_vs_pm_open:.0f}% below open  "
          f"FloatTurn:{ft_c}{sig.float_turnover_pct:.1f}%{RESET}  "
          f"EntryC:{'â' if sig.entry_c_fired else 'â'}")
    _rd_str = f"D{_rd}" if _rd > 0 else "D?"
    _con_str = f"{YEL}CONTESTED{RESET}" if _con else "clean"
    print(f"          NM:{_nm_c}{_nm:>3} near-misses{RESET}  "
          f"RunDay:{_rd_c}{_rd_str}{RESET}  "
          f"PathEff:{_ppe_c}{_ppe:.2f}{RESET}  "
          f"Session:{_con_str}")

    # Row 8: Expected outcome
    print(f"  Expect: ret={sig.expected_ret}  "
          f"MAE={sig.expected_mae}  "
          f"Stop={sig.stop_pct}  "
          f"Strategy:{sig.strategy}")

    # Signals
    q = [s for s in sig.active_signals if s in ALL_Q]
    v3sigs = [s for s in sig.active_signals if s in V3_SIGNALS]
    non_q = [s for s in sig.all_signals if s not in ALL_Q
             and s not in q and s not in V3_SIGNALS][:3]
    if q or v3sigs:
        print(f"  {'â'*W}")
        if q:
            print(f"  Signals:  {GRN}{' | '.join(q[:5])}{RESET}")
        if v3sigs:
            print(f"  v3 Sigs:  {CYN}{' | '.join(v3sigs)}{RESET}")
        if non_q:
            print(f"  Also:     {DIM}{' | '.join(non_q)}{RESET}")
    if sig.power_combo:
        print(f"  {GRN}Power combo: {sig.power_combo}  (lift {sig.power_lift:.1f}){RESET}")

    # v3 gate notes
    if verbose and sig.v3_gate_notes:
        print(f"  {'â'*W}")
        _notes_display = list(sig.v3_gate_notes)
        _rd_v = getattr(sig, 'run_day', 0)
        if _rd_v >= 2: _notes_display.append(f"RUN_DAY_D{_rd_v} {_RUN_DAY_SCORE_ADJ.get(_rd_v, -12):+d}pts")
        _nm_v = getattr(sig, 'near_miss_count', 0)
        if 5 <= _nm_v <= 14: _notes_display.append(f"NM_5_14({_nm_v}) +4pts")
        print(f"  {CYN}v3 score adj: {' | '.join(_notes_display)}{RESET}")

    # SEC filing row
    if sig.sec_available:
        sec_sigs = [s for s in ['424B5_ACTIVE','SERIAL_HEAVY',
                                 'PRIOR3_DILUTION','SUPPLY_OVERHANG','LATE_PHASE']
                    if s in sig.active_signals]
        d424_str = f"{sig.sec_days_424b5}d ago" if sig.sec_days_424b5 else "none"
        regime_flag = f" {GRN}â DILUTION_DUMP overridden{RESET}" if sig.sec_regime_changed else ""
        print(f"  {GRN}SEC:      424B5:{d424_str}  "
              f"offerings_12m:{sig.sec_offerings_12m}  "
              f"+{sig.sec_score_boost}pts{regime_flag}{RESET}")
        if sec_sigs:
            print(f"  {GRN}          {' | '.join(sec_sigs)}{RESET}")
    else:
        print(f"  {DIM}SEC:      unavailable (no EDGAR data for this ticker){RESET}")

    # Gate summary
    print(f"  {'â'*W}")
    all_pass = sig.gates_passed == 5
    gate_col = GRN if all_pass else YEL if sig.gates_passed >= 3 else RED
    print(f"  {gate_col}Gates:  {sig.gates_passed}/5 passed  |  "
          f"Bias: {sig.bias}  |  "
          f"Conf: {sig.confidence_norm:.2f}{RESET}")
    if sig.disqualifiers:
        print(f"  {RED}DQ:     {' | '.join(sig.disqualifiers)}{RESET}")
    if verbose and sig.gate_detail:
        for g in sig.gate_detail:
            ok = 'PASS' in g
            print(f"  {'  ' + GRN + 'â' if ok else '  ' + RED + 'â'}{RESET} {g}")

    # Next watch
    print(f"  {'â'*W}")
    print(f"  {CYN}Watch:  {sig.next_watch}{RESET}")

    if verbose and sig.reasons:
        print(f"  {DIM}Why: {' | '.join(sig.reasons[:3])}{RESET}")
    if sig.warnings:
        print(f"  {YEL}â  {' | '.join(sig.warnings)}{RESET}")

    # ââ Tick features (from v4 layer, if available) ââââââââââââââââââââââââââ
    _tf = getattr(sig, '_tick_features', None)
    if _tf is not None and getattr(_tf, 'ticks_available', False):
        from cat5ive_classifier_v4 import print_tick_features as _ptf
        _ptf(_tf)

    # ââ Gate Round Up (GRU) â unified conviction index âââââââââââââââââââââ
    gru = compute_gate_roundup(sig, _tf)
    wc  = gru['wc']
    bp  = gru['bp']
    con = gru['concepts']

    # ââ GRU summary row ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    gru_total = gru['total']
    gru_max   = gru['max']
    gru_tier  = gru['tier']
    gru_col   = (GRN+BOLD if gru_tier == 'EXCEPTIONAL' else
                 GRN      if gru_tier == 'HIGH'         else
                 YEL      if gru_tier == 'DEVELOPING'   else
                 RED      if gru_tier == 'WEAK'         else DIM)
    print(f"  {'â'*W}")
    print(f"  {gru_col}â GATE ROUND UP: {gru_total}/{gru_max}  "
          f"[WC:{gru['wc_score']}/7  BP:{gru['bp_score']}/5  "
          f"CONCEPTS:{gru['concepts_score']}/5]  "
          f"{gru_tier}  {gru['label']}{RESET}")
    print(f"  {gru_col}  Suggested size: {gru['suggested_size']}{RESET}")
    # GRU SKIP = confirmed no-trade (A=+6.1% LOSING, n=33)
    if gru_tier == 'SKIP':
        print(f"  {RED}{BOLD}  â GRU SKIP: A=+6.1% LOSING (n=33 confirmed). No A or E trade.{RESET}")
    elif gru_tier == 'DEVELOPING':
        print(f"  {GRN}  DEVELOPING: A=â17.8%, E=â29.8% Â· 80% A win rate (n=64 â validated){RESET}")
    elif gru_tier == 'HIGH':
        print(f"  {GRN}{BOLD}  HIGH: A=â17.3%, E=â33.0% Â· 88% A win rate (n=9 â ){RESET}")
    # Exit timing from return curve
    _bp_active = gru['bp_score'] >= 4
    if _bp_active:
        print(f"  {MAG}  Exit: hold E 150+ min (BLUEPR8NT MFE avg â47.1%). Trail stop.{RESET}")
    elif gru_tier in ('HIGH', 'EXCEPTIONAL', 'DEVELOPING'):
        print(f"  {CYN}  Exit: cover A at 60-90min Â· hold E to 90-120min{RESET}")
    # NC regime size note
    if sig.regime == 'NEWS_CONTINUATION':
        print(f"  {YEL}  NC regime: A edge thin (A=â3.3%). Apply â25% A size.{RESET}")

    wc_score = wc['score']
    wc_tier  = wc['tier']
    wc_col   = (GRN+BOLD if wc_tier == 'WINNERS_CIRCLE' else
                GRN      if wc_tier == 'QUALIFYING'      else
                YEL      if wc_tier == 'DEVELOPING'      else DIM)

    gate_icons = {
        'EARLY_HOD':  'HOD',  'VWAP_DUMP': 'VWAP', 'QUIET_DUMP': 'QD',
        'SMALL_GAIN': 'GAIN', 'HIGH_CONF':  'CONF', 'ZONE_A':     'ZONE',
        'DEEP_LOD':   'LOD',
    }
    wc_parts = []
    for gk, gv in wc['gates'].items():
        icon = gate_icons.get(gk, gk)
        wc_parts.append(f"{GRN if gv else RED}{icon}{'â' if gv else 'â'}{RESET}")

    print(f"  {'â'*W}")
    print(f"  {wc_col}â WINNERS CIRCLE: {wc_score}/{wc['total']} gates  "
          f"[{' '.join(wc_parts)}]{RESET}")
    if wc_tier in ('WINNERS_CIRCLE', 'QUALIFYING'):
        print(f"  {wc_col}  Expected A: {wc['exp_a']}   E: {wc['exp_e']}{RESET}")
    elif wc_score <= 1:
        print(f"  {RED}{BOLD}  â WC 0-1: A=+12.0% LOSING (n=33 confirmed). No A trade.{RESET}")
    # MEDIUM tier A restriction
    if sig.tier == 'MEDIUM' and wc_score < 4:
        print(f"  {YEL}  â  MEDIUM + WC<4: A=+0.3% avg. E-only recommended.{RESET}")

    # ââ BLUEPR8NT evaluation âââââââââââââââââââââââââââââââââââââââââââââââ
    bp_score = bp['score']
    bp_tier  = bp['tier']
    bp_col   = (MAG+BOLD if bp_tier == 'BLUEPR8NT'           else
                MAG      if bp_tier == 'BLUEPR8NT_CANDIDATE' else
                YEL      if bp_tier == 'BP_WATCH'            else DIM)

    bp_gate_icons = {
        'DILUTION_DUMP': 'DIL', 'HIGH_SCORE':  'SCR',
        'QUIET_DUMP':    'QD',  'HIGH_CONF':   'CONF',
        'DILUTION_CONF': 'SEC',
    }
    bp_parts = []
    for gk, gv in bp['gates'].items():
        icon = bp_gate_icons.get(gk, gk)
        bp_parts.append(f"{GRN if gv else RED}{icon}{'â' if gv else 'â'}{RESET}")

    print(f"  {bp_col}â¡ BLUEPR8NT: {bp_score}/{bp['total']} gates  "
          f"[{' '.join(bp_parts)}]{RESET}")
    if bp_tier in ('BLUEPR8NT', 'BLUEPR8NT_CANDIDATE'):
        print(f"  {bp_col}  Dataset: A {bp['bp_avg_a']} / E {bp['bp_avg_e']}  "
              f"MFE {bp['bp_mfe_e']}   vs rest A {bp['rest_avg_a']} / E {bp['rest_avg_e']}{RESET}")
        # MAE advantage: BP E MAE +14.3% vs +21.1% rest â tighter stops valid (guidelines v3)
        print(f"  {bp_col}  MAE: +14.3% (vs +21.1% non-BP) â tighter stops valid{RESET}")
        print(f"  {bp_col}  Hold: E 150+ min Â· trail stop Â· target MFE â47.1%{RESET}")
        if bp['note']:
            print(f"  {bp_col}  â {bp['note']}{RESET}")
    elif bp_tier == 'BP_WATCH':
        print(f"  {bp_col}  â {bp['note']}{RESET}")

    # ââ Concepts Score âââââââââââââââââââââââââââââââââââââââââââââââââââââ
    con_score = con['score']
    con_tier  = con['tier']
    con_col   = (GRN+BOLD if con_tier == 'ELITE'   else
                 GRN      if con_tier == 'STRONG'  else
                 YEL      if con_tier == 'SOLID'   else
                 YEL      if con_tier == 'PARTIAL' else DIM)

    con_gate_icons = {
        'REGIME_CONFIRMED': 'REG', 'SIGNAL_TIER1':  'T1',
        'POWER_COMBO':      'PWR', 'SEC_DEPTH':     'SEC',
        'TICK_CONFIRM':     'TICK',
    }
    con_parts = []
    for gk, gv in con['gates'].items():
        icon = con_gate_icons.get(gk, gk)
        con_parts.append(f"{GRN if gv else RED}{icon}{'â' if gv else 'â'}{RESET}")

    print(f"  {con_col}â¬¡ CONCEPTS: {con_score}/{con['total']} gates  "
          f"[{' '.join(con_parts)}]  {con_tier}{RESET}")
    if con['label'] and con_tier in ('ELITE', 'STRONG', 'SOLID'):
        print(f"  {con_col}  â {con['label']}{RESET}")

    print(f"  {'â'*W}")


def log_signal(sig: ClassifierSignal, log_dir: str):
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, f"classifier_{date.today().isoformat()}.jsonl")
    with open(path,'a') as f:
        f.write(json.dumps(asdict(sig)) + '\n')


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SECTION 7 â KEY LOADING & CLI
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def load_keys(config_path: str = None) -> tuple:
    """Load API keys: env vars â config.json. Returns (tradier, polygon, fmp)."""
    tradier = os.environ.get('TRADIER_API_KEY','')
    polygon = os.environ.get('POLYGON_API_KEY','')
    fmp     = os.environ.get('FMP_API_KEY','')

    if config_path and os.path.exists(config_path):
        try:
            with open(config_path) as f:
                cfg = json.load(f)
            tradier = tradier or cfg.get('tradier_key','')
            polygon = polygon or cfg.get('polygon_key','')
            fmp     = fmp     or cfg.get('fmp_key','')
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
                    tradier = tradier or cfg.get('tradier_key','')
                    polygon = polygon or cfg.get('polygon_key','')
                    fmp     = fmp     or cfg.get('fmp_key','')
                    break
                except Exception:
                    pass

    return tradier, polygon, fmp


def main():
    p = argparse.ArgumentParser(
        description='Cat5ive Standalone Real-Time Classifier v3.0')
    p.add_argument('tickers', nargs='+')
    p.add_argument('--date',      default=None,
                   help='YYYY-MM-DD (default: today)')
    p.add_argument('--no-sec',    action='store_true',
                   help='Disable SEC EDGAR filing lookup')
    p.add_argument('--time',      default=None,
                   help='HH:MM â stop analysis at this bar (snapshot mode)')
    p.add_argument('--interval',  type=int, default=90)
    p.add_argument('--once',      action='store_true')
    p.add_argument('--json',      action='store_true')
    p.add_argument('--quiet',     action='store_true')
    p.add_argument('--high-value-only', action='store_true')
    p.add_argument('--min-quality',     type=int, default=0)
    p.add_argument('--config',    default=None,
                   help='Path to config.json with tradier_key/polygon_key/fmp_key')
    p.add_argument('--log-dir',   default=None)
    p.add_argument('--no-float',  action='store_true',
                   help='Skip float fetch (faster startup, disables float_turnover gate)')

    args    = p.parse_args()
    tickers = [t.upper() for t in args.tickers]
    tradier_key, polygon_key, fmp_key = load_keys(args.config)
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
        src = 'Tradier' if tradier_key else 'Polygon' if polygon_key else 'yfinance'
        print(f"  Source:   {src}  FMP:{'yes' if fmp_key else 'no'}")
        print(f"  Interval: {args.interval}s  Mode: {'once' if args.once else 'continuous'}")
        print(f"  Logs:     {log_dir}")
        print(f"{BOLD}{'='*64}{RESET}\n")

        if not tradier_key and not polygon_key and not HAS_YF:
            print(f"{RED}ERROR: No API keys found and yfinance not installed.")
            print(f"  setx TRADIER_API_KEY  \"your_key\"")
            print(f"  setx POLYGON_API_KEY  \"your_key\"")
            print(f"  OR: pip install yfinance  (slow fallback){RESET}")
            sys.exit(1)

    # ââ Prefetch float shares (once per ticker, session-cached) âââââââââââââââ
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
                    print(f"  {DIM}Outside 4am-8pm ET â sleeping{RESET}")
                if args.once: break
                time.sleep(args.interval)
                continue

            signals_this_poll = []
            for tkr in tickers:
                try:
                    if not args.json:
                        print(f"  {tkr:8} {DIM}fetching...{RESET}", end='\r', flush=True)

                    bars = get_bars(tkr, session_date, tradier_key, polygon_key)

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
                                             float_shares=fs)
                    log_signal(sig, log_dir)

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
