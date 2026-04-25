#!/usr/bin/env python3
"""
cat5ive_sim.py - S1/S2 Pre-Fall Score Replay & Flip Analysis
=============================================================
Replays 1-minute bar data bar-by-bar, recomputes S1/S2 pre-fall score
at each bar using only information available at that moment, detects
S1/S2 section flip events, and performs VWAP correlation analysis.

Usage:
  python cat5ive_sim.py --flips TICKER DATE
  python cat5ive_sim.py --flips                        # all tickers
  python cat5ive_sim.py --replay TICKER DATE --no-interactive
  python cat5ive_sim.py --patterns
  python cat5ive_sim.py --backtest
  python cat5ive_sim.py --add-ticker TICKER DATE --csv PATH
  python cat5ive_sim.py --csv PATH ...                 # custom CSV path
  python cat5ive_sim.py --polygon-key KEY ...          # Polygon API key
"""

import os, sys, csv, json, math, time, datetime, argparse, io
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Tuple, Any
from collections import defaultdict

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    import yfinance as yf
    HAS_YF = True
except ImportError:
    HAS_YF = False

# ---------------------------------------------------------------------------
# Optional: finra_loader (same directory)
# ---------------------------------------------------------------------------
try:
    sys.path.insert(0, os.path.dirname(__file__))
    from finra_loader import (
        fetch_finra_short_data,
        compute_vpin,
        compute_kyle_lambda,
        enrich_static_fields,
        vpin_s1_signal,
    )
    HAS_FINRA = True
except ImportError:
    HAS_FINRA = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_CSV = os.path.join(os.path.dirname(__file__), "market_conditions.csv")
RTH_OPEN    = datetime.time(9, 30)
RTH_CLOSE   = datetime.time(16, 0)
PMH_OPEN    = datetime.time(4, 0)
PMH_CLOSE   = datetime.time(9, 30)

POLYGON_BASE = "https://api.polygon.io"

# ---------------------------------------------------------------------------
# Timezone helpers (no pytz dependency)
# ---------------------------------------------------------------------------

def _utc_to_et(dt_utc: datetime.datetime) -> datetime.datetime:
    """Approximate UTC → US/Eastern without pytz (handles DST heuristic)."""
    # DST: second Sunday in March → first Sunday in November
    year = dt_utc.year
    # Second Sunday in March
    d = datetime.date(year, 3, 1)
    sundays = 0
    while sundays < 2:
        if d.weekday() == 6:
            sundays += 1
        if sundays < 2:
            d += datetime.timedelta(days=1)
    dst_start = datetime.datetime(year, d.month, d.day, 2, 0, 0)
    # First Sunday in November
    d = datetime.date(year, 11, 1)
    while d.weekday() != 6:
        d += datetime.timedelta(days=1)
    dst_end = datetime.datetime(year, d.month, d.day, 2, 0, 0)

    # Convert from UTC to EST first
    dt_est = dt_utc - datetime.timedelta(hours=5)
    # Check if we're in DST window
    dst_start_utc = dst_start + datetime.timedelta(hours=5)
    dst_end_utc   = dst_end   + datetime.timedelta(hours=5)
    if dst_start_utc <= dt_utc < dst_end_utc:
        return dt_utc - datetime.timedelta(hours=4)  # EDT
    return dt_est  # EST


def _et_time(ts_ms: int) -> datetime.time:
    dt_utc = datetime.datetime.utcfromtimestamp(ts_ms / 1000)
    return _utc_to_et(dt_utc).time()


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Bar:
    timestamp_ms: int
    open:   float
    high:   float
    low:    float
    close:  float
    volume: int
    vwap:   Optional[float] = None
    session: str = "RTH"   # RTH | PMH | AH

    @property
    def t(self) -> datetime.time:
        return _et_time(self.timestamp_ms)

    def as_dict(self) -> dict:
        return {
            "ts": self.timestamp_ms,
            "o": self.open, "h": self.high, "l": self.low,
            "c": self.close, "v": self.volume,
            "vwap": self.vwap, "session": self.session,
        }


@dataclass
class ScoreResult:
    score:          int
    bias:           str      # LONG_BIAS | SHORT_BIAS | NEUTRAL
    pre_fall_tier:  str      # S1 | S2 | NONE
    section:        str      # S1 | S2 | NONE
    reasons:        List[str] = field(default_factory=list)
    disqualifiers:  List[str] = field(default_factory=list)
    overrides:      List[str] = field(default_factory=list)
    regime:         str      = "UNKNOWN"
    vwap_position:  Optional[str] = None  # ABOVE | BELOW | AT


@dataclass
class FlipEvent:
    bar_index: int
    timestamp_ms: int
    bar_time: datetime.time
    from_section: str
    to_section:   str
    score_before: int
    score_after:  int
    price:        float
    vwap:         Optional[float]
    trigger:      str   # what caused the flip


# ---------------------------------------------------------------------------
# Bar fetching
# ---------------------------------------------------------------------------

