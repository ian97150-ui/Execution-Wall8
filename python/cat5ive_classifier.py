#!/usr/bin/env python3
"""
cat5ive_classifier.py — Standalone Real-Time Trade Classifier
==============================================================
ZERO DEPENDENCIES on cat5ive_sim.py or any other local file.
Single self-contained file. Copy anywhere. Run anywhere.

Fetches live 1-minute bars directly from Tradier → Polygon → yfinance
Computes signals, S1/S2 classification, scoring, and alert grading
from raw bar data only.

SETUP (one time):
  setx TRADIER_API_KEY  "your_production_key"
  setx POLYGON_API_KEY  "your_polygon_key"

  OR create config.json anywhere and pass with --config:
  {
    "tradier_key": "...",
    "polygon_key": "..."
  }

USAGE:
  python cat5ive_classifier.py LABT
  python cat5ive_classifier.py LABT SCNI IQST --high-value-only
  python cat5ive_classifier.py LABT --json --once
  python cat5ive_classifier.py LABT --date 2026-04-24 --once
  python cat5ive_classifier.py LABT --interval 60 --min-quality 60
  python cat5ive_classifier.py LABT --config C:\\keys\\config.json

APP INTEGRATION (subprocess):
  import subprocess, json
  out = subprocess.run(
      ['python', 'cat5ive_classifier.py', 'LABT', '--json', '--once'],
      capture_output=True, text=True)
  signal = json.loads(out.stdout.strip())
  # signal['signal']        → 'HIGH_VALUE' / 'ENTER_E' / 'WAIT' / 'SKIP'
  # signal['quality_score'] → 0-100
  # signal['grade']         → 'A' / 'B' / 'C'
"""

import os, sys, time, json, argparse, math
from datetime import datetime, date, timedelta
from dataclasses import dataclass, asdict
from typing import Optional, List

# ── Optional imports (graceful fallback) ─────────────────────────────────────
try:    import requests;    HAS_REQUESTS = True
except: HAS_REQUESTS = False

try:    import yfinance as yf; HAS_YF = True
except: HAS_YF = False

# ── Terminal colours ──────────────────────────────────────────────────────────
BOLD='\033[1m'; RESET='\033[0m'; GRN='\033[92m'; YEL='\033[93m'
RED='\033[91m'; CYN='\033[96m'; MAG='\033[95m'; DIM='\033[2m'

# ── Signal definitions (guidelines v2.0) ─────────────────────────────────────
TIER_1 = {'SUPPLY_OVERHANG','AH_REVERSAL_TRAP','LIVE_STRENGTH',
           'DAY3_EXHAUSTION','LATE_PHASE','MEAN_REVERSION_GAP'}
TIER_2 = {'PM_SELL_PRESSURE','OVEREXTENDED_AH_S2','PM_FADE_CONFIRMED',
           '424B5_ACTIVE','PM_FADE_MOVE'}
TIER_3 = {'VWAP_FAIL_S1','DILUTION_DUMP_SIGNAL','SERIAL_HEAVY',
           'OVEREXTENDED_OPEN','HIGH_VOL_REJECTION'}
ALL_Q  = TIER_1 | TIER_2 | TIER_3

POWER_COMBOS = [
    ({'PM_SELL_PRESSURE','VWAP_FAIL_S1'},        19.44, 'PM_SELL+VWAP'),
    ({'SUPPLY_OVERHANG','VWAP_FAIL_S1'},         14.21, 'SUPPLY+VWAP'),
    ({'PM_FADE_CONFIRMED','SUPPLY_OVERHANG'},      9.14, 'FADE+SUPPLY'),
    ({'PM_SELL_PRESSURE','PM_FADE_CONFIRMED'},     8.20, 'PM_SELL+FADE'),
    ({'OVEREXTENDED_AH_S2','VWAP_FAIL_S1'},      12.80, 'OVEREXT+VWAP'),
]

EXPECTED = {
    ('DILUTION_DUMP',       'E'): ('+20%','-21%','+25%'),
    ('NEWS_CONTINUATION',   'E'): ('+21%','-17%','+22%'),
    ('LOW_FLOAT_PARABOLIC', 'A'): ('+12%','-21%','+18%'),
    ('UNKNOWN',             'E'): ('+22%','-18%','+25%'),
}

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BAR DATA FETCHING
# ═══════════════════════════════════════════════════════════════════════════════

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
    """Fetch bars — Tradier → Polygon → yfinance."""
    bars = fetch_tradier(ticker, date_str, tradier_key)
    if bars: return bars
    bars = fetch_polygon(ticker, date_str, polygon_key)
    if bars: return bars
    return fetch_yfinance(ticker, date_str)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — TECHNICAL INDICATORS