def _fetch_polygon(ticker: str, date_str: str, polygon_key: str,
                   timespan: str = "minute") -> List[Bar]:
    url = (f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/{timespan}"
           f"/{date_str}/{date_str}?adjusted=false&sort=asc&limit=50000"
           f"&apiKey={polygon_key}")
    try:
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  [polygon] fetch failed: {e}")
        return []

    bars = []
    for r in data.get("results", []):
        t = _et_time(r["t"])
        if PMH_OPEN <= t < PMH_CLOSE:
            sess = "PMH"
        elif RTH_OPEN <= t < RTH_CLOSE:
            sess = "RTH"
        else:
            sess = "AH"
        bars.append(Bar(
            timestamp_ms = r["t"],
            open  = r["o"], high = r["h"],
            low   = r["l"], close = r["c"],
            volume = int(r.get("v", 0)),
            vwap  = r.get("vw"),
            session = sess,
        ))
    return bars


def _fetch_yfinance(ticker: str, date_str: str) -> List[Bar]:
    if not HAS_YF:
        return []
    try:
        d  = datetime.date.fromisoformat(date_str)
        d2 = d + datetime.timedelta(days=1)
        tk = yf.Ticker(ticker)
        df = tk.history(start=d.isoformat(), end=d2.isoformat(),
                        interval="1m", auto_adjust=False)
        if df is None or df.empty:
            return []
        bars = []
        for idx, row in df.iterrows():
            # yfinance returns tz-aware index
            try:
                import pytz
                et_tz = pytz.timezone("US/Eastern")
                dt_et = idx.astimezone(et_tz)
            except Exception:
                dt_et = idx
            t = dt_et.time().replace(second=0, microsecond=0)
            ts_ms = int(idx.timestamp() * 1000)
            if PMH_OPEN <= t < PMH_CLOSE:
                sess = "PMH"
            elif RTH_OPEN <= t < RTH_CLOSE:
                sess = "RTH"
            else:
                sess = "AH"
            bars.append(Bar(
                timestamp_ms = ts_ms,
                open  = float(row["Open"]),
                high  = float(row["High"]),
                low   = float(row["Low"]),
                close = float(row["Close"]),
                volume = int(row.get("Volume", 0)),
                vwap  = None,
                session = sess,
            ))
        return bars
    except Exception as e:
        print(f"  [yfinance] fetch failed: {e}")
        return []


def fetch_bars(ticker: str, date_str: str, polygon_key: Optional[str] = None) -> List[Bar]:
    if polygon_key and HAS_REQUESTS:
        bars = _fetch_polygon(ticker, date_str, polygon_key)
        if bars:
            print(f"  [bars] {ticker} {date_str}: {len(bars)} bars via Polygon")
            return bars
    bars = _fetch_yfinance(ticker, date_str)
    if bars:
        print(f"  [bars] {ticker} {date_str}: {len(bars)} bars via yfinance")
    else:
        print(f"  [bars] {ticker} {date_str}: no bars fetched")
    return bars


# ---------------------------------------------------------------------------
# VWAP computation (cumulative, RTH only)
# ---------------------------------------------------------------------------

def compute_running_vwap(bars: List[Bar]) -> List[Optional[float]]:
    """Returns per-bar VWAP array (cumulative from session open)."""
    vwaps: List[Optional[float]] = []
    cum_tp_v = 0.0
    cum_v    = 0
    for b in bars:
        if b.session != "RTH":
            vwaps.append(None)
            continue
        tp = (b.high + b.low + b.close) / 3.0
        cum_tp_v += tp * b.volume
        cum_v    += b.volume
        vwaps.append(round(cum_tp_v / cum_v, 4) if cum_v > 0 else None)
    return vwaps


# ---------------------------------------------------------------------------
# Field mask / window enforcer
# ---------------------------------------------------------------------------

def _window_mask(bar_idx: int, bars: List[Bar]) -> dict:
    """Returns which feature categories are 'available' at bar bar_idx."""
    rth_bars = [b for b in bars[:bar_idx+1] if b.session == "RTH"]
    n = len(rth_bars)
    return {
        "has_open":       n >= 1,
        "has_5m":         n >= 5,
        "has_15m":        n >= 15,
        "has_30m":        n >= 30,
        "has_60m":        n >= 60,
        "has_full_day":   n >= 390,
        "rth_bars":       n,
    }


# ---------------------------------------------------------------------------
# Scoring engine (S1/S2 pre-fall)
# ---------------------------------------------------------------------------

def _score_at_bar(bar_idx: int, bars: List[Bar], vwaps: List[Optional[float]],
                  static: dict) -> ScoreResult:
    """
    Recomputes S1/S2 pre-fall score using only information available
    at `bar_idx`. All multi-bar indicators use only bars[:bar_idx+1].
    """
    rth = [b for b in bars[:bar_idx+1] if b.session == "RTH"]
    mask = _window_mask(bar_idx, bars)
    score = 0
    reasons: List[str] = []
    disq: List[str] = []
    overrides: List[str] = []

    # -- Static fields (always available) -----------------------------------
    float_shares   = _float(static.get("float_shares"))
    short_interest = _float(static.get("short_interest_pct"))
    prior_close    = _float(static.get("prior_close"))
    gap_pct        = _float(static.get("gap_pct"))
    news_catalyst  = static.get("news_catalyst", "").upper()
    sector         = static.get("sector", "").upper()
    mkt_cap_m      = _float(static.get("mkt_cap_m"))

    # float score
    if float_shares is not None:
        if float_shares < 5e6:
            score += 3; reasons.append("MICRO_FLOAT")
        elif float_shares < 20e6:
            score += 2; reasons.append("SMALL_FLOAT")
        elif float_shares < 100e6:
            score += 1; reasons.append("MED_FLOAT")
        else:
            score -= 1; reasons.append("LARGE_FLOAT")

    # short interest
    if short_interest is not None:
        if short_interest >= 30:
            score += 3; reasons.append("HIGH_SI")
        elif short_interest >= 15:
            score += 2; reasons.append("MOD_SI")
        elif short_interest >= 5:
            score += 1; reasons.append("LOW_SI")

    # gap
    if gap_pct is not None:
        if gap_pct >= 50:
            score += 4; reasons.append("MEGA_GAP")
        elif gap_pct >= 25:
            score += 3; reasons.append("LARGE_GAP")
        elif gap_pct >= 10:
            score += 2; reasons.append("MOD_GAP")
        elif gap_pct >= 5:
            score += 1; reasons.append("SMALL_GAP")
        elif gap_pct < -5:
            score -= 1; reasons.append("NEG_GAP")

    # catalyst
    if "OFFERING" in news_catalyst or "DILUT" in news_catalyst:
        score += 3; reasons.append("DILUTION_CATALYST")
    elif "SEC" in news_catalyst or "FILING" in news_catalyst:
        score += 2; reasons.append("SEC_FILING")
    elif "BIOCAT" in news_catalyst or "FDA" in news_catalyst:
        score += 2; reasons.append("BIO_CATALYST")
    elif "EARNINGS" in news_catalyst:
        score += 1; reasons.append("EARNINGS")
    elif "NONE" in news_catalyst or news_catalyst == "":
        score -= 1

    # -- Dynamic bar features -----------------------------------------------
    if not rth:
        return ScoreResult(score, _bias(score), _tier(score), _tier(score),
                           reasons, disq, overrides)

    open_price = rth[0].open
    cur_close  = rth[-1].close
    cur_high   = max(b.high  for b in rth)
    cur_low    = min(b.low   for b in rth)
    cur_vol    = sum(b.volume for b in rth)

    # price vs open
    if open_price > 0:
        move_pct = (cur_close - open_price) / open_price * 100
        if move_pct >= 20:
            score += 3; reasons.append("INTRADAY_SURGE_20")
        elif move_pct >= 10:
            score += 2; reasons.append("INTRADAY_SURGE_10")
        elif move_pct >= 5:
            score += 1; reasons.append("INTRADAY_SURGE_5")
        elif move_pct <= -10:
            score -= 2; reasons.append("INTRADAY_DUMP_10")

    # VWAP position
    vwap_now = vwaps[bar_idx] if bar_idx < len(vwaps) else None
    vwap_pos = None
    if vwap_now and cur_close > 0:
        pct_vs_vwap = (cur_close - vwap_now) / vwap_now * 100
        if pct_vs_vwap > 3:
            score += 2; reasons.append("FAR_ABOVE_VWAP"); vwap_pos = "ABOVE"
        elif pct_vs_vwap > 0.5:
            score += 1; reasons.append("ABOVE_VWAP"); vwap_pos = "ABOVE"
        elif pct_vs_vwap < -3:
            score -= 2; reasons.append("FAR_BELOW_VWAP"); vwap_pos = "BELOW"
        elif pct_vs_vwap < -0.5:
            score -= 1; reasons.append("BELOW_VWAP"); vwap_pos = "BELOW"
        else:
            vwap_pos = "AT"

    # volume vs avg (use avg from earlier in the day)
    if mask["has_15m"] and len(rth) >= 15:
        recent_avg = sum(b.volume for b in rth[-15:]) / 15
        if rth[-1].volume > recent_avg * 2.5:
            score += 2; reasons.append("VOL_SURGE_2_5X")
        elif rth[-1].volume > recent_avg * 1.5:
            score += 1; reasons.append("VOL_SURGE_1_5X")

    # candle structure (recent 3 bars)
    if len(rth) >= 3:
        last3 = rth[-3:]
        red_bars = sum(1 for b in last3 if b.close < b.open)
        if red_bars == 3:
            score += 2; reasons.append("3_RED_BARS")
        elif red_bars == 2:
            score += 1; reasons.append("2_RED_BARS")

    # upper wick ratio (exhaustion)
    b_cur = rth[-1]
    body  = abs(b_cur.close - b_cur.open)
    upper_wick = b_cur.high - max(b_cur.close, b_cur.open)
    if body > 0 and upper_wick / body > 1.5:
        score += 2; reasons.append("LONG_UPPER_WICK")

    # micro-cap penalty
    if mkt_cap_m is not None and mkt_cap_m < 50:
        score += 1; reasons.append("MICRO_CAP")

    # SEC short-selling static fields
    short_vol_ratio = _float(static.get("short_vol_ratio"))
    abnormal_sr     = _float(static.get("abnormal_short_ratio"))
    if short_vol_ratio is not None:
        if short_vol_ratio >= 0.55 and (abnormal_sr or 0) >= 1.5:
            score += 3; reasons.append("INST_SHORT_LOADING")
        elif short_vol_ratio >= 0.45:
            score += 1; reasons.append("ELEVATED_SHORT_VOL")

    # VPIN / Kyle from static (pre-computed for spike day)
    vpin_regime = static.get("vpin_regime", "").upper()
    if vpin_regime == "HIGH":
        score += 2; reasons.append("VPIN_HIGH")
    elif vpin_regime == "ELEVATED":
        score += 1; reasons.append("VPIN_ELEVATED")
    elif vpin_regime == "LOW":
        score -= 1; reasons.append("VPIN_LOW")

    lambda_signal = static.get("lambda_signal", "").upper()
    if lambda_signal == "S1_THIN":
        score += 1; reasons.append("THIN_MARKET")
    elif lambda_signal == "S2_THICK":
        score -= 1; reasons.append("THICK_MARKET")

    regime = _detect_regime(rth, vwap_now, cur_vol)
    tier   = _tier(score)
    bias   = _bias(score)

    return ScoreResult(
        score         = score,
        bias          = bias,
        pre_fall_tier = tier,
        section       = tier,
        reasons       = reasons,
        disqualifiers = disq,
        overrides     = overrides,
        regime        = regime,
        vwap_position = vwap_pos,
    )