# ═══════════════════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — SIGNAL DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

def detect_signals(bars: List[Bar], vwaps: List[float]) -> dict:
    """
    Detect Cat5ive signals from raw bar data.
    Returns dict of {signal_name: True/False}.
    """
    if not bars: return {}

    rth   = [b for b in bars if b.session == 'RTH']
    pm    = [b for b in bars if b.session == 'PM']
    all_b = bars

    price    = bars[-1].close
    pm_high, pm_low, pm_last, pm_move = pm_stats(bars)
    hod, hod_idx, lod, lod_idx = hod_lod(all_b)
    atr      = compute_atr(bars)

    # Current VWAP
    cur_vwap = vwaps[-1] if vwaps else price

    # Gap from prior close (approximate — use PM open)
    prior_close = pm[0].open if pm and pm[0].open > 0 else price
    gap_pct     = round((prior_close - price) / price * 100, 2) if price > 0 else 0

    signals = {}

    # ── VWAP_FAIL_S1 ──────────────────────────────────────────────────────
    # Stock trading below VWAP AND failing to reclaim it
    below_vwap = price < cur_vwap
    if rth and len(rth) >= 5:
        recent_closes = [b.close for b in rth[-5:]]
        all_below = all(c < v for c, v in zip(recent_closes, vwaps[-5:]))
        signals['VWAP_FAIL_S1'] = below_vwap and all_below
    else:
        signals['VWAP_FAIL_S1'] = below_vwap

    # ── PM_SELL_PRESSURE ─────────────────────────────────────────────────
    # Pre-market close significantly below PM high
    if pm_high > 0 and pm_last > 0:
        pm_fade = (pm_high - pm_last) / pm_high * 100
        signals['PM_SELL_PRESSURE'] = pm_fade > 8 and pm_move > 20
    else:
        signals['PM_SELL_PRESSURE'] = False

    # ── PM_FADE_CONFIRMED ─────────────────────────────────────────────────
    # PM high was significant and current price is well below it
    if pm_high > 0 and price > 0:
        pct_below_pm_high = (pm_high - price) / pm_high * 100
        signals['PM_FADE_CONFIRMED'] = pct_below_pm_high > 15 and pm_move > 15
    else:
        signals['PM_FADE_CONFIRMED'] = False

    # ── OVEREXTENDED_AH_S2 / OVEREXTENDED_OPEN ───────────────────────────
    # Stock gapped up 30%+ — overextended
    if hod > 0 and prior_close > 0:
        total_run = (hod - prior_close) / prior_close * 100
        signals['OVEREXTENDED_AH_S2'] = total_run > 50
        signals['OVEREXTENDED_OPEN']  = total_run > 30
    else:
        signals['OVEREXTENDED_AH_S2'] = False
        signals['OVEREXTENDED_OPEN']  = False

    # ── SUPPLY_OVERHANG ───────────────────────────────────────────────────
    # HOD formed early and price has been declining for 30+ bars
    if hod_idx < len(bars) * 0.3 and len(bars) > 30:
        bars_since_hod = len(bars) - hod_idx
        price_decline  = (hod - price) / hod * 100 if hod > 0 else 0
        signals['SUPPLY_OVERHANG'] = (bars_since_hod > 30 and
                                      price_decline > 15)
    else:
        signals['SUPPLY_OVERHANG'] = False

    # ── HIGH_VOL_REJECTION ────────────────────────────────────────────────
    # High volume bar near HOD with significant upper wick = sellers active
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

    # ── LIVE_STRENGTH (inverse — strength = bad for short) ───────────────
    # Stock reclaiming VWAP = S2 condition
    signals['LIVE_STRENGTH'] = price > cur_vwap and len(rth) > 10

    # ── MEAN_REVERSION_GAP ────────────────────────────────────────────────
    # Large gap down + price still elevated = mean reversion setup
    if prior_close > 0 and hod > 0:
        gap_up = (hod - prior_close) / prior_close * 100
        signals['MEAN_REVERSION_GAP'] = (gap_up > 40 and
                                          price < hod * 0.80 and
                                          signals['VWAP_FAIL_S1'])
    else:
        signals['MEAN_REVERSION_GAP'] = False

    # ── PM_FADE_MOVE ──────────────────────────────────────────────────────
    # Steady fade in pre-market (not just a spike)
    if len(pm) >= 10:
        pm_closes  = [b.close for b in pm]
        down_moves = sum(1 for i in range(1,len(pm_closes))
                         if pm_closes[i] < pm_closes[i-1])
        signals['PM_FADE_MOVE'] = down_moves > len(pm) * 0.55
    else:
        signals['PM_FADE_MOVE'] = False

    # Return only True signals
    return {k: v for k, v in signals.items() if v}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — S1/S2 CLASSIFICATION