def _float(v: Any) -> Optional[float]:
    try:
        return float(v) if v not in (None, "", "None", "nan") else None
    except (ValueError, TypeError):
        return None


def _tier(score: int) -> str:
    if score >= 12:
        return "S1"
    elif score >= 7:
        return "S2"
    return "NONE"


def _bias(score: int) -> str:
    if score >= 7:
        return "SHORT_BIAS"
    elif score >= 4:
        return "NEUTRAL"
    return "LONG_BIAS"


def _detect_regime(rth: List[Bar], vwap_now: Optional[float],
                   cur_vol: int) -> str:
    if not rth:
        return "UNKNOWN"
    n = len(rth)
    cur_close = rth[-1].close
    cur_high  = max(b.high for b in rth)
    open_p    = rth[0].open

    # Regime heuristics
    if open_p > 0:
        move = (cur_high - open_p) / open_p * 100
        if move >= 100:
            return "PARABOLIC"
        if move >= 30 and cur_close < (cur_high + open_p) / 2:
            return "BLOW_OFF"
        if move >= 15:
            return "MOMENTUM"

    if vwap_now and cur_close < vwap_now * 0.97:
        return "BREAKING_DOWN"

    return "TRENDING" if n > 30 else "DISCOVERY"


# ---------------------------------------------------------------------------
# Flip detector
# ---------------------------------------------------------------------------

def detect_flips(bars: List[Bar], vwaps: List[Optional[float]],
                 static: dict) -> Tuple[List[FlipEvent], List[ScoreResult]]:
    """
    Runs score engine at every bar. Returns list of section flip events
    and the full per-bar score history.
    """
    scores: List[ScoreResult]  = []
    flips:  List[FlipEvent]    = []
    prev_section = None

    for i, bar in enumerate(bars):
        if bar.session not in ("RTH", "PMH"):
            scores.append(ScoreResult(0, "NEUTRAL", "NONE", "NONE"))
            continue
        sr = _score_at_bar(i, bars, vwaps, static)
        scores.append(sr)

        if prev_section is not None and sr.section != prev_section:
            trigger = sr.reasons[-1] if sr.reasons else "UNKNOWN"
            flips.append(FlipEvent(
                bar_index    = i,
                timestamp_ms = bar.timestamp_ms,
                bar_time     = bar.t,
                from_section = prev_section,
                to_section   = sr.section,
                score_before = scores[i-1].score if i > 0 else 0,
                score_after  = sr.score,
                price        = bar.close,
                vwap         = vwaps[i] if i < len(vwaps) else None,
                trigger      = trigger,
            ))
        prev_section = sr.section

    return flips, scores


# ---------------------------------------------------------------------------
# VWAP correlation analysis
# ---------------------------------------------------------------------------

def vwap_corr_at_flips(flips: List[FlipEvent], bars: List[Bar],
                        vwaps: List[Optional[float]]) -> float:
    """
    For each flip, compute whether price confirmed the new direction
    vs VWAP within the next N bars. Returns confirmation rate 0..1.
    """
    if not flips:
        return 0.0
    confirmed = 0
    for flip in flips:
        i = flip.bar_index
        v = vwaps[i] if i < len(vwaps) else None
        if v is None:
            continue
        target_section = flip.to_section
        # Look forward 10 bars
        for j in range(i+1, min(i+11, len(bars))):
            jv = vwaps[j] if j < len(vwaps) else None
            if jv is None:
                continue
            b = bars[j]
            if target_section in ("S1", "S2") and b.close < jv:
                confirmed += 1
                break
            elif target_section == "NONE" and b.close > jv:
                confirmed += 1
                break
    return round(confirmed / len(flips), 3)


# ---------------------------------------------------------------------------
# Print helpers
# ---------------------------------------------------------------------------

RESET = "\x1b[0m"
BOLD  = "\x1b[1m"
RED   = "\x1b[31m"
GREEN = "\x1b[32m"
YELLOW= "\x1b[33m"
CYAN  = "\x1b[36m"
DIM   = "\x1b[2m"


def _c(text: str, *codes: str) -> str:
    return "".join(codes) + str(text) + RESET


def _print_timeline(ticker: str, date_str: str, flips: List[FlipEvent],
                    bars: List[Bar], scores: List[ScoreResult],
                    vwaps: List[Optional[float]]) -> None:
    corr = vwap_corr_at_flips(flips, bars, vwaps)
    rth  = [b for b in bars if b.session == "RTH"]

    print()
    print(_c(f"{'='*60}", BOLD))
    print(_c(f"  FLIP ANALYSIS  {ticker}  {date_str}", BOLD, CYAN))
    print(_c(f"{'='*60}", BOLD))
    print(f"  RTH bars: {len(rth)}  |  Flips detected: {len(flips)}  |  VWAP corr: {corr}")
    print()

    if not flips:
        print(_c("  No S1/S2 section flips detected in RTH session.", DIM))
        print()
        return

    hdr = f"  {'TIME':6}  {'FROM':5}→{'TO':5}  {'PRICE':8}  {'SCORE':6}  {'TRIGGER':20}  VWAP"
    print(_c(hdr, BOLD))
    print(_c("  " + "-"*70, DIM))

    for flip in flips:
        t_str  = flip.bar_time.strftime("%H:%M")
        v_str  = f"{flip.vwap:.2f}" if flip.vwap else "  N/A"
        p_str  = f"{flip.price:.2f}"
        s_str  = f"{flip.score_before}→{flip.score_after}"
        trig   = flip.trigger[:20]

        # color by direction
        if flip.to_section in ("S1", "S2"):
            row = _c(f"  {t_str:6}  {flip.from_section:5}→{flip.to_section:5}  "
                     f"{p_str:8}  {s_str:6}  {trig:20}  {v_str}", RED)
        else:
            row = _c(f"  {t_str:6}  {flip.from_section:5}→{flip.to_section:5}  "
                     f"{p_str:8}  {s_str:6}  {trig:20}  {v_str}", GREEN)
        print(row)

    print(_c("  " + "-"*70, DIM))
    print(f"  {len(flips)} RTH flips  |  vwap_corr={corr}")
    print()

    # Score timeline (every 15 bars)
    rth_scores = [(b, scores[i]) for i, b in enumerate(bars)
                  if b.session == "RTH" and i < len(scores)]
    if rth_scores:
        print(_c("  SCORE TIMELINE (every 15 min):", BOLD))
        prev_tier = None
        for b, sr in rth_scores[::15]:
            t_str  = b.t.strftime("%H:%M")
            tier_c = RED if sr.section in ("S1","S2") else GREEN
            marker = " ←FLIP" if prev_tier is not None and sr.section != prev_tier else ""
            print(f"  {t_str}  {_c(sr.section, tier_c)}  score={sr.score:3d}  "
                  f"regime={sr.regime:14s}  {sr.vwap_position or '':5s}{marker}")
            prev_tier = sr.section
        print()


# ---------------------------------------------------------------------------
# CSV ticker management
# ---------------------------------------------------------------------------

CSV_REQUIRED = ["ticker", "spike_date"]

def _load_csv(csv_path: str) -> List[dict]:
    if not os.path.exists(csv_path):
        return []
    rows = []
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            rows.append({k.strip(): v.strip() for k, v in row.items()})
    return rows


def _save_csv(csv_path: str, rows: List[dict]) -> None:
    if not rows:
        return
    keys = list(rows[0].keys())
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)


def _add_ticker_to_csv(ticker: str, date_str: str, csv_path: str,
                        polygon_key: Optional[str] = None) -> dict:
    """
    Fetch data for ticker/date, compute static fields, and append to CSV.
    Returns the new row dict.
    """
    ticker = ticker.upper()
    print(f"\n[add-ticker] Fetching data for {ticker} {date_str}...")

    bars = fetch_bars(ticker, date_str, polygon_key)
    rth  = [b for b in bars if b.session == "RTH"]

    # Basic fields
    row: dict = {
        "ticker":       ticker,
        "spike_date":   date_str,
        "float_shares": "",
        "short_interest_pct": "",
        "prior_close":  "",
        "gap_pct":      "",
        "news_catalyst": "",
        "sector":       "",
        "mkt_cap_m":    "",
        "final_type":   "UNKNOWN",
    }

    # Derive from bars
    if rth:
        open_p  = rth[0].open
        high_p  = max(b.high for b in rth)
        close_p = rth[-1].close
        row["open_price"]  = round(open_p, 4)
        row["high_price"]  = round(high_p, 4)
        row["close_price"] = round(close_p, 4)
        row["rth_volume"]  = sum(b.volume for b in rth)
        row["rth_bars"]    = len(rth)
        if open_p > 0:
            row["intraday_move_pct"] = round((high_p - open_p) / open_p * 100, 2)

    # FINRA enrichment
    if HAS_FINRA:
        try:
            static_base = dict(row)
            enriched = enrich_static_fields(ticker, date_str, static_base, bars,
                                             fetch_finra=True)
            row.update(enriched)
            print(f"  [add-ticker] FINRA enrichment complete")
        except Exception as e:
            print(f"  [add-ticker] FINRA enrichment failed: {e}")

    # VPIN / Lambda directly if no FINRA
    if "vpin_regime" not in row and bars:
        bar_dicts = [b.as_dict() for b in bars]
        vpin = compute_vpin(bar_dicts) if HAS_FINRA else {}
        kyle = compute_kyle_lambda(bars)  if HAS_FINRA else {}
        row.update(vpin)
        row.update(kyle)

    # Append to CSV
    rows = _load_csv(csv_path)
    # Remove existing row for same ticker+date
    rows = [r for r in rows if not (r.get("ticker","").upper() == ticker
                                     and r.get("spike_date","") == date_str)]
    # Merge keys
    if rows:
        for key in rows[0].keys():
            if key not in row:
                row[key] = ""
    rows.append(row)
    _save_csv(csv_path, rows)
    print(f"  [add-ticker] Saved {ticker} {date_str} to {csv_path}")
    return row