# ═══════════════════════════════════════════════════════════════════════════════

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

    # S1 evidence
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

    # S2 evidence
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


def compute_score(signals: dict, section: str,
                  confidence: int, bars: List[Bar]) -> tuple:
    """
    Compute pre-fall score (0-150) and tier.
    Based on signal count, confidence, and price structure.
    """
    score = 0
    score += confidence // 2           # up to 47 pts from confidence

    # Signal contribution
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
        hod, hod_idx, _, _ = hod_lod(bars)
        if hod_idx < len(bars) * 0.25:
            score += 10

    score = min(150, score)

    if   score >= 50: tier = 'HIGH'
    elif score >= 25: tier = 'MEDIUM'
    elif score >= 10: tier = 'LOW'
    else:             tier = 'SKIP'

    return score, tier


def detect_regime(bars: List[Bar], pm_move: float,
                  signals: dict) -> str:
    """
    Approximate regime from bar data alone.
    Without filing data we can't confirm DILUTION_DUMP precisely —
    but price patterns give strong clues.
    """
    if not bars: return 'UNKNOWN'

    hod, hod_idx, lod, lod_idx = hod_lod(bars)
    price = bars[-1].close
    pm_bars = [b for b in bars if b.session == 'PM']

    # HOD formed in first 20% of session = DILUTION_DUMP pattern
    hod_early = hod_idx < len(bars) * 0.20

    # Large PM move = dilution or news
    big_pm_move = abs(pm_move) > 30

    # Parabolic: very large move (100%+) in short time
    if hod > 0 and bars[0].open > 0:
        total_run = (hod - bars[0].open) / bars[0].open * 100
        if total_run > 100 and len(pm_bars) < 60:
            return 'LOW_FLOAT_PARABOLIC'

    # DILUTION_DUMP: HOD early, fading from PM high, big PM move
    if hod_early and big_pm_move and signals.get('PM_SELL_PRESSURE'):
        return 'DILUTION_DUMP'

    # NEWS_CONTINUATION: big move but HOD later in session
    if big_pm_move and not hod_early:
        return 'NEWS_CONTINUATION'

    # Default
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

    # Compute confidence per bar in window
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


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — CLASSIFICATION ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

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
    # ── Extended fields ───────────────────────────────────────────────────
    pm_bars:        int       # number of pre-market bars
    rth_bars:       int       # number of RTH bars so far
    pm_move_pct:    float     # pre-market % move from open to last PM bar
    pm_high:        float     # pre-market high
    gap_pct:        float     # gap from prior close estimate
    vwap:           float     # current VWAP
    atr:            float     # average true range
    price_vs_vwap:  float     # % above/below VWAP
    hod_time:       str       # time HOD formed
    lod_time:       str       # time LOD formed
    hod_bars_ago:   int       # how many bars ago HOD formed
    consec_s1:      int       # consecutive S1 bars before now
    s1_pct:         float     # % of RTH bars that were S1
    vol_spike:      float     # current bar volume vs 10-bar avg
    session_pct:    float     # how far through the session (0-100%)
    all_signals:    List[str] # ALL signals including non-qualifying
    suggested_size: str       # position size suggestion based on conditions
    next_watch:     str       # what to watch for next


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
    best_lift, best_label = 0.0, ''
    for combo, lift, label in POWER_COMBOS:
        if combo.issubset(s) and lift > best_lift:
            best_lift, best_label = lift, label
    return best_label, best_lift


def entry_zone(pct: float) -> str:
    if pct >= -5:  return 'ZONE_A'
    if pct >= -15: return 'DEAD_ZONE'
    if pct >= -30: return 'ZONE_B'
    return 'ZONE_C'


def calc_quality(sig: ClassifierSignal) -> int:
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
    return min(100, s)


def compute_extended(bars: List[Bar], vwaps: List[float],
                      signals: dict, section: str) -> dict:
    """Compute all extended fields for richer display."""
    if not bars:
        return dict(pm_bars=0, rth_bars=0, pm_move_pct=0.0, pm_high=0.0,
                    gap_pct=0.0, vwap=0.0, atr=0.0, price_vs_vwap=0.0,
                    hod_time='—', lod_time='—', hod_bars_ago=0,
                    consec_s1=0, s1_pct=0.0, vol_spike=0.0,
                    session_pct=0.0, all_signals=[], suggested_size='—',
                    next_watch='—')

    pm_bars_list  = [b for b in bars if b.session == 'PM']
    rth_bars_list = [b for b in bars if b.session == 'RTH']
    pm_b  = len(pm_bars_list)
    rth_b = len(rth_bars_list)

    # PM stats
    pm_high  = max((b.high  for b in pm_bars_list), default=0)
    pm_open  = pm_bars_list[0].open if pm_bars_list else 0
    pm_last  = pm_bars_list[-1].close if pm_bars_list else 0
    pm_move  = round((pm_last - pm_open) / pm_open * 100, 2) if pm_open > 0 else 0

    # Gap estimate (PM open vs prior-close proxy = first bar open)
    first_price = bars[0].open if bars[0].open > 0 else bars[0].close
    gap_pct     = round((first_price - pm_last) / pm_last * 100, 2) if pm_last > 0 else 0

    # VWAP and price vs VWAP
    cur_vwap = vwaps[-1] if vwaps else bars[-1].close
    price    = bars[-1].close
    pvwap    = round((price - cur_vwap) / cur_vwap * 100, 2) if cur_vwap > 0 else 0

    # ATR
    atr = compute_atr(bars, 14)

    # HOD/LOD with time
    hod_v, hod_idx, lod_v, lod_idx = hod_lod(bars)
    hod_time = bars[hod_idx].ts if hod_idx < len(bars) else '—'
    lod_time = bars[lod_idx].ts if lod_idx < len(bars) else '—'
    hod_bars_ago = len(bars) - 1 - hod_idx

    # Consecutive S1 bars
    consec_s1 = 0
    for b, v in zip(reversed(bars), reversed(vwaps)):
        if b.close < v:
            consec_s1 += 1
        else:
            break

    # S1 percentage of RTH
    s1_count = sum(1 for b, v in zip(rth_bars_list, vwaps[-rth_b:])
                   if b.close < v) if rth_b > 0 else 0
    s1_pct   = round(s1_count / rth_b * 100, 1) if rth_b > 0 else 0.0

    # Volume spike vs 10-bar avg
    last_vols = [b.volume for b in bars[-11:-1] if b.volume > 0]
    avg_vol   = sum(last_vols) / len(last_vols) if last_vols else 1
    vol_spike = round(bars[-1].volume / avg_vol, 2) if avg_vol > 0 else 0.0

    # Session progress (RTH is 390 bars = 6.5h)
    rth_max     = 390
    session_pct = round(min(100, rth_b / rth_max * 100), 1)

    # All signals (including non-qualifying)
    all_sigs = list(signals.keys())

    # Suggested size based on conditions
    flips = count_rth_flips(bars, vwaps)
    chop  = compute_chop(bars)
    vel   = classify_velocity(bars, vwaps)
    size  = 100
    if flips > 6:   size -= 30
    if flips > 14:  size -= 10
    if chop > 60:   size -= 20
    if vel in ('FALLING','FALLING_FAST'): size -= 30
    if vel == 'RISING_FAST': size = min(100, size + 10)
    suggested_size = f"{max(25, size)}%"

    # Next watch condition
    ez = entry_zone(round((price - hod_v) / hod_v * 100, 2) if hod_v > 0 else 0)
    if section == 'S2':
        nxt = f"Wait for S1 flip — currently S2 ({consec_s1} bars)"
    elif ez == 'DEAD_ZONE':
        zone_a_px = round(hod_v * 0.95, 3)
        zone_b_px = round(hod_v * 0.85, 3)
        nxt = f"Exit dead zone — need price > ${zone_a_px} (Zone A) or < ${zone_b_px} (Zone B)"
    elif chop >= 80:
        nxt = f"Wait for chop to drop below 80% (currently {chop:.0f}%)"
    elif vel in ('FALLING','FALLING_FAST'):
        nxt = f"Confidence falling — wait for stabilisation or pivot"
    elif flips > 6 and flips <= 14:
        nxt = f"Many flips ({flips}) — reduce size, confirm direction"
    elif not set(all_sigs) & ALL_Q:
        nxt = "Wait for qualifying signal (VWAP_FAIL_S1, PM_SELL_PRESSURE, etc)"
    else:
        nxt = f"Setup valid — monitor S1 persistence ({consec_s1} consec bars)"

    return dict(
        pm_bars=pm_b, rth_bars=rth_b, pm_move_pct=pm_move, pm_high=pm_high,
        gap_pct=gap_pct, vwap=cur_vwap, atr=atr, price_vs_vwap=pvwap,
        hod_time=hod_time, lod_time=lod_time, hod_bars_ago=hod_bars_ago,
        consec_s1=consec_s1, s1_pct=s1_pct, vol_spike=vol_spike,
        session_pct=session_pct, all_signals=all_sigs,
        suggested_size=suggested_size, next_watch=nxt,
    )