# ---------------------------------------------------------------------------
# Replay session
# ---------------------------------------------------------------------------

class ReplaySession:
    def __init__(self, ticker: str, date_str: str, static: dict,
                 bars: List[Bar], interactive: bool = True):
        self.ticker      = ticker
        self.date_str    = date_str
        self.static      = static
        self.bars        = bars
        self.interactive = interactive
        self.vwaps       = compute_running_vwap(bars)
        self.rth_bars    = [b for b in bars if b.session == "RTH"]

    def run(self) -> None:
        flips, scores = detect_flips(self.bars, self.vwaps, self.static)
        _print_timeline(self.ticker, self.date_str, flips, self.bars,
                         scores, self.vwaps)

        if not self.interactive or not self.rth_bars:
            return

        print(_c("  [replay mode — press Enter to step, q+Enter to quit]", DIM))
        idx = 0
        while idx < len(self.bars):
            b  = self.bars[idx]
            sr = scores[idx] if idx < len(scores) else None
            if b.session != "RTH" or sr is None:
                idx += 1
                continue

            t_str = b.t.strftime("%H:%M")
            tier_c = RED if sr.section in ("S1","S2") else GREEN
            v_str  = f"{self.vwaps[idx]:.2f}" if self.vwaps[idx] else "N/A"

            print(f"\r  {t_str}  c={b.close:.2f}  vwap={v_str}  "
                  f"{_c(sr.section, tier_c)}  score={sr.score}  "
                  f"regime={sr.regime}", end="", flush=True)

            try:
                inp = input("  ")
            except (EOFError, KeyboardInterrupt):
                break
            if inp.strip().lower() == "q":
                break
            idx += 1
        print()


# ---------------------------------------------------------------------------
# Strategy engine (entry / exit simulation)
# ---------------------------------------------------------------------------

@dataclass
class TradeRecord:
    ticker:      str
    date_str:    str
    entry_bar:   int
    exit_bar:    int
    entry_price: float
    exit_price:  float
    side:        str   # SHORT
    pnl_pct:     float
    flip_trigger: str
    score_at_entry: int
    hold_bars:   int


class StrategyEngine:
    """
    Simulates a simple S1/S2 flip → short-sell strategy.
    Entry: price crosses into S1 from S2 or NONE (sell short at next bar open).
    Exit:  price flips back to NONE or LONG_BIAS, or stop_loss hit.
    """
    def __init__(self, stop_loss_pct: float = 5.0, profit_target_pct: float = 10.0,
                 max_hold_bars: int = 60):
        self.stop_loss_pct      = stop_loss_pct
        self.profit_target_pct  = profit_target_pct
        self.max_hold_bars      = max_hold_bars

    def run(self, ticker: str, date_str: str, bars: List[Bar],
            scores: List[ScoreResult], flips: List[FlipEvent]) -> List[TradeRecord]:
        trades: List[TradeRecord] = []
        rth = [(i, b) for i, b in enumerate(bars) if b.session == "RTH"]
        in_trade = False
        entry_idx = 0
        entry_price = 0.0
        entry_score = 0
        entry_flip_trigger = ""

        for flip in flips:
            if in_trade:
                continue
            if flip.to_section not in ("S1", "S2"):
                continue
            # Enter short at next bar's open
            next_bars = [(i, b) for i, b in rth if i > flip.bar_index]
            if not next_bars:
                continue
            ei, eb = next_bars[0]
            entry_price = eb.open
            if entry_price <= 0:
                continue
            entry_idx   = ei
            entry_score = scores[ei].score if ei < len(scores) else 0
            entry_flip_trigger = flip.trigger
            in_trade = True

            # Scan for exit
            for ji, (xi, xb) in enumerate([(i, b) for i, b in rth if i > ei]):
                hold = ji + 1
                cur_score = scores[xi] if xi < len(scores) else None
                # P&L from short perspective
                pnl_pct = (entry_price - xb.close) / entry_price * 100

                # Stop loss
                if pnl_pct <= -self.stop_loss_pct:
                    trades.append(TradeRecord(ticker, date_str, ei, xi,
                        entry_price, xb.close, "SHORT", round(pnl_pct, 2),
                        entry_flip_trigger, entry_score, hold))
                    in_trade = False; break
                # Profit target
                if pnl_pct >= self.profit_target_pct:
                    trades.append(TradeRecord(ticker, date_str, ei, xi,
                        entry_price, xb.close, "SHORT", round(pnl_pct, 2),
                        entry_flip_trigger, entry_score, hold))
                    in_trade = False; break
                # Section exit
                if cur_score and cur_score.section == "NONE" and hold >= 3:
                    trades.append(TradeRecord(ticker, date_str, ei, xi,
                        entry_price, xb.close, "SHORT", round(pnl_pct, 2),
                        entry_flip_trigger, entry_score, hold))
                    in_trade = False; break
                # Max hold
                if hold >= self.max_hold_bars:
                    trades.append(TradeRecord(ticker, date_str, ei, xi,
                        entry_price, xb.close, "SHORT", round(pnl_pct, 2),
                        entry_flip_trigger, entry_score, hold))
                    in_trade = False; break

        return trades