def run_classification(ticker: str, bars: List[Bar]) -> ClassifierSignal:
    now_str = datetime.now().strftime('%H:%M:%S')
    reasons = []
    warnings = []

    if not bars:
        return ClassifierSignal(
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
        )

    # Compute indicators
    vwaps      = compute_vwap(bars)
    signals    = detect_signals(bars, vwaps)
    section, conf = classify_section(bars, vwaps, signals)
    score, tier   = compute_score(signals, section, conf, bars)

    _, _, pm_last, pm_move = pm_stats(bars)
    regime     = detect_regime(bars, pm_move, signals)
    flips      = count_rth_flips(bars, vwaps)
    chop       = compute_chop(bars)
    velocity   = classify_velocity(bars, vwaps)

    hod_v, hod_idx, lod_v, _ = hod_lod(bars)
    price      = bars[-1].close
    pct_hod    = round((price - hod_v) / hod_v * 100, 2) if hod_v > 0 else 0
    ez         = entry_zone(pct_hod)

    active_sigs   = list(signals.keys())
    sig_tier      = get_signal_tier(active_sigs)
    pwr_combo, pwr_lift = get_power_combo(active_sigs)
    has_sigs      = bool(set(active_sigs) & ALL_Q)
    strategy      = 'A' if regime == 'LOW_FLOAT_PARABOLIC' else 'E'
    exp_mae, exp_ret, stop = EXPECTED.get(
        (regime, strategy), ('+22%','-18%','+25%'))

    # ── LONG OPPORTUNITY ──────────────────────────────────────────────────
    if section == 'S2' and pct_hod <= -20 and regime != 'UNKNOWN':
        ext = compute_extended(bars, vwaps, signals, section)
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
        )
        sig.quality_score = calc_quality(sig)
        return sig

    # ── Build reasons / warnings ──────────────────────────────────────────
    if section == 'S1':
        reasons.append(f"S1 confirmed  (confidence {conf}%)")
    else:
        warnings.append(f"Section = S2 — no short signal yet")

    q_sigs = [s for s in active_sigs if s in ALL_Q]
    if q_sigs:
        reasons.append(f"{sig_tier}: {' | '.join(q_sigs[:4])}")
    else:
        warnings.append("No qualifying signals yet")

    if pwr_combo:
        reasons.append(f"Power combo: {pwr_combo} (lift {pwr_lift:.1f})")
    if velocity in ('RISING_FAST','RISING'):
        reasons.append(f"Confidence {velocity} → high-value indicator")
    elif velocity in ('FALLING','FALLING_FAST'):
        warnings.append(f"Confidence {velocity} → reduce size 30%")
    if flips == 0:
        reasons.append("0 RTH flips — freshest S1 (92.9% win)")
    elif flips <= 3:
        reasons.append(f"{flips} RTH flips — clean setup")
    elif flips > 6:
        warnings.append(f"{flips} RTH flips — reduce size 30%")
    if chop >= 80:
        warnings.append(f"Chop {chop:.0f}% ≥ 80% — DANGER")
    if ez == 'DEAD_ZONE':
        warnings.append(f"{pct_hod:.1f}% below HOD — dead zone, wait")
    elif ez == 'ZONE_A':
        reasons.append(f"Within 5% of HOD — prime entry zone (90% win)")

    now_h = datetime.now().hour
    if 7 <= now_h < 8:
        warnings.append("07-08am window — highest E MAE (+65.9%)")

    # ── Grade determination ───────────────────────────────────────────────
    hard_skip = chop >= 80 or section != 'S1' or not has_sigs or ez == 'DEAD_ZONE'

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
            velocity not in ('FALLING','FALLING_FAST')
        )
        if grade_a:
            out_signal = 'HIGH_VALUE'
            out_grade  = 'A'
            reasons.append("GRADE A — all prime conditions met")
        else:
            out_signal = f'ENTER_{strategy}'
            out_grade  = 'B'
            reasons.append("GRADE B — standard qualifying entry")

    ext = compute_extended(bars, vwaps, signals, section)
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
    )
    sig.quality_score = calc_quality(sig)
    return sig


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — OUTPUT & LOGGING
# ═══════════════════════════════════════════════════════════════════════════════

def print_signal(sig: ClassifierSignal, verbose: bool = True):
    sc = SIG_COLOR.get(sig.signal,'')
    gc = GRADE_COLOR.get(sig.grade,'')
    tc = GRN if sig.tier=='HIGH' else YEL if sig.tier in ('MEDIUM','LOW') else DIM
    vc = (GRN if sig.velocity in ('RISING_FAST','RISING') else
          RED if sig.velocity in ('FALLING','FALLING_FAST') else DIM)
    zc = GRN if sig.entry_zone == 'ZONE_A' else RED if sig.entry_zone == 'DEAD_ZONE' else YEL
    pvwap_c = RED if sig.price_vs_vwap > 0 else GRN

    W = 66
    print(f"\n  {'═'*W}")
    # Header
    print(f"  {BOLD}{sig.ticker:8}{RESET}  ${sig.price:.3f}  "
          f"{sc}{BOLD}{sig.signal:12}{RESET}  [{gc}Grade {sig.grade}{RESET}]  "
          f"Q={sig.quality_score}/100  @{sig.timestamp}")
    print(f"  {'─'*W}")

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
    print(f"  Entry:  {zc}{sig.pct_from_hod:+.1f}% from HOD → Zone:{sig.entry_zone}{RESET}  "
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
    print(f"  Momentum: {vc}Velocity:{sig.velocity:12}{RESET}  "
          f"Flips:{fc}{sig.flips_rth:>3}{RESET}  "
          f"Chop:{cc}{sig.chop:.0f}%{RESET}")

    # Row 6: PM stats
    pm_c = RED if sig.pm_move_pct > 30 else YEL if sig.pm_move_pct > 15 else DIM
    print(f"  PM:     Move:{pm_c}{sig.pm_move_pct:+.1f}%{RESET}  "
          f"PM High:${sig.pm_high:.3f}  "
          f"Gap:{sig.gap_pct:+.1f}%")

    # Row 7: Expected outcome
    print(f"  Expect: ret={sig.expected_ret}  "
          f"MAE={sig.expected_mae}  "
          f"Stop={sig.stop_pct}  "
          f"Strategy:{sig.strategy}")

    # Signals
    q = [s for s in sig.active_signals if s in ALL_Q]
    non_q = [s for s in sig.all_signals if s not in ALL_Q and s not in q][:3]
    if q:
        print(f"  {'─'*W}")
        print(f"  Signals:  {GRN}{' | '.join(q[:5])}{RESET}")
        if non_q:
            print(f"  Also:     {DIM}{' | '.join(non_q)}{RESET}")
    if sig.power_combo:
        print(f"  {GRN}Power combo: {sig.power_combo}  (lift {sig.power_lift:.1f}){RESET}")

    # Next watch
    print(f"  {'─'*W}")
    print(f"  {CYN}Watch:  {sig.next_watch}{RESET}")

    if verbose and sig.reasons:
        print(f"  {DIM}Why: {' | '.join(sig.reasons[:3])}{RESET}")
    if sig.warnings:
        print(f"  {YEL}⚠ {' | '.join(sig.warnings)}{RESET}")
    print(f"  {'═'*W}")


def log_signal(sig: ClassifierSignal, log_dir: str):
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, f"classifier_{date.today().isoformat()}.jsonl")
    with open(path,'a') as f:
        f.write(json.dumps(asdict(sig)) + '\n')


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — KEY LOADING & CLI
# ═══════════════════════════════════════════════════════════════════════════════