# ---------------------------------------------------------------------------
# Pattern analyzer
# ---------------------------------------------------------------------------

class PatternAnalyzer:
    """
    Aggregates flip data across all tickers/dates to find recurring patterns.
    """
    def __init__(self):
        self.sessions: List[dict] = []

    def add(self, ticker: str, date_str: str, flips: List[FlipEvent],
            scores: List[ScoreResult], bars: List[Bar]) -> None:
        rth = [b for b in bars if b.session == "RTH"]
        corr = vwap_corr_at_flips(flips, bars,
                                    compute_running_vwap(bars))
        self.sessions.append({
            "ticker":     ticker,
            "date":       date_str,
            "flips":      len(flips),
            "vwap_corr":  corr,
            "rth_bars":   len(rth),
            "max_score":  max((s.score for s in scores if s), default=0),
            "flip_times": [f.bar_time.strftime("%H:%M") for f in flips],
            "triggers":   [f.trigger for f in flips],
        })

    def print_summary(self) -> None:
        print()
        print(_c("="*60, BOLD))
        print(_c("  PATTERN ANALYSIS SUMMARY", BOLD, CYAN))
        print(_c("="*60, BOLD))
        print(f"  Sessions analysed: {len(self.sessions)}")

        if not self.sessions:
            print("  No sessions.\n")
            return

        # Flip count distribution
        flip_counts = defaultdict(int)
        for s in self.sessions:
            flip_counts[s["flips"]] += 1
        print("\n  Flip count distribution:")
        for k in sorted(flip_counts):
            bar = "█" * flip_counts[k]
            print(f"    {k:2d} flips: {bar} ({flip_counts[k]})")

        # Most common flip times
        all_times = []
        for s in self.sessions:
            all_times.extend(s["flip_times"])
        time_freq = defaultdict(int)
        for t in all_times:
            time_freq[t] += 1
        top_times = sorted(time_freq, key=lambda x: -time_freq[x])[:10]
        print("\n  Most common flip times (top 10):")
        for t in top_times:
            print(f"    {t}  ×{time_freq[t]}")

        # Trigger analysis
        all_triggers = []
        for s in self.sessions:
            all_triggers.extend(s["triggers"])
        trig_freq = defaultdict(int)
        for t in all_triggers:
            trig_freq[t] += 1
        top_trig = sorted(trig_freq, key=lambda x: -trig_freq[x])[:10]
        print("\n  Most common flip triggers (top 10):")
        for t in top_trig:
            print(f"    {t:30s}  ×{trig_freq[t]}")

        # VWAP correlation
        corrs = [s["vwap_corr"] for s in self.sessions if s["vwap_corr"] > 0]
        if corrs:
            avg_corr = sum(corrs) / len(corrs)
            print(f"\n  Avg VWAP correlation at flips: {avg_corr:.3f}")
        print()


# ---------------------------------------------------------------------------
# Backtest exporter
# ---------------------------------------------------------------------------

class BacktestExporter:
    def __init__(self, out_dir: str = "."):
        self.out_dir  = out_dir
        self.all_trades: List[TradeRecord] = []

    def add_trades(self, trades: List[TradeRecord]) -> None:
        self.all_trades.extend(trades)

    def print_summary(self) -> None:
        trades = self.all_trades
        print()
        print(_c("="*60, BOLD))
        print(_c("  BACKTEST RESULTS", BOLD, CYAN))
        print(_c("="*60, BOLD))
        print(f"  Total trades: {len(trades)}")
        if not trades:
            print("  No trades.\n")
            return

        winners = [t for t in trades if t.pnl_pct > 0]
        losers  = [t for t in trades if t.pnl_pct <= 0]
        win_rate = len(winners) / len(trades) * 100
        avg_pnl  = sum(t.pnl_pct for t in trades) / len(trades)
        total_pnl= sum(t.pnl_pct for t in trades)

        print(f"  Win rate:     {win_rate:.1f}%  ({len(winners)}W / {len(losers)}L)")
        print(f"  Avg P&L:      {avg_pnl:+.2f}%")
        print(f"  Total P&L:    {total_pnl:+.2f}%")

        if winners:
            best = max(winners, key=lambda t: t.pnl_pct)
            print(f"  Best trade:   {best.ticker} {best.date_str}  {best.pnl_pct:+.2f}%")
        if losers:
            worst = min(losers, key=lambda t: t.pnl_pct)
            print(f"  Worst trade:  {worst.ticker} {worst.date_str}  {worst.pnl_pct:+.2f}%")

        # Per-ticker breakdown
        by_ticker: Dict[str, List[TradeRecord]] = defaultdict(list)
        for t in trades:
            by_ticker[t.ticker].append(t)
        print("\n  Per-ticker breakdown:")
        hdr = f"    {'TICKER':8}  {'TRADES':6}  {'WIN%':6}  {'AVG PNL':9}"
        print(_c(hdr, BOLD))
        for tk in sorted(by_ticker):
            ts  = by_ticker[tk]
            wr  = sum(1 for t in ts if t.pnl_pct > 0) / len(ts) * 100
            avg = sum(t.pnl_pct for t in ts) / len(ts)
            print(f"    {tk:8}  {len(ts):6d}  {wr:5.1f}%  {avg:+8.2f}%")

        # Export CSV
        out_path = os.path.join(self.out_dir, "backtest_results.csv")
        try:
            with open(out_path, "w", newline="", encoding="utf-8") as f:
                fields = ["ticker","date_str","side","entry_price","exit_price",
                          "pnl_pct","entry_bar","exit_bar","hold_bars",
                          "score_at_entry","flip_trigger"]
                w = csv.DictWriter(f, fieldnames=fields)
                w.writeheader()
                for t in trades:
                    w.writerow(asdict(t))
            print(f"\n  Results exported → {out_path}")
        except Exception as e:
            print(f"  (export failed: {e})")
        print()


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def _build_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Cat5ive S1/S2 Flip Analyser")
    p.add_argument("--flips",       nargs="*", metavar=("TICKER", "DATE"),
                   help="Show flip timeline for TICKER DATE, or all tickers if no args")
    p.add_argument("--replay",      nargs=2,   metavar=("TICKER", "DATE"),
                   help="Interactive bar-by-bar replay")
    p.add_argument("--patterns",    action="store_true",
                   help="Pattern analysis across all CSV sessions")
    p.add_argument("--backtest",    action="store_true",
                   help="Run full backtest across all CSV sessions")
    p.add_argument("--add-ticker",  nargs=2,   metavar=("TICKER", "DATE"),
                   help="Fetch & add ticker/date to CSV")
    p.add_argument("--no-interactive", action="store_true",
                   help="Disable interactive replay prompts")
    p.add_argument("--csv",         default=DEFAULT_CSV,
                   help=f"Path to market_conditions CSV (default: {DEFAULT_CSV})")
    p.add_argument("--polygon-key", default=os.environ.get("POLYGON_API_KEY"),
                   help="Polygon API key (or set POLYGON_API_KEY env var)")
    return p.parse_args()


def _run_flips(rows: List[dict], ticker: Optional[str], date_str: Optional[str],
               polygon_key: Optional[str]) -> None:
    targets = []
    if ticker and date_str:
        targets = [(ticker.upper(), date_str)]
    else:
        for r in rows:
            t = r.get("ticker","").upper()
            d = r.get("spike_date","")
            if t and d:
                targets.append((t, d))

    if not targets:
        print("No tickers found. Use --add-ticker first.")
        return

    for t, d in targets:
        static = next((r for r in rows
                       if r.get("ticker","").upper() == t
                       and r.get("spike_date","") == d), {})
        print(f"\n[flip] fetching bars for {t} {d}...")
        bars = fetch_bars(t, d, polygon_key)
        if not bars:
            print(f"  No bars for {t} {d}, skipping.")
            continue
        vwaps  = compute_running_vwap(bars)
        flips, scores = detect_flips(bars, vwaps, static)
        _print_timeline(t, d, flips, bars, scores, vwaps)


def _run_patterns(rows: List[dict], polygon_key: Optional[str]) -> None:
    analyser = PatternAnalyzer()
    for r in rows:
        t = r.get("ticker","").upper()
        d = r.get("spike_date","")
        if not t or not d:
            continue
        print(f"[patterns] {t} {d}...")
        bars = fetch_bars(t, d, polygon_key)
        if not bars:
            continue
        vwaps  = compute_running_vwap(bars)
        flips, scores = detect_flips(bars, vwaps, r)
        analyser.add(t, d, flips, scores, bars)
    analyser.print_summary()


def _run_backtest(rows: List[dict], polygon_key: Optional[str]) -> None:
    exporter = BacktestExporter()
    engine   = StrategyEngine()
    for r in rows:
        t = r.get("ticker","").upper()
        d = r.get("spike_date","")
        if not t or not d:
            continue
        print(f"[backtest] {t} {d}...")
        bars = fetch_bars(t, d, polygon_key)
        if not bars:
            continue
        vwaps  = compute_running_vwap(bars)
        flips, scores = detect_flips(bars, vwaps, r)
        trades = engine.run(t, d, bars, scores, flips)
        exporter.add_trades(trades)
    exporter.print_summary()


def main() -> None:
    args = _build_args()
    csv_path    = args.csv
    polygon_key = args.polygon_key
    rows        = _load_csv(csv_path)

    if args.add_ticker:
        ticker, date_str = args.add_ticker
        _add_ticker_to_csv(ticker, date_str, csv_path, polygon_key)
        return

    if args.flips is not None:
        ticker   = args.flips[0] if len(args.flips) >= 1 else None
        date_str = args.flips[1] if len(args.flips) >= 2 else None
        _run_flips(rows, ticker, date_str, polygon_key)
        return

    if args.replay:
        ticker, date_str = args.replay
        ticker = ticker.upper()
        static = next((r for r in rows
                       if r.get("ticker","").upper() == ticker
                       and r.get("spike_date","") == date_str), {})
        bars = fetch_bars(ticker, date_str, polygon_key)
        if not bars:
            print(f"No bars for {ticker} {date_str}"); return
        sess = ReplaySession(ticker, date_str, static, bars,
                              interactive=not args.no_interactive)
        sess.run()
        return

    if args.patterns:
        _run_patterns(rows, polygon_key)
        return

    if args.backtest:
        _run_backtest(rows, polygon_key)
        return

    print("No command specified. Run with --help.")


if __name__ == "__main__":
    main()