def load_keys(config_path: str = None) -> tuple:
    """Returns (tradier_key, polygon_key)."""
    tradier = (os.environ.get('TRADIER_API_KEY','') or
               os.environ.get('TRADIER_KEY',''))
    polygon = (os.environ.get('POLYGON_API_KEY','') or
               os.environ.get('POLYGON_KEY',''))

    # config.json (explicit)
    if config_path and os.path.isfile(config_path):
        with open(config_path) as f:
            cfg = json.load(f)
        tradier = tradier or cfg.get('tradier_key','')
        polygon = polygon or cfg.get('polygon_key','')

    # config.txt (same folder as this script)
    cfg_txt = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.txt')
    if os.path.isfile(cfg_txt) and not tradier and not polygon:
        with open(cfg_txt) as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith('#'):
                    val = s.split('=',1)[-1].strip() if '=' in s else s
                    if not polygon: polygon = val
                    break

    return tradier.strip(), polygon.strip()


def main():
    p = argparse.ArgumentParser(
        description='Cat5ive Standalone Real-Time Classifier v2.0')
    p.add_argument('tickers', nargs='+')
    p.add_argument('--date',      default=None,
                   help='YYYY-MM-DD (default: today)')
    p.add_argument('--interval',  type=int, default=90)
    p.add_argument('--once',      action='store_true')
    p.add_argument('--json',      action='store_true')
    p.add_argument('--quiet',     action='store_true')
    p.add_argument('--high-value-only', action='store_true')
    p.add_argument('--min-quality',     type=int, default=0)
    p.add_argument('--config',    default=None,
                   help='Path to config.json with tradier_key/polygon_key')
    p.add_argument('--log-dir',   default=None)

    args    = p.parse_args()
    tickers = [t.upper() for t in args.tickers]
    tradier_key, polygon_key = load_keys(args.config)
    session_date = args.date or date.today().isoformat()
    log_dir = args.log_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'classifier_logs')

    if not args.json:
        print(f"\n{BOLD}{'='*62}")
        print(f"CAT5IVE STANDALONE CLASSIFIER v2.0")
        print(f"{'='*62}{RESET}")
        print(f"  Date:     {session_date}")
        print(f"  Tickers:  {', '.join(tickers)}")
        print(f"  Source:   {'Tradier' if tradier_key else 'Polygon' if polygon_key else 'yfinance'}")
        print(f"  Interval: {args.interval}s  Mode: {'once' if args.once else 'continuous'}")
        print(f"  Logs:     {log_dir}")
        print(f"{BOLD}{'='*62}{RESET}\n")

        if not tradier_key and not polygon_key and not HAS_YF:
            print(f"{RED}ERROR: No API keys found and yfinance not installed.")
            print(f"  setx TRADIER_API_KEY  \"your_key\"")
            print(f"  setx POLYGON_API_KEY  \"your_key\"")
            print(f"  OR: pip install yfinance  (slow fallback){RESET}")
            sys.exit(1)

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

                    bars = get_bars(tkr, session_date, tradier_key, polygon_key)
                    sig  = run_classification(tkr, bars)
                    log_signal(sig, log_dir)

                    # Apply filters
                    if args.high_value_only and sig.signal in ('WAIT','SKIP'):
                        if not args.json:
                            print(f"  {tkr:8} {DIM}{sig.signal} (filtered){RESET}      ")
                        continue
                    if sig.quality_score < args.min_quality:
                        if not args.json:
                            print(f"  {tkr:8} {DIM}Q={sig.quality_score} < {args.min_quality} (filtered){RESET}      ")
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
                    print(f"    {s.ticker:8} {sc}{s.signal:12}{RESET} "
                          f"Q={s.quality_score:>3}  {s.regime[:18]:18}  "
                          f"{s.tier:6}  {s.section}")

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
