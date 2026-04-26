#!/usr/bin/env python3
"""
cat5ive_sim.py â Time-Synchronized Score Simulation System
===========================================================
Replays 1-minute bar data for any spike day bar-by-bar,
recomputing S1/S2 pre-fall score at each bar using ONLY
information available at that moment in time.

Features:
  - Time-synchronized replay with information windowing
  - Interactive CLI with step/play/seek controls
  - Add/delete tickers from the watchlist CSV
  - Export: bar-by-bar CSV, JSON timeline, summary report, P&L log
  - Strategy backtesting layer with entry/exit rules
  - Performance evaluation across all sessions

Usage:
  python cat5ive_sim.py --replay SKYQ 2026-04-13
  python cat5ive_sim.py --replay SKYQ 2026-04-13 --export all
  python cat5ive_sim.py --add-ticker NVDA 2026-04-14
  python cat5ive_sim.py --remove-ticker ALLO 2026-04-10
  python cat5ive_sim.py --list
  python cat5ive_sim.py --backtest --all
  python cat5ive_sim.py --perf

Requirements:
  pip install requests yfinance pandas
  Set POLYGON_API_KEY env var (or pass --polygon-key)
  market_conditions.csv in same directory
"""

import os, sys, csv, json, time, math, argparse, shutil
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field, asdict
from typing import Optional
from collections import defaultdict

# ââ Optional deps âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# FINRA/VPIN loader (finra_loader.py must be in same directory)
try:
    from finra_loader import (compute_vpin, compute_kyle_lambda,
                               vpin_s1_signal, enrich_static_fields,
                               fetch_finra_short_data)
    HAS_FINRA = True
except ImportError:
    HAS_FINRA = False
    def compute_vpin(bars, **kw): return {}
    def compute_kyle_lambda(bars, **kw): return {}
    def vpin_s1_signal(vpin_data): return 0.0, "FINRA_LOADER_MISSING"
    def enrich_static_fields(ticker, date, static, bars, **kw): return static
    def fetch_finra_short_data(*a, **kw): return {}

# ââ Optional deps âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# CONFIG
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

DEFAULT_CSV   = "market_conditions.csv"
BARS_CACHE    = "sim_bars_cache"        # directory for cached Polygon bar files
SESSIONS_DIR  = "sim_sessions"          # precomputed replay JSON blobs
EXPORT_DIR    = "sim_exports"           # all exports land here

# Session boundaries â ET minutes since midnight (fixed, timezone-invariant)
_PM_START     = 4  * 60                 # 4:00am ET
_RTH_OPEN     = 9  * 60 + 30           # 9:30am ET
_RTH_CLOSE    = 16 * 60                 # 4:00pm ET
_AH_END       = 20 * 60                 # 8:00pm ET
W1_CLOSE_MIN  = 9  * 60 + 35           # 9:35am ET â imbalance unlocks
LARGE_PRINT_MIN = 9 * 60 + 45          # 9:45am ET â large print zone unlocks

# ââ DST-aware UTCâET conversion ââââââââââââââââââââââââââââââââââââââââââââââ
try:
    import zoneinfo as _zi
    _TZ_ET = _zi.ZoneInfo("America/New_York")
    def _utc_ms_to_et_dt(ts_ms: int):
        """Convert Polygon UTC millisecond timestamp to aware ET datetime."""
        from datetime import datetime as _DT, timezone as _TZ
        return _DT.fromtimestamp(ts_ms / 1000, tz=_TZ.utc).astimezone(_TZ_ET)
except ImportError:
    _TZ_ET = None
    def _utc_ms_to_et_dt(ts_ms: int):
        """Fallback: compute ET offset from DST rule (no zoneinfo available)."""
        from datetime import datetime as _DT, timezone as _TZ, timedelta as _TD
        dt_utc = _DT.fromtimestamp(ts_ms / 1000, tz=_TZ.utc)
        # DST: 2nd Sun Mar â 1st Sun Nov = EDT (UTC-4), else EST (UTC-5)
        year = dt_utc.year
        # 2nd Sunday of March
        mar1 = _DT(year, 3, 1, tzinfo=_TZ.utc)
        dst_start = mar1 + _TD(days=(6 - mar1.weekday()) % 7 + 7)
        dst_start = dst_start.replace(hour=7)  # 2:00am ET = 7:00am UTC
        # 1st Sunday of November
        nov1 = _DT(year, 11, 1, tzinfo=_TZ.utc)
        dst_end = nov1 + _TD(days=(6 - nov1.weekday()) % 7)
        dst_end = dst_end.replace(hour=6)      # 2:00am ET = 6:00am UTC
        offset_h = -4 if dst_start <= dt_utc < dst_end else -5
        return dt_utc + _TD(hours=offset_h)

S1_SET = {
    'MWYN','CRBU','OLMA','GNS','ATON','KZIA','XBIO','WNW','JZXN',
    'VIR','ARTL','ELAB','KSS','SMXT','YOUL','ONCO','MSS','RAPP',
    'NA','LRHC','FLWS','SAFX','CWD','AIHS','IMTE','ALBT','DMRA',
    'INKT','MBIO','MSGM','SCNI','TNON','BNAI','SUGP','RANI','PBM',
    'PFSA','FCUV','HOLO','GREE'
}
S2_SET = {
    'EQ','LOBO','LCFY','BJDX','CYCN','SELX','HWH','NERV','IPDN',
    'VWAV','APM','BTBD','FGI','TURB','INMB','CPOP','ALLO','SKYQ'
}

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# DATA CLASSES
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

@dataclass
class Bar:
    ts_ms:           int
    ts_et:           str           # "HH:MM"
    ts_et_full:      str           # "YYYY-MM-DD HH:MM"
    session:         str           # PRE_MARKET | RTH | AFTER_HOURS
    bar_index:       int
    open:            float
    high:            float
    low:             float
    close:           float
    volume:          int
    # Running (computed as stream builds)
    high_so_far:     float = 0.0
    low_so_far:      float = 0.0
    cum_volume:      int   = 0
    vwap_running:    float = 0.0
    vol_ratio_running: float = 0.0
    wick_running:    float = 0.0   # (high_so_far - close) / (high_so_far - session_open)
    intraday_move_pct: float = 0.0 # (high_so_far - prior_close) / prior_close * 100

@dataclass
class Signal:
    name:         str
    contribution: float
    window:       int           # 1=static, 2=AH-prior, 3=RTH live, 4=AH-spike
    available:    bool = True

@dataclass
class ScoreResult:
    pre_fall_score:     int
    pre_fall_tier:      str
    s1_score:           float
    s2_score:           float
    section:            str
    confidence_pct:     int
    active_signals:     list = field(default_factory=list)
    suppressed_signals: list = field(default_factory=list)
    disqualifiers:      list = field(default_factory=list)
    delta_from_prev:    int  = 0

@dataclass
class BarState:
    bar:    Bar
    result: ScoreResult
    mask:   dict = field(default_factory=dict)   # field snapshot at this bar (for pattern analysis)

@dataclass
class TimelineEvent:
    bar_index:    int
    ts_et:        str
    event_type:   str
    price:        float
    score_before: int
    score_after:  int
    signal_name:  str
    description:  str

@dataclass
class Trade:
    ticker:        str
    spike_date:    str
    entry_bar:     int
    entry_time:    str
    entry_price:   float
    exit_bar:      int   = 0
    exit_time:     str   = ""
    exit_price:    float = 0.0
    pnl_pct:       float = 0.0
    bars_held:     int   = 0
    entry_score:   int   = 0
    entry_tier:    str   = ""
    stop_price:    float = 0.0
    stop_hit:      bool  = False
    exit_reason:   str   = ""

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# HELPERS
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _ms_to_et(ts_ms: int) -> tuple:
    """
    Convert Polygon UTC ms timestamp â (HH:MM string, ET datetime, ET minutes).
    Uses DST-aware America/New_York conversion â no hardcoded offset.
    """
    dt_et = _utc_ms_to_et_dt(ts_ms)
    mins  = dt_et.hour * 60 + dt_et.minute
    return dt_et.strftime("%H:%M"), dt_et, mins

def _session(mins: int) -> str:
    if _PM_START <= mins < _RTH_OPEN:  return "PRE_MARKET"
    if _RTH_OPEN <= mins < _RTH_CLOSE: return "RTH"
    if _RTH_CLOSE <= mins <= _AH_END:  return "AFTER_HOURS"
    return "OVERNIGHT"

def _flt(v, default=0.0):
    try:    return float(v)
    except: return default

def _int(v, default=0):
    try:    return int(float(v))
    except: return default

def _pct(n, d):
    return round(n / d * 100, 1) if d else 0.0

def _tier(score: int) -> str:
    if score >= 50:   return "HIGH"
    if score >= 25:   return "MEDIUM"
    if score >= 10:   return "LOW"
    return "SKIP"

def _tier_color(tier: str) -> str:
    return {"HIGH":"\033[92m","MEDIUM":"\033[93m","LOW":"\033[33m","SKIP":"\033[90m"}.get(tier,"\033[0m")

RESET = "\033[0m"
BOLD  = "\033[1m"
RED   = "\033[91m"
GRN   = "\033[92m"
YEL   = "\033[93m"
BLU   = "\033[94m"
CYN   = "\033[96m"
DIM   = "\033[2m"

def _ensure_dirs():
    for d in [BARS_CACHE, SESSIONS_DIR, EXPORT_DIR]:
        os.makedirs(d, exist_ok=True)

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# CSV TICKER MANAGEMENT â add / delete / list
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def load_csv(path: str = DEFAULT_CSV) -> tuple[list, list]:
    """Return (rows, fieldnames). Creates file if absent."""
    if not os.path.exists(path):
        print(f"{YEL}No CSV found at {path}. Creating empty file.{RESET}")
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["ticker","spike_date"])
            w.writeheader()
        return [], ["ticker","spike_date"]

    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows   = list(reader)
        cols   = reader.fieldnames or []
    return rows, cols

def save_csv(rows: list, cols: list, path: str = DEFAULT_CSV):
    """Write rows back to CSV preserving column order."""
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    print(f"{GRN}Saved {len(rows)} rows â {path}{RESET}")

def cmd_list(path: str = DEFAULT_CSV, api_key: str = ""):
    """List all ticker+date pairs in the CSV."""
    # Show API key status at top of list
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cfg_path   = os.path.join(script_dir, "config.txt")
    if api_key:
        key_display = api_key[:4] + "****" + api_key[-4:] if len(api_key) > 8 else "****"
        print(f"  {GRN}â Polygon key:{RESET} {key_display}")
    elif os.path.exists(cfg_path):
        print(f"  {GRN}â Polygon key:{RESET} loaded from config.txt")
    else:
        print(f"  {YEL}â  No Polygon key.{RESET}  Run once to save it permanently:")
        print(f"    python cat5ive_sim.py --set-key YOUR_POLYGON_KEY")
    rows, _ = load_csv(path)
    if not rows:
        print(f"{YEL}No tickers in {path}{RESET}")
        return
    print(f"\n{BOLD}{'#':>3}  {'TICKER':<8} {'DATE':<12} {'REGIME':<22} {'SECTION':<8} {'D+1':>8}{RESET}")
    print("â" * 65)
    for i, r in enumerate(rows, 1):
        d1 = _flt(r.get("ret_d1"))
        d1s = f"{d1:+.1f}%" if d1 else "pending"
        section = "S1" if r["ticker"] in S1_SET else ("S2" if r["ticker"] in S2_SET else "?")
        regime = r.get("market_regime","")[:20]
        print(f"{i:>3}  {r['ticker']:<8} {r['spike_date']:<12} {regime:<22} {section:<8} {d1s:>8}")
    print(f"\nTotal: {len(rows)} rows")

def _auto_fetch_ohlcv(ticker: str, spike_date: str, api_key: str = None) -> dict:
    """
    Auto-fetch price + volume data for spike day and next 10 days.
    Tries Polygon daily bars first (if api_key available), falls back to yfinance.
    Returns dict of pre-filled fields.
    """
    # ââ Try Polygon first ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if api_key and HAS_REQUESTS:
        try:
            from datetime import date as dt_date, timedelta as td
            spike_dt = dt_date.fromisoformat(spike_date)
            end_dt   = spike_dt + td(days=15)
            prev_dt  = spike_dt - td(days=6)

            def _poly_daily(from_d, to_d):
                url = (f"https://api.polygon.io/v2/aggs/ticker/{ticker.upper()}/range/1/day/"
                       f"{from_d}/{to_d}?adjusted=true&sort=asc&limit=50&apiKey={api_key}")
                r = requests.get(url, timeout=10)
                if r.status_code == 200:
                    res = r.json().get("results", [])
                    return res
                return []

            bars     = _poly_daily(spike_date,          end_dt.isoformat())
            pre_bars = _poly_daily(prev_dt.isoformat(), (spike_dt - td(days=1)).isoformat())

            if bars:
                def _b(i, key, default=""):
                    try: return round(bars[i][key], 4)
                    except: return default

                d0_open  = _b(0, "o")
                d0_high  = _b(0, "h")
                d0_close = _b(0, "c")
                d0_vol   = _b(0, "v")

                prior_close = round(pre_bars[-1]["c"], 4) if pre_bars else ""
                avg_vol = (sum(b["v"] for b in pre_bars) / len(pre_bars)) if pre_bars else 0
                vol_ratio = round(float(d0_vol) / avg_vol, 2) if avg_vol and d0_vol else ""

                gap_pct  = round((float(d0_open) - float(prior_close)) / float(prior_close) * 100, 2) \
                           if prior_close and d0_open else ""
                move_pct = round((float(d0_high) - float(prior_close)) / float(prior_close) * 100, 2) \
                           if prior_close and d0_high else ""
                wick = ""
                if d0_open and d0_close and d0_high and prior_close:
                    hod = float(d0_high); pc = float(prior_close); cl = float(d0_close)
                    wick = round((hod - cl) / (hod - pc), 3) if hod > pc else ""

                d1c = _b(1,"c"); d3c = _b(3,"c"); d5c = _b(5,"c"); d10c = _b(10,"c")
                ret = lambda dc: round((float(dc)-float(d0_close))/float(d0_close)*100,2) \
                                 if dc and d0_close else ""

                print(f"  [{GRN}Polygon{RESET}]", end=" ")
                return {
                    "price_d0_open":   d0_open,  "price_d0_high":  d0_high,
                    "price_d0_close":  d0_close, "price_d1_open":  _b(1,"o"),
                    "price_d1_close":  d1c,      "price_d1_high":  _b(1,"h"),
                    "price_d3_close":  d3c,      "price_d5_close": d5c,
                    "price_d10_close": d10c,
                    "vol_d0": d0_vol,  "vol_d1": _b(1,"v"),
                    "vol_d3": _b(3,"v"), "vol_d5": _b(5,"v"),
                    "vol_ratio": vol_ratio, "gap_pct": gap_pct,
                    "intraday_move_pct": move_pct, "wick_ratio": wick,
                    "ret_d1": ret(d1c), "ret_d3": ret(d3c),
                    "ret_d5": ret(d5c), "ret_d10": ret(d10c),
                }
        except Exception as e:
            print(f"  {YEL}[Polygon daily] {e} â trying yfinance{RESET}", end=" ")

    # ââ Fall back to yfinance âââââââââââââââââââââââââââââââââââââââââââââââââ
    try:
        import yfinance as yf
        from datetime import date as dt_date, timedelta
        spike_dt  = dt_date.fromisoformat(spike_date)
        end_dt    = spike_dt + timedelta(days=15)
        data = yf.download(ticker, start=spike_date, end=end_dt.isoformat(),
                           interval="1d", progress=False, auto_adjust=True)
        if data.empty:
            return {}

        def _val(col, i=0):
            try:
                v = float(data[col].iloc[i])
                return round(v, 4) if v else ""
            except:
                return ""

        def _avg_vol(n=20):
            try:
                hist = yf.download(ticker,
                    start=(spike_dt - timedelta(days=30)).isoformat(),
                    end=spike_date, interval="1d", progress=False, auto_adjust=True)
                if len(hist) < 5: return 0
                return float(hist["Volume"].tail(n).mean())
            except:
                return 0

        d0_open  = _val("Open",  0)
        d0_high  = _val("High",  0)
        d0_close = _val("Close", 0)
        d0_vol   = _val("Volume",0)
        avg_vol  = _avg_vol()
        vol_ratio = round(float(d0_vol) / avg_vol, 2) if avg_vol > 0 and d0_vol else ""

        prior_close = _val("Close", -1) if len(data) > 1 else ""
        try:
            prior_close = float(yf.download(ticker,
                start=(spike_dt - timedelta(days=5)).isoformat(),
                end=spike_date, interval="1d", progress=False, auto_adjust=True)["Close"].iloc[-1])
            prior_close = round(prior_close, 4)
        except:
            pass

        gap_pct = round((float(d0_open) - prior_close) / prior_close * 100, 2) if prior_close and d0_open else ""
        move_pct = round((float(d0_high) - prior_close) / prior_close * 100, 2) if prior_close and d0_high else ""
        wick = ""
        if d0_open and d0_close and d0_high and prior_close:
            hod = float(d0_high)
            pc  = float(prior_close)
            cl  = float(d0_close)
            wick = round((hod - cl) / (hod - pc), 3) if hod > pc else ""

        d1_open  = _val("Open",  1)
        d1_close = _val("Close", 1)
        d1_high  = _val("High",  1)
        d3_close = _val("Close", 3)
        d5_close = _val("Close", 5)
        d10_close= _val("Close", 10)
        d1_vol   = _val("Volume",1)
        d3_vol   = _val("Volume",3)
        d5_vol   = _val("Volume",5)

        ret_d1  = round((float(d1_close) - float(d0_close)) / float(d0_close) * 100, 2) if d1_close and d0_close else ""
        ret_d3  = round((float(d3_close) - float(d0_close)) / float(d0_close) * 100, 2) if d3_close and d0_close else ""
        ret_d5  = round((float(d5_close) - float(d0_close)) / float(d0_close) * 100, 2) if d5_close and d0_close else ""
        ret_d10 = round((float(d10_close)- float(d0_close)) / float(d0_close) * 100, 2) if d10_close and d0_close else ""

        return {
            "price_d0_open":  d0_open,
            "price_d0_high":  d0_high,
            "price_d0_close": d0_close,
            "price_d1_open":  d1_open,
            "price_d1_close": d1_close,
            "price_d1_high":  d1_high,
            "price_d3_close": d3_close,
            "price_d5_close": d5_close,
            "price_d10_close":d10_close,
            "vol_d0":         d0_vol,
            "vol_d1":         d1_vol,
            "vol_d3":         d3_vol,
            "vol_d5":         d5_vol,
            "vol_ratio":      vol_ratio,
            "gap_pct":        gap_pct,
            "intraday_move_pct": move_pct,
            "wick_ratio":     wick,
            "ret_d1":         ret_d1,
            "ret_d3":         ret_d3,
            "ret_d5":         ret_d5,
            "ret_d10":        ret_d10,
        }
    except Exception as e:
        print(f"  {YEL}[yfinance] auto-fetch failed: {e}{RESET}")
        return {}


def _auto_fetch_context(ticker: str, spike_date: str, api_key: str = None) -> dict:
    """
    Fully automatic â answers EVERY add-ticker field with no user input.
    Sources: Polygon (bars + daily), EDGAR EFTS, Finviz, market_condition_classifier logic.
    """
    if not HAS_REQUESTS:
        return {}

    import re as _re, math as _math
    from datetime import date as _date, timedelta as _td
    result = {}
    spike_dt = _date.fromisoformat(spike_date)

    # ââ ET timezone helper ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def et_min(ts_ms, date_str):
        try:
            import zoneinfo, datetime as _dt
            tz = zoneinfo.ZoneInfo("America/New_York")
            dt = _dt.datetime.fromtimestamp(ts_ms/1000, tz=_dt.timezone.utc).astimezone(tz)
            return dt.hour * 60 + dt.minute
        except:
            d = _date.fromisoformat(date_str)
            offset = -4 if 3 <= d.month <= 10 else -5
            return ((ts_ms // 60000) % 1440 + offset * 60) % 1440

    def flt(v, d=0.0):
        try: return float(v)
        except: return d

    # ââ 1. EDGAR â filings ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    print(f"  Fetching EDGAR ...", end="", flush=True)
    prior_424 = 0; sameday_424 = False; has_s1 = False; has_8k = False
    try:
        hdr = {"User-Agent": "cat5ive-sim research@cat5ive.com"}
        cutoff = (spike_dt - _td(days=365)).isoformat()
        def _edgar(form, s, e):
            r = requests.get(
                f"https://efts.sec.gov/LATEST/search-index?q=%22{ticker.upper()}%22"
                f"&dateRange=custom&startdt={s}&enddt={e}&forms={form}",
                timeout=10, headers=hdr)
            return r.json().get("hits",{}).get("hits",[]) if r.status_code==200 else []

        hits_424_12m   = _edgar("424B5", cutoff, spike_date)
        hits_424_today = _edgar("424B5", spike_date, spike_date)
        hits_s1        = _edgar("S-1",   cutoff, spike_date)
        hits_8k_today  = _edgar("8-K",   spike_date, spike_date)
        hits_8k_3d     = _edgar("8-K",   (spike_dt-_td(days=3)).isoformat(), spike_date)

        prior_424   = len(hits_424_12m)
        sameday_424 = len(hits_424_today) > 0
        has_s1      = len(hits_s1) > 0
        has_8k      = len(hits_8k_today) > 0 or len(hits_8k_3d) > 0

        result["prior_offerings_12m"] = str(prior_424)
        result["tier1_filings"]   = "424B5" if sameday_424 else ("S-1" if has_s1 else ("8-K" if has_8k else ""))
        result["dilution_status"] = ("offering" if sameday_424
                                     else "shelf" if has_s1
                                     else "unknown")
        result["company_intent"]  = ("serial_diluter" if prior_424 >= 3
                                     else "repeat" if prior_424 >= 1
                                     else "clean" if not has_s1 and not sameday_424
                                     else "unknown")
        result["supply_overhang"] = "YES" if prior_424 >= 2 else ("YES" if sameday_424 else "NO")
        tag = f"{prior_424} prior" + (" + same-day 424B5" if sameday_424 else "") + (" + 8-K" if has_8k else "")
        print(f" {GRN}done{RESET} ({tag})")
    except Exception as e:
        print(f" {YEL}EDGAR: {e}{RESET}")

    # ââ 2. Finviz â float + short data ââââââââââââââââââââââââââââââââââââââââ
    print(f"  Fetching Finviz ...", end="", flush=True)
    float_shares = 0
    try:
        r = requests.get(
            f"https://finviz.com/quote.ashx?t={ticker.upper()}&ty=c&ta=1&p=d",
            timeout=10, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://finviz.com/",
            })
        if r.status_code == 200:
            html = r.text
            # Float shares
            fm = _re.search(r"Shs\s+Float[^<]*</td>\s*<td[^>]*>([0-9.,]+[MBK]?)</td>", html)
            if fm:
                raw = fm.group(1).strip()
                mult = {"M":1e6,"B":1e9,"K":1e3}.get(raw[-1],1) if raw[-1].isalpha() else 1
                float_shares = int(flt(raw.rstrip("MBKmbk").replace(",","")) * mult)
                result["float_shares"] = str(float_shares)
                print(f" {GRN}done{RESET} (float={raw})", end="")
            else:
                # Try alternate Finviz layout
                fm2 = _re.search(r"Float[^<]*</td>\s*<td[^>]*>([0-9.,]+[MBK]?)</td>", html)
                if fm2:
                    raw = fm2.group(1).strip()
                    mult = {"M":1e6,"B":1e9,"K":1e3}.get(raw[-1],1) if raw[-1].isalpha() else 1
                    float_shares = int(flt(raw.rstrip("MBKmbk").replace(",","")) * mult)
                    result["float_shares"] = str(float_shares)
                    print(f" {GRN}done{RESET} (float={raw})", end="")
                else:
                    print(f" {YEL}float not found{RESET}", end="")
            # Short float
            sm = _re.search(r"Short\s+Float[^<]*</td>\s*<td[^>]*>([0-9.,]+%?)</td>", html)
            if sm: result["short_float_pct"] = sm.group(1).strip()
            print()
        else:
            print(f" {YEL}HTTP {r.status_code}{RESET}")
    except Exception as e:
        print(f" {YEL}Finviz: {e}{RESET}")

    # ââ 3. Polygon 1-min bars â AH move, PM move, run_day ââââââââââââââââââââ
    print(f"  Fetching Polygon bars ...", end="", flush=True)
    ah_move = None; pm_move = None; pm_high_val = None; run_day = 1
    try:
        if api_key:
            prev_date = (spike_dt - _td(days=1)).isoformat()
            prev2_date = (spike_dt - _td(days=2)).isoformat()

            def poly_bars(date_str):
                r = requests.get(
                    f"https://api.polygon.io/v2/aggs/ticker/{ticker.upper()}/range/1/minute/"
                    f"{date_str}/{date_str}?adjusted=true&sort=asc&limit=1000&apiKey={api_key}",
                    timeout=12)
                return r.json().get("results", []) if r.status_code == 200 else []

            # Prior day bars â AH move + detect if it was already elevated
            prev_bars = poly_bars(prev_date)
            rth_close = None; ah_last = None; prev_rth_high = None
            for b in prev_bars:
                etm = et_min(b["t"], prev_date)
                if 870 <= etm < 960:  # 14:30-16:00 RTH
                    rth_close = b["c"]
                    if prev_rth_high is None or b["h"] > prev_rth_high:
                        prev_rth_high = b["h"]
                if 960 <= etm <= 1200:  # 16:00-20:00 AH
                    ah_last = b["c"]

            if rth_close and ah_last:
                ah_move = round((ah_last - rth_close) / rth_close * 100, 2)
                result["ah_move_pct"] = str(ah_move)

            # Spike day bars â PM move, PM high, RTH open
            spike_bars = poly_bars(spike_date)
            pm_open_p = None; rth_open_p = None
            for b in spike_bars:
                etm = et_min(b["t"], spike_date)
                if 240 <= etm < 300 and pm_open_p is None:
                    pm_open_p = b["o"]
                if 240 <= etm < 570:
                    if pm_high_val is None or b["h"] > pm_high_val:
                        pm_high_val = b["h"]
                if 570 <= etm < 572 and rth_open_p is None:
                    rth_open_p = b["o"]

            if pm_open_p and rth_open_p:
                pm_move = round((rth_open_p - pm_open_p) / pm_open_p * 100, 2)
                result["pm_move_pct"] = str(pm_move)
            if pm_high_val:
                result["pm_high"] = str(round(pm_high_val, 4))

            # Run day detection â was price elevated yesterday too?
            if prev_rth_high and rth_open_p:
                # If spike open is > prior RTH high, this is a gap-up continuation
                prev2_bars = poly_bars(prev2_date)
                prev2_close = None
                for b in prev2_bars:
                    etm = et_min(b["t"], prev2_date)
                    if 930 <= etm < 960: prev2_close = b["c"]
                if prev2_close and rth_close and rth_close > prev2_close * 1.15:
                    run_day = 2  # was already elevated previous day
                    if rth_open_p and rth_open_p > prev_rth_high * 1.10:
                        run_day = 3  # gap-up on top of already-elevated day
            result["run_day"] = str(run_day)

            print(f" {GRN}done{RESET} (AH={ah_move}%  PM={pm_move}%  run_day={run_day})")
        else:
            print(f" {YEL}no API key{RESET}")
    except Exception as e:
        print(f" {YEL}Polygon bars: {e}{RESET}")

    # ââ 4. Derive ALL remaining fields from data already collected ââââââââââââ
    # Pull auto-filled OHLCV values from new_row (set by _auto_fetch_ohlcv)
    # These will be in result dict after ohlcv step runs before us
    wick   = flt(result.get("wick_ratio", 0))
    move   = flt(result.get("intraday_move_pct", 0))
    vol_r  = flt(result.get("vol_ratio", 0))
    gap    = flt(result.get("gap_pct", 0))
    ah     = flt(result.get("ah_move_pct") or ah_move or 0)
    pm     = flt(result.get("pm_move_pct") or pm_move or 0)
    ret_d1 = flt(result.get("ret_d1", 0))

    # ââ Structure quality (from market_condition_classifier logic) ââââââââââââ
    vwap_held = ah >= 0 and pm >= 0  # proxy: if AH+PM both held, VWAP likely held
    if not vwap_held and wick >= 0.65 and vol_r > 10 and move > 50:
        structure = "BLOW_OFF_TOP"
    elif vwap_held and wick < 0.25 and vol_r > 5:
        structure = "STRONG_HOLD"
    elif move > 200 and vol_r > 20 and wick > 0.40:
        structure = "LIQUIDITY_TRAP"
    else:
        structure = "WEAK_HOLD"
    result.setdefault("structure_quality", structure)

    # ââ Trap type âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if wick >= 0.80 and move > 40:
        trap = "OPEN_DUMP"
    elif pm < -10 and ah < -10:
        trap = "PM_FADE"
    elif ret_d1 and ret_d1 < -10:
        trap = "DELAYED_FADE"
    else:
        trap = "UNCLEAR"
    result.setdefault("trap_type", trap)

    # ââ Liquidity flag ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if ah < -10 or pm < -15:
        liq = "PM_SELL_PRESSURE"
    elif ah > 10 and vol_r < 20:
        liq = "THIN_AH_SPIKE"
    else:
        liq = "BALANCED"
    result.setdefault("liquidity_flag", liq)

    # ââ Gap context âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if ah < -15:
        gap_ctx = "MEAN_REVERSION_SETUP"
    elif ah > 20 or gap > 150:
        gap_ctx = "OVEREXTENDED_AH"
    else:
        gap_ctx = "FAIR_VALUE_GAP"
    result.setdefault("gap_context", gap_ctx)

    # ââ Market regime (from market_condition_classifier.derive_market_regime) ââ
    rd = int(result.get("run_day", run_day) or 1)
    if sameday_424 or (prior_424 >= 1 and structure == "BLOW_OFF_TOP"):
        regime = "DILUTION_DUMP"
    elif has_8k and not sameday_424 and structure in ("STRONG_HOLD", "WEAK_HOLD"):
        regime = "NEWS_CONTINUATION"
    elif float_shares > 0 and float_shares < 5_000_000 and move > 100 and not sameday_424:
        regime = "LOW_FLOAT_PARABOLIC"
    elif rd >= 2 and wick > 0.70 and vol_r < 5:
        regime = "DEAD_CAT_BOUNCE"
    elif has_8k or (not sameday_424 and not has_s1):
        regime = "NEWS_CONTINUATION"
    else:
        regime = "DILUTION_DUMP"
    result.setdefault("market_regime", regime)

    # ââ Final type (S1=1 / S2=2) ââââââââââââââââââââââââââââââââââââââââââââââ
    # From assign_final_type logic in market_condition_classifier
    s1_score = 0; s2_score = 0
    if sameday_424: s1_score += 4
    if prior_424 >= 3: s1_score += 3
    if structure == "BLOW_OFF_TOP": s1_score += 3
    if wick >= 0.65: s1_score += 2
    if ah < -10: s1_score += 3
    if ah < -30: s1_score += 4
    if pm < -15: s1_score += 2
    if liq == "PM_SELL_PRESSURE": s1_score += 2
    if regime == "DILUTION_DUMP": s1_score += 3

    if structure == "STRONG_HOLD": s2_score += 4
    if ah > 0: s2_score += 2
    if ah > 15: s2_score += 3
    if wick < 0.30: s2_score += 3
    if has_8k and not sameday_424: s2_score += 3
    if regime == "NEWS_CONTINUATION": s2_score += 3
    if vol_r > 200: s2_score += 2
    if float_shares > 50_000_000: s2_score += 2
    if prior_424 == 0 and not has_s1: s2_score += 2

    final_type = "1" if s1_score > s2_score else "2"
    conf = min(95, 50 + abs(s1_score - s2_score) * 5)
    result.setdefault("final_type", final_type)

    # ââ Outcome profile (only if ret_d1 known) ââââââââââââââââââââââââââââââââ
    if ret_d1:
        if ret_d1 < -15: outcome = "DUMP"
        elif ret_d1 < -5: outcome = "FADE"
        elif ret_d1 > 15: outcome = "CONTINUATION"
        elif ret_d1 > 5:  outcome = "BOUNCE"
        else:              outcome = "CHOP"
        result.setdefault("outcome_profile", outcome)
    else:
        result.setdefault("outcome_profile", "PENDING")

    # ââ Auto reasoning ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    parts = []
    if sameday_424: parts.append("same-day 424B5")
    if prior_424 > 0: parts.append(f"{prior_424} prior offerings")
    if wick >= 0.65: parts.append(f"wick={wick:.2f}")
    if ah < -10: parts.append(f"AH={ah:.1f}%")
    if structure == "BLOW_OFF_TOP": parts.append("blowoff top")
    if has_8k: parts.append("8-K catalyst")
    if run_day >= 3: parts.append(f"day {run_day} of run")
    parts.append(f"auto-classified {regime} S{'1' if final_type=='1' else '2'} conf={conf}%")
    result.setdefault("reasoning", " Â· ".join(parts))

    return result


def cmd_add_ticker(ticker: str, date: str, path: str = DEFAULT_CSV, api_key: str = None):
    """
    Add a new ticker+date row.
    Auto-fetches OHLCV from yfinance, then prompts ONLY for fields
    that need human judgment (regime, dilution, intent, filings etc).
    After adding, use --update to fill any remaining fields.
    """
    rows, cols = load_csv(path)

    # Check duplicate
    dup = [r for r in rows if r["ticker"].upper()==ticker.upper() and r["spike_date"]==date]
    if dup:
        print(f"{YEL}â  {ticker} {date} already exists â use --update to change fields{RESET}")
        return

    print(f"\n{BOLD}Adding {ticker.upper()} {date}{RESET}")

    new_row = {c: "" for c in cols}
    new_row["ticker"]     = ticker.upper()
    new_row["spike_date"] = date

    # ââ Step 1: Auto-fetch OHLCV ââââââââââââââââââââââââââââââââââââââââââââââ
    print(f"  Fetching price data from yfinance ...", end="", flush=True)
    auto = _auto_fetch_ohlcv(ticker, date, api_key=api_key)
    if auto:
        for k, v in auto.items():
            if v != "":
                new_row[k] = str(v)
        print(f" done")
        print(f"  {DIM}Auto-filled: open={new_row.get('price_d0_open')}  "
              f"high={new_row.get('price_d0_high')}  "
              f"close={new_row.get('price_d0_close')}  "
              f"vol_ratio={new_row.get('vol_ratio')}Ã  "
              f"ret_d1={new_row.get('ret_d1')}%{RESET}")
    else:
        print(f" skipped (fill manually with --update)")

    # ââ Step 1.5: Auto-populate ALL fields â no prompts âââââââââââââââââââââ
    auto_context = _auto_fetch_context(ticker, date, api_key)
    if auto_context:
        for k, v in auto_context.items():
            if v not in ("", None):
                new_row[k] = str(v)
        filled = [k for k, v in auto_context.items() if v not in ("", None)]
        print(f"  {DIM}Auto-filled {len(filled)} fields: {', '.join(filled)}{RESET}")
    else:
        print(f"  {YEL}Context fetch returned nothing â row saved with OHLCV only{RESET}")


    # ââ All fields auto-filled above â no manual prompts ââââââââââââââââââ

    # Set derived fields
    if new_row.get("final_type") == "1":
        new_row["trade_bias"] = "SHORT"
        new_row["micro_source"] = "daily"
        new_row["edgar_source"] = "CIK"
    elif new_row.get("final_type") == "2":
        new_row["trade_bias"] = "LONG_WATCH"
        new_row["micro_source"] = "daily"
        new_row["edgar_source"] = "CIK"

    rows.append(new_row)
    save_csv(rows, cols, path)

    print(f"\n  {GRN}â {ticker.upper()} {date} added to CSV{RESET}")
    print(f"  Fill remaining fields any time with:")
    print(f"  {DIM}python cat5ive_sim.py --update {ticker.upper()} {date} FIELD VALUE{RESET}")
    print(f"  Then replay:  python cat5ive_sim.py --replay {ticker.upper()} {date}")

def cmd_remove_ticker(ticker: str, date: str, path: str = DEFAULT_CSV):
    """Remove a ticker+date row from the CSV."""
    rows, cols = load_csv(path)
    before = len(rows)
    rows = [r for r in rows if not (r["ticker"].upper()==ticker.upper() and r["spike_date"]==date)]
    if len(rows) == before:
        print(f"{YEL}Not found: {ticker} {date}{RESET}")
        return
    save_csv(rows, cols, path)
    print(f"{GRN}â Removed {ticker.upper()} {date} ({before - len(rows)} row deleted){RESET}")

def cmd_update_field(ticker: str, date: str, field_name: str, value: str, path: str = DEFAULT_CSV):
    """Update a single field for a ticker+date row."""
    rows, cols = load_csv(path)
    found = False
    for r in rows:
        if r["ticker"].upper()==ticker.upper() and r["spike_date"]==date:
            old = r.get(field_name, "")
            r[field_name] = value
            found = True
            print(f"{GRN}â {ticker} {date} Â· {field_name}: {old!r} â {value!r}{RESET}")
    if not found:
        print(f"{YEL}Not found: {ticker} {date}{RESET}")
        return
    save_csv(rows, cols, path)

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# BAR STREAM â fetch + cache Polygon 1-min bars
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _polygon_fetch_bars(ticker: str, date_str: str, api_key: str) -> list:
    """Fetch 1-min bars from Polygon. Returns raw bar list."""
    if not HAS_REQUESTS:
        return []

    date_dt = datetime.strptime(date_str, "%Y-%m-%d")
    to_str  = (date_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    url     = f"https://api.polygon.io/v2/aggs/ticker/{ticker.upper()}/range/1/minute/{date_str}/{to_str}"
    params  = {"adjusted":"true","sort":"asc","limit":50000,
                "extended_hours":"true","apiKey":api_key}
    try:
        time.sleep(0.25)
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        if data.get("status") in ("OK","DELAYED"):
            return data.get("results", [])
    except Exception as e:
        print(f"{YEL}Polygon error: {e}{RESET}")
    return []

def _yfinance_fallback_bars(ticker: str, date_str: str) -> list:
    """Fallback: yfinance 1-min bars (RTH only, limited history)."""
    if not HAS_YF:
        return []
    try:
        tk   = yf.Ticker(ticker)
        date_dt = datetime.strptime(date_str, "%Y-%m-%d")
        end_dt  = date_dt + timedelta(days=1)
        df   = tk.history(start=date_str, end=end_dt.strftime("%Y-%m-%d"),
                          interval="1m", prepost=True)
        if df.empty:
            return []
        bars = []
        for ts, row in df.iterrows():
            ts_ms = int(ts.timestamp() * 1000)
            bars.append({"t":ts_ms,"o":float(row["Open"]),"h":float(row["High"]),
                         "l":float(row["Low"]),"c":float(row["Close"]),"v":int(row["Volume"])})
        return bars
    except Exception:
        return []

def load_bar_stream(ticker: str, date_str: str, api_key: str = None,
                    avg_20d_vol: float = 0, prior_close: float = 0) -> list[Bar]:
    """
    Load 1-min bars for ticker+date. Uses cache if available.
    Returns list of Bar objects sorted by ts_ms, filtered to date only.
    """
    _ensure_dirs()
    cache_file = os.path.join(BARS_CACHE, f"{ticker.upper()}_{date_str}_1min.json")

    # Load from cache
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            raw = json.load(f)
        print(f"  {DIM}[bars] loaded {len(raw)} bars from cache{RESET}")
    else:
        # Fetch from Polygon
        key = api_key or os.environ.get("POLYGON_API_KEY")
        if key:
            print(f"  {DIM}[bars] fetching from Polygon ...{RESET}", end="", flush=True)
            raw = _polygon_fetch_bars(ticker, date_str, key)
            print(f" {len(raw)} bars")
        else:
            print(f"  {YEL}[bars] no Polygon key â trying yfinance fallback ...{RESET}", end="", flush=True)
            # Windows tip printed only once per session
            if not os.environ.get("_CAT5_KEY_TIP_SHOWN"):
                os.environ["_CAT5_KEY_TIP_SHOWN"] = "1"
                print(f"\n  {DIM}Tip (Windows): python cat5ive_sim.py --set-key YOUR_KEY{RESET}", flush=True)
                print(f"  ", end="", flush=True)
            raw = _yfinance_fallback_bars(ticker, date_str)
            print(f" {len(raw)} bars")

        if raw:
            with open(cache_file, "w") as f:
                json.dump(raw, f)

    if not raw:
        print(f"  {RED}No bar data available for {ticker} {date_str}{RESET}")
        return []

    # Convert to Bar objects, filter to spike date only
    bars_out = []
    idx = 0
    session_open = prior_close if prior_close > 0 else 0
    cum_vol = 0
    cum_vwp = 0.0
    rth_high_so_far = 0.0
    rth_low_so_far  = float("inf")
    rth_open_price  = None

    cum_vol_rth  = 0; cum_vwp_rth  = 0.0  # RTH-only VWAP accumulators
    prev_sess    = "OVERNIGHT"              # tracks session transitions
    pm_open_price = None                   # first PM bar open
    pm_high_so_far = None                  # PM session high

    for raw_bar in raw:
        ts_ms = raw_bar.get("t", 0)
        et_str, dt_et, mins = _ms_to_et(ts_ms)
        if dt_et.strftime("%Y-%m-%d") != date_str:
            continue
        sess = _session(mins)
        if sess == "OVERNIGHT":
            continue

        o = float(raw_bar.get("o", 0))
        h = float(raw_bar.get("h", 0))
        l = float(raw_bar.get("l", 0))
        c = float(raw_bar.get("c", 0))
        v = int(raw_bar.get("v", 0))

        # Track session open for each session (PM, RTH, AH) separately
        if sess != prev_sess:
            session_open = o  # first bar of any new session sets the open
        if sess == "RTH":
            if rth_open_price is None:
                rth_open_price = o
            rth_high_so_far = max(rth_high_so_far, h)
            rth_low_so_far  = min(rth_low_so_far, l)
        elif sess == "PRE_MARKET":
            if pm_open_price is None:
                pm_open_price = o
            pm_high_so_far = max(pm_high_so_far, h) if pm_high_so_far else h

        # VWAP â reset at RTH open so RTH VWAP is clean and not biased by PM vol
        if sess == "RTH" and prev_sess != "RTH":
            # Transition into RTH â reset VWAP accumulator
            cum_vol_rth = 0; cum_vwp_rth = 0.0
        cum_vol += v
        vw = float(raw_bar.get("vw", c))
        cum_vwp += vw * v
        # RTH VWAP uses RTH-only accumulator; PM/AH use session accumulator
        if sess == "RTH":
            cum_vol_rth += v
            cum_vwp_rth += vw * v
            vwap_run = cum_vwp_rth / cum_vol_rth if cum_vol_rth > 0 else c
        else:
            vwap_run = cum_vwp / cum_vol if cum_vol > 0 else c

        vol_ratio_run = cum_vol / avg_20d_vol if avg_20d_vol > 0 else 0.0

        # Running wick â tracks from session open (PM or RTH)
        # PM bars get wick vs PM open so S1/S2 scorer has data before 9:30
        wick_run = 0.0
        if session_open and session_open > 0:
            day_high = rth_high_so_far if sess == "RTH" else max(h, session_open)
            if day_high > session_open:
                wick_run = (day_high - c) / (day_high - session_open)
                wick_run = max(0.0, min(1.0, round(wick_run, 3)))

        # Intraday move
        intra = 0.0
        if prior_close > 0 and rth_high_so_far > 0:
            intra = round((rth_high_so_far - prior_close) / prior_close * 100, 2)

        bar = Bar(
            ts_ms=ts_ms, ts_et=et_str,
            ts_et_full=dt_et.strftime("%Y-%m-%d %H:%M"),
            session=sess, bar_index=idx,
            open=o, high=h, low=l, close=c, volume=v,
            high_so_far=rth_high_so_far,
            low_so_far=rth_low_so_far if rth_low_so_far < float("inf") else l,
            cum_volume=cum_vol,
            vwap_running=round(vwap_run, 4),
            vol_ratio_running=round(vol_ratio_run, 2),
            wick_running=wick_run,
            intraday_move_pct=intra,
        )
        bars_out.append(bar)
        prev_sess = sess
        idx += 1

    print(f"  {DIM}[bars] {len(bars_out)} bars ready "
          f"(PM={sum(1 for b in bars_out if b.session=='PRE_MARKET')} "
          f"RTH={sum(1 for b in bars_out if b.session=='RTH')} "
          f"AH={sum(1 for b in bars_out if b.session=='AFTER_HOURS')}){RESET}")
    return bars_out

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# WINDOW ENFORCER â field availability by time
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def get_field_mask(bar: Bar, static: dict) -> dict:
    """
    Returns dict of field values available at bar's timestamp.
    Fields not yet visible return None â their scoring contribution is suppressed.
    """
    mins = int(bar.ts_et.replace(":","")[:2]) * 60 + int(bar.ts_et[3:5])

    mask = {}

    # ââ WINDOW 1: always available (static pre-spike) âââââââââââââââââââââââââ
    for f in ["run_day","prior_offerings_12m","market_regime","company_intent",
              "dilution_status","tier1_filings","float_shares","insider_144_pre_spike",
              "supply_overhang","liquidity_flag"]:
        mask[f] = static.get(f)

    # ââ WINDOW 2: AH + PM data â all knowable before 9:30am âââââââââââââââââ
    if bar.session in ("PRE_MARKET", "RTH", "AFTER_HOURS"):
        mask["ah_move_pct"]   = _flt(static.get("ah_move_pct"), None)
        mask["pm_move_pct"]   = _flt(static.get("pm_move_pct"), None)
        mask["pm_high"]       = _flt(static.get("pm_high"), None)
        mask["pm_vol_ratio"]  = _flt(static.get("pm_vol_ratio"), None)
        mask["gap_context"]   = static.get("gap_context")
        mask["move_phase"]    = static.get("move_phase")     # early/mid/late vs prior days
        # ââ FINRA short vol (available as of prior close, published nightly) â
        mask["short_vol_ratio"]         = _flt(static.get("short_vol_ratio"), None)
        mask["baseline_short_vol_ratio"]= _flt(static.get("baseline_short_vol_ratio"), None)
        mask["abnormal_short_ratio"]    = _flt(static.get("abnormal_short_ratio"), None)
        mask["short_vol_classification"]= static.get("short_vol_classification", "UNKNOWN")
    else:
        mask["ah_move_pct"]   = None
        mask["pm_move_pct"]   = None
        mask["pm_high"]       = None
        mask["pm_vol_ratio"]  = None
        mask["gap_context"]   = None
        mask["move_phase"]    = None

    # ââ WINDOW 3: Live data â computed bar by bar (RTH + PM now both active) ââ
    if bar.session == "RTH":
        mask["vol_ratio"]         = bar.vol_ratio_running
        mask["vol_ratio_static"]  = _flt(static.get("vol_ratio"), 0)
        mask["vwap_held"]         = bar.close >= bar.vwap_running
        mask["wick_ratio"]        = bar.wick_running
        mask["intraday_move_pct"] = bar.intraday_move_pct
        if mins >= W1_CLOSE_MIN:
            mask["imbalance_w1open"] = _flt(static.get("imbalance_w1open"), None)
        else:
            mask["imbalance_w1open"] = None
        if mins >= LARGE_PRINT_MIN:
            mask["large_print_zone"] = static.get("large_print_zone")
        else:
            mask["large_print_zone"] = None

    elif bar.session == "PRE_MARKET":
        # PM bars now carry live signal data â no more RTH-only bias
        # S1/S2 classification can lock in before 9:30am
        static_vol = _flt(static.get("vol_ratio"), 0)
        mask["vol_ratio"]         = bar.vol_ratio_running if bar.vol_ratio_running > 0 else static_vol
        mask["vol_ratio_static"]  = static_vol
        mask["vwap_held"]         = (bar.close >= bar.vwap_running
                                     if bar.vwap_running > 0 else None)
        mask["wick_ratio"]        = bar.wick_running if bar.wick_running > 0 else None
        mask["intraday_move_pct"] = bar.intraday_move_pct
        if bar.vwap_running > 0:
            if bar.close < bar.vwap_running and (bar.wick_running or 0) >= 0.50:
                mask["price_structure_live"] = "weakness"
            elif bar.close >= bar.vwap_running and (bar.wick_running or 0) < 0.25:
                mask["price_structure_live"] = "strength"
            else:
                mask["price_structure_live"] = "mixed"
        else:
            mask["price_structure_live"] = None
        mask["imbalance_w1open"]  = None
        mask["large_print_zone"]  = None

        # Live body ratio (open-to-now partial)
        bar_range = bar.high_so_far - bar.low_so_far
        mask["body_ratio_live"] = round(abs(bar.close - bar.open) / bar_range, 3) if bar_range > 0 else 0.0

        # Live price structure (weakness/strength/mixed) â derivable ~9:45am
        if bar.vwap_running > 0 and bar.wick_running > 0:
            if bar.close < bar.vwap_running and bar.wick_running >= 0.65:
                mask["price_structure_live"] = "weakness"
            elif bar.close >= bar.vwap_running and bar.vol_ratio_running < 200:
                mask["price_structure_live"] = "strength"
            else:
                mask["price_structure_live"] = "mixed"
        else:
            mask["price_structure_live"] = None

        # PM_FADE visible at 9:30 open (opened below PM high)
        pm_h = _flt(static.get("pm_high"), None)
        if pm_h and pm_h > 0 and bar.open < pm_h:
            mask["trap_type_live"] = "PM_FADE"
        else:
            mask["trap_type_live"] = None

        # ââ VPIN: computed from static (pre-computed by enrich_static_fields) â
        # vpin_open, vpin_regime etc are available once enrich_static_fields()
        # has been called before building the timeline
        mask["vpin_open"]      = _flt(static.get("vpin_open"), None)
        mask["vpin_regime"]    = static.get("vpin_regime", "UNKNOWN")
        mask["vpin_s1_delta"]  = _flt(static.get("vpin_s1_delta"), 0.0)
        mask["vpin_signal"]    = static.get("vpin_signal", "")
        mask["lambda_regime"]  = static.get("lambda_regime", "UNKNOWN")
        mask["lambda_signal"]  = static.get("lambda_signal", "NEUTRAL")
    else:
        # Not in RTH yet â use static vol_ratio estimate for disqualifier gates
        # (running vol_ratio is 0 pre-RTH; static vol_ratio is the final daily value,
        # but it's the best proxy available pre-market for float gate decisions)
        static_vol = _flt(static.get("vol_ratio"), 0)
        mask["vol_ratio"]         = static_vol if static_vol > 0 else bar.vol_ratio_running
        mask["vol_ratio_static"]  = static_vol
        mask["vwap_held"]         = None
        mask["wick_ratio"]        = None
        mask["intraday_move_pct"] = bar.intraday_move_pct
        mask["imbalance_w1open"]  = None
        mask["large_print_zone"]  = None
        mask["body_ratio_live"]       = None
        mask["price_structure_live"]  = None
        mask["trap_type_live"]        = None
        # VPIN + lambda from static enrichment â available in all sessions
        mask["vpin_open"]      = _flt(static.get("vpin_open"), None)
        mask["vpin_regime"]    = static.get("vpin_regime", "UNKNOWN")
        mask["vpin_s1_delta"]  = _flt(static.get("vpin_s1_delta"), 0.0)
        mask["vpin_signal"]    = static.get("vpin_signal", "")
        mask["lambda_regime"]  = static.get("lambda_regime", "UNKNOWN")
        mask["lambda_signal"]  = static.get("lambda_signal", "NEUTRAL")
        mask["short_vol_ratio"]          = _flt(static.get("short_vol_ratio"), None)
        mask["baseline_short_vol_ratio"] = _flt(static.get("baseline_short_vol_ratio"), None)
        mask["abnormal_short_ratio"]     = _flt(static.get("abnormal_short_ratio"), None)
        mask["short_vol_classification"] = static.get("short_vol_classification", "UNKNOWN")

    # ââ Not available until D+1 âââââââââââââââââââââââââââââââââââââââââââââââ
    # Forward returns (ret_d1, ret_d5) are NEVER exposed in pre-fall scoring
    mask["ret_d1"] = None
    mask["ret_d5"] = None

    return mask

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# SCORE ENGINE â recompute pre-fall score + S1/S2 from mask
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _safe(mask: dict, key, default=None):
    v = mask.get(key)
    return v if v is not None else default

def compute_score(mask: dict, prev_score: int = 0) -> ScoreResult:
    """
    Recompute full pre-fall score and S1/S2 scorer from field mask.
    None fields contribute 0 and are logged as suppressed.
    """
    score  = 0
    active = []
    suppressed = []
    disqs  = []

    run    = _int(mask.get("run_day"), 1)
    prior  = _int(mask.get("prior_offerings_12m"), 0)
    regime = _safe(mask, "market_regime", "")
    intent = _safe(mask, "company_intent", "")
    dil    = _safe(mask, "dilution_status", "")
    tier1  = _safe(mask, "tier1_filings", "")
    liq    = _safe(mask, "liquidity_flag", "")
    # ah: None means not yet available. Otherwise coerce to float.
    _ah_raw = mask.get("ah_move_pct")
    ah     = _flt(_ah_raw, None) if _ah_raw is not None else None
    supply = _safe(mask, "supply_overhang", "")
    insider= str(_safe(mask,"insider_144_pre_spike","")).lower() == "true"
    _fs    = mask.get("float_shares")
    floatsh= _flt(_fs, None) if _fs is not None else None
    _vs    = mask.get("vol_ratio_static") or mask.get("vol_ratio")
    vol    = _flt(_vs, 0)         # for float gate (uses static daily value)
    vol_run= _flt(mask.get("vol_ratio"), 0)  # running RTH cumulative
    vwap_h = mask.get("vwap_held")
    _wr    = mask.get("wick_ratio")
    wick   = _flt(_wr, None) if _wr is not None else None
    move   = _flt(mask.get("intraday_move_pct"), 0)
    _imb   = mask.get("imbalance_w1open")
    imb    = _flt(_imb, None) if _imb is not None else None
    lp_zone= _safe(mask, "large_print_zone", "")

    # ââ HARD DISQUALIFIERS ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if floatsh is not None and floatsh > 50_000_000 and vol < 50:
        score -= 15
        disqs.append(f"LARGE_FLOAT_LOW_VOL: {floatsh/1e6:.0f}M float + {vol:.0f}x â â15")

    if floatsh is not None and floatsh > 100_000_000 and vol < 100:
        score -= 10
        disqs.append(f"VERY_LARGE_FLOAT: {floatsh/1e6:.0f}M â â10")

    if ah is not None and ah > 20:
        score -= 12
        disqs.append(f"AH_POSITIVE: +{ah:.0f}% â â12")
    elif ah is None:
        suppressed.append("AH_POSITIVE_check (AH data not yet available)")

    if prior == 1 and dil == "squeeze":
        score -= 8
        disqs.append("PRIOR1_SQUEEZE â â8")

    if prior == 0 and intent == "clean" and ah is not None and ah > 5:
        score -= 10
        disqs.append("CLEAN_FRESH_AH_POS â â10")

    # ââ OVERRIDE SIGNALS ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if run >= 3:
        score += 40
        active.append(Signal("DAY3_EXHAUSTION", 40, 1))

    if ah is not None:
        if ah < -30:
            score += 35
            active.append(Signal("AH_REVERSAL_TRAP", 35, 2))
        elif -30 <= ah < -10:
            score += 10
            active.append(Signal("AH_NEGATIVE", 10, 2))
    else:
        suppressed.append("AH_REVERSAL_TRAP (AH data not yet available)")

    if prior >= 6:
        score += 30
        active.append(Signal("SERIAL_HEAVY", 30, 1))

    if prior >= 3 and regime == "DILUTION_DUMP":
        score += 25
        active.append(Signal("PRIOR3+DILUTION", 25, 1))

    # ââ STRONG SIGNALS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if "424B" in str(tier1):
        score += 15
        active.append(Signal("424B5_ACTIVE", 15, 1))

    if intent == "serial_diluter" and prior >= 2:
        score += 12
        active.append(Signal(f"SERIAL+PRIOR{prior}", 12, 1))

    if regime == "DILUTION_DUMP":
        score += 10
        active.append(Signal("DILUTION_DUMP", 10, 1))

    if liq == "PM_SELL_PRESSURE":
        score += 10
        active.append(Signal("PM_SELL_PRESSURE", 10, 1))

    if supply == "YES" and run >= 2:
        score += 8
        active.append(Signal("SUPPLY_OVERHANG", 8, 1))

    if insider:
        score += 8
        active.append(Signal("INSIDER_144", 8, 1))

    if prior == 2:
        score += 5
        active.append(Signal("PRIOR_2", 5, 1))

    if regime == "DEAD_CAT_BOUNCE":
        score += 8
        active.append(Signal("DEAD_CAT", 8, 1))

    score = max(0, score)

    # ââ S1/S2 SCORER (runs independently of pre-fall score) âââââââââââââââââââ
    s1 = 0.0; s2 = 0.0

    if vwap_h is False:
        s1 += 3.0
        active.append(Signal("VWAP_FAIL_S1", 3.0, 3))
    elif vwap_h is None:
        suppressed.append("VWAP_fail check (not in RTH yet)")

    if run >= 3:          s1 += 4.0   # already in active from override block above

    if wick is not None and wick >= 0.65:
        s1 += 2.0
        active.append(Signal(f"WICK_{wick:.2f}", 2.0, 3))
    elif wick is None:
        suppressed.append("wick_ratio (RTH bars not started)")

    # ââ W2 signals: knowable pre-market ââââââââââââââââââââââââââââââââââââââ
    pm_move = _flt(mask.get("pm_move_pct"), None)
    gc      = _safe(mask, "gap_context", "")
    mp      = _safe(mask, "move_phase", "")
    pm_hi   = _flt(mask.get("pm_high"), None)
    pm_vr   = _flt(mask.get("pm_vol_ratio"), None)

    if pm_move is not None and pm_move < -15:
        s1 += 1.5
        active.append(Signal("PM_FADE_MOVE", 1.5, 2))
    elif pm_move is None:
        suppressed.append("pm_move_pct (PM session not yet complete)")

    if gc == "MEAN_REVERSION_SETUP":
        s1 += 1.5
        active.append(Signal("MEAN_REVERSION_GAP", 1.5, 2))
    elif gc == "OVEREXTENDED_AH":
        s2 += 1.0
        active.append(Signal("OVEREXTENDED_AH_S2", 1.0, 2))  # S2 lean signal

    if mp == "late":
        s1 += 1.0
        active.append(Signal("LATE_PHASE", 1.0, 1))   # W1 â derivable from run_day + prior

    # ââ W3 live-derived signals âââââââââââââââââââââââââââââââââââââââââââââââ
    ps_live   = _safe(mask, "price_structure_live", "")
    trap_live = _safe(mask, "trap_type_live", "")
    br_live   = _flt(mask.get("body_ratio_live"), None)

    if ps_live == "weakness":
        s1 += 1.5
        active.append(Signal("LIVE_WEAKNESS", 1.5, 3))
    elif ps_live == "strength":
        s2 += 1.0
        active.append(Signal("LIVE_STRENGTH", 1.0, 3))
    elif ps_live is None:
        suppressed.append("price_structure_live (RTH not started)")

    if trap_live == "PM_FADE":
        s1 += 1.5
        active.append(Signal("PM_FADE_CONFIRMED", 1.5, 3))
    elif trap_live is None and mask.get("vwap_held") is not None:
        suppressed.append("trap_type_live (needs PM high data)")

    if br_live is not None and br_live < 0.25:
        s1 += 1.0   # tiny body = wick dominant = reversal candle
        active.append(Signal(f"SMALL_BODY_{br_live:.2f}", 1.0, 3))

    # ââ VPIN signals (W3 â requires Polygon bars to have been processed) ââââââ
    vpin_delta = _flt(mask.get("vpin_s1_delta"), 0.0)
    vpin_sig   = _safe(mask, "vpin_signal", "")
    vpin_reg   = _safe(mask, "vpin_regime", "UNKNOWN")

    if vpin_delta != 0.0 and vpin_sig and "UNAVAILABLE" not in vpin_sig and "MISSING" not in vpin_sig:
        if vpin_delta > 0:
            s1 += vpin_delta
            active.append(Signal(vpin_sig, vpin_delta, 3))
        else:
            s2 += abs(vpin_delta)   # low VPIN â S2 lean
            active.append(Signal(vpin_sig, vpin_delta, 3))
    elif vpin_reg == "UNKNOWN":
        suppressed.append("VPIN (finra_loader.py not present or bars not yet loaded)")

    # ââ FINRA short vol signals (W2 â available pre-market) ââââââââââââââââââ
    svr  = mask.get("short_vol_ratio")     # spike day short/total ratio
    svr_abn = mask.get("abnormal_short_ratio")
    svc  = _safe(mask, "short_vol_classification", "UNKNOWN")

    if svr is not None:
        if svc == "INSTITUTIONAL_LOADING" or (svr_abn and svr_abn >= 1.5 and svr >= 0.55):
            # Majority-short spike = institutions distributing into the move = S1
            s1 += 2.5
            active.append(Signal(f"INSTITUTIONAL_SHORT_LOAD_{svr:.2f}", 2.5, 2))
        elif svc == "THIN_SHORT" or svr <= 0.30:
            # Low short participation = retail FOMO buying = S2 lean
            s2 += 2.0
            active.append(Signal(f"THIN_SHORT_PARTICIPATION_{svr:.2f}", 2.0, 2))
        elif svc == "BELOW_NORMAL_SHORT" and svr_abn and svr_abn < 0.7:
            # Fewer shorts than normal for this ticker = S2 lean
            s2 += 1.0
            active.append(Signal(f"BELOW_NORMAL_SHORT_{svr:.2f}", 1.0, 2))
    else:
        suppressed.append("short_vol_ratio (FINRA data not fetched â run finra_loader.py)")

    # ââ Kyle's Lambda regime (W3) âââââââââââââââââââââââââââââââââââââââââââââ
    lam_sig = _safe(mask, "lambda_signal", "NEUTRAL")
    lam_reg = _safe(mask, "lambda_regime", "UNKNOWN")
    if lam_sig == "S1_THIN":
        s1 += 1.5
        active.append(Signal(f"THIN_BOOK_LAMBDA_{lam_reg}", 1.5, 3))
    elif lam_sig == "S2_THICK":
        s2 += 1.0
        active.append(Signal(f"THICK_BOOK_LAMBDA_{lam_reg}", 1.0, 3))
    elif lam_reg == "UNKNOWN" and mask.get("vwap_held") is not None:
        suppressed.append("kyle_lambda (computed from RTH bars â updates each bar)")

    if liq == "PM_SELL_PRESSURE":          s1 += 1.0
    if dil == "offering":                  s1 += 1.0
    if vol_run < 200 and vol_run > 0:      s1 += 1.0  # uses running vol_ratio

    if ah is not None and ah < -30:        s1 += 5.0
    elif ah is not None and ah < -10:      s1 += 3.5

    if imb is not None and imb <= -0.65:   s1 += 2.0
    elif imb is None:                      suppressed.append("imbalance_w1open (W1 window not closed yet)")

    if lp_zone == "BELOW_VWAP":            s1 += 2.0
    elif lp_zone == "" or lp_zone is None: suppressed.append("large_print_zone (9:45am not reached)")

    if insider:                            s1 += 2.5

    # S2 signals
    if vwap_h is True:                     s2 += 5.0
    if vol >= 200:                         s2 += 3.0
    if dil == "squeeze":                   s2 += 2.0
    if prior == 1:                         s2 += 3.0
    if imb is not None and imb >= 0.65:    s2 += 3.0

    # Move and structure from static fields (already known)
    struct = mask.get("structure_quality", "")
    if struct == "WEAK_HOLD":
        s2 += 2.0
    elif struct == "STRONG_HOLD":
        # STRONG_HOLD_TRAP: 100% S1 in dataset when no Tier1 catalyst
        # Still adds to S2 because it looks like S2 until VWAP fails next day
        s2 += 2.0
        active.append(Signal("STRONG_HOLD_WATCH", 0, 1))  # marker â check for trap
    elif struct == "LIQUIDITY_TRAP":
        s1 += 2.0   # 100% S1 in dataset (n=3)
        active.append(Signal("LIQUIDITY_TRAP", 2.0, 3))
    elif struct == "BLOW_OFF_TOP" and move >= 200:
        s2 += 2.0   # extreme extension â delayed dump

    # Section decision â require margin >= 1.5 to flip (reduces noise near VWAP)
    raw_section = "S1" if s1 >= s2 else "S2"
    # Only flip if the margin is meaningful
    if abs(s1 - s2) >= 1.5:
        section = raw_section
    else:
        section = "S1"  # tie + near-tie â default lower risk
    conf    = min(95, int(50 + abs(s1 - s2) * 5))

    tier = _tier(score)
    return ScoreResult(
        pre_fall_score=score, pre_fall_tier=tier,
        s1_score=round(s1, 1), s2_score=round(s2, 1),
        section=section, confidence_pct=conf,
        active_signals=active, suppressed_signals=suppressed,
        disqualifiers=disqs, delta_from_prev=score - prev_score,
    )

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# EVENT DETECTOR â annotate key moments in the timeline
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def detect_events(timeline: list[BarState]) -> list[TimelineEvent]:
    events = []
    prev_tier    = None
    prev_section = None
    prev_score   = 0
    hod_price    = 0.0
    hod_set_bar  = 0
    vwap_broken  = False

    for state in timeline:
        bar  = state.bar
        res  = state.result
        mins = int(bar.ts_et[:2]) * 60 + int(bar.ts_et[3:5])

        # TIER_CHANGE
        if prev_tier and res.pre_fall_tier != prev_tier:
            events.append(TimelineEvent(
                bar_index=bar.bar_index, ts_et=bar.ts_et,
                event_type="TIER_CHANGE", price=bar.close,
                score_before=prev_score, score_after=res.pre_fall_score,
                signal_name="tier_change",
                description=f"{prev_tier} â {res.pre_fall_tier} (score {prev_score}â{res.pre_fall_score})"
            ))

        # SECTION_FLIP â only record when score is meaningful (not SKIP tier noise)
        if prev_section and res.section != prev_section and res.pre_fall_score >= 10:
            events.append(TimelineEvent(
                bar_index=bar.bar_index, ts_et=bar.ts_et,
                event_type="SECTION_FLIP", price=bar.close,
                score_before=prev_score, score_after=res.pre_fall_score,
                signal_name="section_flip",
                description=f"{prev_section} â {res.section}"
            ))

        # HOD formation and rejection (RTH only)
        if bar.session == "RTH":
            if bar.high_so_far > hod_price:
                hod_price   = bar.high_so_far
                hod_set_bar = bar.bar_index
            elif bar.bar_index > hod_set_bar + 5 and hod_set_bar > 0:
                # HOD formed 5+ bars ago and not extended â flag once
                if not any(e.event_type == "HOD_REJECTED" for e in events):
                    events.append(TimelineEvent(
                        bar_index=bar.bar_index, ts_et=bar.ts_et,
                        event_type="HOD_REJECTED", price=hod_price,
                        score_before=prev_score, score_after=res.pre_fall_score,
                        signal_name="hod_rejected",
                        description=f"HOD ${hod_price:.2f} held {bar.bar_index - hod_set_bar} bars â rejection confirmed"
                    ))

            # VWAP break (first time price closes below VWAP)
            if not vwap_broken and bar.vwap_running > 0 and bar.close < bar.vwap_running:
                vwap_broken = True
                events.append(TimelineEvent(
                    bar_index=bar.bar_index, ts_et=bar.ts_et,
                    event_type="VWAP_BREAK", price=bar.close,
                    score_before=prev_score, score_after=res.pre_fall_score,
                    signal_name="vwap_break",
                    description=f"First close below VWAP (${bar.vwap_running:.2f}) at {bar.ts_et}"
                ))

        # WICK thresholds
        # Wick threshold events â if wick >= 0.95 on first RTH bar, emit GAP_DOWN_OPEN instead
        first_rth = (bar.session == "RTH" and 
                     not any(e.event_type in ("WICK_THRESHOLD","GAP_DOWN_OPEN") for e in events))
        wick_thresholds_new = []
        for thresh in [0.65, 0.75, 0.85, 0.90, 0.95]:
            key = f"wick_{thresh}"
            if bar.wick_running >= thresh and not any(e.signal_name==key for e in events):
                wick_thresholds_new.append((thresh, key))

        # If all 5 thresholds fire on the same bar = gap-down open (wick=1.0 from bar 1)
        if len(wick_thresholds_new) >= 4 and bar.session == "RTH":
            events.append(TimelineEvent(
                bar_index=bar.bar_index, ts_et=bar.ts_et,
                event_type="GAP_DOWN_OPEN", price=bar.close,
                score_before=prev_score, score_after=res.pre_fall_score,
                signal_name="gap_down_open",
                description=f"Gap-down open â wick={bar.wick_running:.3f} from bar 1 (all thresholds immediate)"
            ))
            # Still log individual thresholds silently for CSV
            for thresh, key in wick_thresholds_new:
                events.append(TimelineEvent(
                    bar_index=bar.bar_index, ts_et=bar.ts_et,
                    event_type="WICK_THRESHOLD", price=bar.close,
                    score_before=prev_score, score_after=res.pre_fall_score,
                    signal_name=key,
                    description=f"Wick crossed {thresh} ({bar.wick_running:.3f})"
                ))
        else:
            for thresh, key in wick_thresholds_new:
                events.append(TimelineEvent(
                    bar_index=bar.bar_index, ts_et=bar.ts_et,
                    event_type="WICK_THRESHOLD", price=bar.close,
                    score_before=prev_score, score_after=res.pre_fall_score,
                    signal_name=key,
                    description=f"Running wick crossed {thresh} ({bar.wick_running:.3f})"
                ))

        # SCORE_JUMP (large delta)
        if abs(res.delta_from_prev) >= 10:
            events.append(TimelineEvent(
                bar_index=bar.bar_index, ts_et=bar.ts_et,
                event_type="SCORE_JUMP", price=bar.close,
                score_before=prev_score, score_after=res.pre_fall_score,
                signal_name="score_jump",
                description=f"Score jumped {res.delta_from_prev:+d} pts at {bar.ts_et}"
            ))

        prev_tier    = res.pre_fall_tier
        prev_section = res.section
        prev_score   = res.pre_fall_score

    return events

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# REPLAY SESSION â orchestrator
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

class ReplaySession:
    def __init__(self, ticker: str, spike_date: str, csv_path: str = DEFAULT_CSV,
                 api_key: str = None):
        self.ticker     = ticker.upper()
        self.spike_date = spike_date
        self.api_key    = api_key or os.environ.get("POLYGON_API_KEY")

        # Load static fields from CSV
        rows, _ = load_csv(csv_path)
        self.static = next(
            (r for r in rows if r["ticker"].upper()==self.ticker and r["spike_date"]==spike_date),
            {}
        )
        if not self.static:
            print(f"{YEL}Warning: {ticker} {spike_date} not found in CSV â using empty static fields{RESET}")

        # Derive avg_20d_vol from vol_d0 / vol_ratio (both in CSV; avg_volume_10d absent)
        vol_d0    = _flt(self.static.get("vol_d0"), 0)
        vol_ratio = _flt(self.static.get("vol_ratio"), 1) or 1
        avg_vol   = (vol_d0 / vol_ratio) if vol_d0 > 0 else 0

        # prior_close: reverse-engineer from gap_pct so VWAP/wick compute correctly
        # formula: d0_open = prior_close * (1 + gap_pct/100)
        gap_pct     = _flt(self.static.get("gap_pct"), 0)
        d0_open     = _flt(self.static.get("price_d0_open"), 0)
        prior_close = (d0_open / (1 + gap_pct / 100)) if d0_open > 0 and gap_pct != 0 else d0_open

        self.bars = load_bar_stream(ticker, spike_date, self.api_key, avg_vol, prior_close)

        # Enrich static with VPIN + Kyle lambda + FINRA short vol (if available)
        if self.bars and HAS_FINRA:
            print(f"  Computing VPIN + Kyle lambda ...", end="", flush=True)
            fetch_fin = bool(self.api_key or os.environ.get("POLYGON_API_KEY"))
            self.static = enrich_static_fields(
                ticker, spike_date, self.static, self.bars, fetch_finra=fetch_fin
            )
            vpin_r = self.static.get("vpin_regime", "UNKNOWN")
            lam_r  = self.static.get("lambda_regime", "UNKNOWN")
            svr    = self.static.get("short_vol_ratio")
            print(f" VPIN={vpin_r}  Lambda={lam_r}  ShortVol={round(float(svr),3) if svr else 'N/A'}")

        # Build timeline
        print(f"  Building timeline ...", end="", flush=True)
        self.timeline : list[BarState] = self._build_timeline()
        self.events   : list[TimelineEvent] = detect_events(self.timeline)
        print(f" {len(self.timeline)} bar states Â· {len(self.events)} events")

    def _build_timeline(self) -> list[BarState]:
        states = []
        prev_score = 0
        for bar in self.bars:
            mask   = get_field_mask(bar, self.static)
            result = compute_score(mask, prev_score)
            states.append(BarState(bar=bar, result=result, mask=mask))
            prev_score = result.pre_fall_score
        return states

    def seek(self, idx: int) -> BarState:
        idx = max(0, min(idx, len(self.timeline) - 1))
        return self.timeline[idx]

    def events_at(self, idx: int) -> list[TimelineEvent]:
        return [e for e in self.events if e.bar_index <= idx]

    def actual_section(self) -> str:
        if self.ticker in S1_SET: return "S1"
        if self.ticker in S2_SET: return "S2"
        return "UNKNOWN"

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# STRATEGY LAYER â entry/exit rules applied to the timeline
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

class StrategyEngine:
    """
    Applies entry/exit rules to a completed timeline.
    Default strategy: enter when tier flips to HIGH, exit at session close or stop.
    """

    def __init__(self, entry_tier: str = "HIGH",
                 stop_multiplier: float = 1.05,
                 exit_after_bars: int = 390):
        self.entry_tier       = entry_tier
        self.stop_multiplier  = stop_multiplier
        self.exit_after_bars  = exit_after_bars

    def run(self, session: ReplaySession) -> list[Trade]:
        trades  = []
        position = None

        for i, state in enumerate(session.timeline):
            bar = state.bar
            res = state.result

            if position is None:
                # Entry: tier just reached HIGH and we're in RTH
                if (res.pre_fall_tier == self.entry_tier
                        and bar.session == "RTH"
                        and bar.bar_index >= 1):
                    prev = session.timeline[i-1].result.pre_fall_tier
                    if prev != self.entry_tier:
                        stop = bar.high_so_far * self.stop_multiplier
                        position = Trade(
                            ticker=session.ticker, spike_date=session.spike_date,
                            entry_bar=bar.bar_index, entry_time=bar.ts_et,
                            entry_price=bar.close, entry_score=res.pre_fall_score,
                            entry_tier=res.pre_fall_tier, stop_price=stop,
                        )
            else:
                # Stop hit?
                if bar.high >= position.stop_price:
                    position.exit_bar   = bar.bar_index
                    position.exit_time  = bar.ts_et
                    position.exit_price = position.stop_price
                    position.pnl_pct    = round(
                        (position.entry_price - position.stop_price)
                        / position.entry_price * 100, 2)  # short
                    position.bars_held  = bar.bar_index - position.entry_bar
                    position.stop_hit   = True
                    position.exit_reason = "STOP_HIT"
                    trades.append(position)
                    position = None

                # Session close exit
                elif (bar.session == "AFTER_HOURS" or
                      bar.bar_index - position.entry_bar >= self.exit_after_bars):
                    position.exit_bar   = bar.bar_index
                    position.exit_time  = bar.ts_et
                    position.exit_price = bar.close
                    position.pnl_pct    = round(
                        (position.entry_price - bar.close)
                        / position.entry_price * 100, 2)
                    position.bars_held  = bar.bar_index - position.entry_bar
                    position.exit_reason = "SESSION_CLOSE"
                    trades.append(position)
                    position = None

        # Close any open position at end of data
        if position and session.timeline:
            last = session.timeline[-1]
            position.exit_bar   = last.bar.bar_index
            position.exit_time  = last.bar.ts_et
            position.exit_price = last.bar.close
            position.pnl_pct    = round(
                (position.entry_price - last.bar.close)
                / position.entry_price * 100, 2)
            position.bars_held  = last.bar.bar_index - position.entry_bar
            position.exit_reason = "EOD"
            trades.append(position)

        return trades

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# PERFORMANCE EVALUATOR
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def evaluate_performance(all_trades: list[Trade], csv_path: str = DEFAULT_CSV) -> dict:
    """Aggregate stats across all trades."""
    if not all_trades:
        return {}

    pnls = [t.pnl_pct for t in all_trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]

    return {
        "total_trades":   len(all_trades),
        "win_rate":       _pct(len(wins), len(pnls)),
        "avg_pnl":        round(sum(pnls)/len(pnls), 2) if pnls else 0,
        "avg_win":        round(sum(wins)/len(wins), 2) if wins else 0,
        "avg_loss":       round(sum(losses)/len(losses), 2) if losses else 0,
        "best":           round(max(pnls), 2) if pnls else 0,
        "worst":          round(min(pnls), 2) if pnls else 0,
        "stop_hit_rate":  _pct(sum(1 for t in all_trades if t.stop_hit), len(all_trades)),
        "avg_bars_held":  round(sum(t.bars_held for t in all_trades)/len(all_trades), 1),
        "total_pnl":      round(sum(pnls), 2),
    }

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# EXPORT FUNCTIONS
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def export_bars_csv(session: ReplaySession, path: str = None):
    """Bar-by-bar score table as CSV."""
    _ensure_dirs()
    path = path or os.path.join(EXPORT_DIR,
                                f"{session.ticker}_{session.spike_date}_bars.csv")
    rows = []
    for s in session.timeline:
        b = s.bar; r = s.result
        rows.append({
            "bar_index":         b.bar_index,
            "ts_et":             b.ts_et_full,
            "session":           b.session,
            "open":              b.open,
            "high":              b.high,
            "low":               b.low,
            "close":             b.close,
            "volume":            b.volume,
            "vwap_running":      b.vwap_running,
            "wick_running":      b.wick_running,
            "vol_ratio_running": b.vol_ratio_running,
            "intraday_move_pct": b.intraday_move_pct,
            "pre_fall_score":    r.pre_fall_score,
            "pre_fall_tier":     r.pre_fall_tier,
            "s1_score":          r.s1_score,
            "s2_score":          r.s2_score,
            "section":           r.section,
            "confidence_pct":    r.confidence_pct,
            "score_delta":       r.delta_from_prev,
            "active_signals":    "|".join(sig.name for sig in r.active_signals),
            "active_pts":        "|".join(f"{sig.contribution:+.0f}" for sig in r.active_signals),
            "suppressed":        "|".join(r.suppressed_signals),
            "disqualifiers":     "|".join(r.disqualifiers),
            "new_signals_this_bar": "|".join(
                sig.name for sig in r.active_signals
                if r.delta_from_prev != 0
            ),
            # FINRA + VPIN enrichment (static per session â same value all bars)
            "short_vol_ratio":     s.mask.get("short_vol_ratio"),
            "abnormal_short_ratio":s.mask.get("abnormal_short_ratio"),
            "short_vol_class":     s.mask.get("short_vol_classification"),
            "vpin_open":           s.mask.get("vpin_open"),
            "vpin_regime":         s.mask.get("vpin_regime"),
            "lambda_regime":       s.mask.get("lambda_regime"),
            "lambda_signal":       s.mask.get("lambda_signal"),
        })

    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)
    print(f"  {GRN}â bars CSV: {path} ({len(rows)} rows){RESET}")
    return path

def export_events_csv(session: ReplaySession, path: str = None):
    """Events CSV."""
    _ensure_dirs()
    path = path or os.path.join(EXPORT_DIR,
                                f"{session.ticker}_{session.spike_date}_events.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        fields = ["bar_index","ts_et","event_type","price",
                  "score_before","score_after","signal_name","description"]
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for e in session.events:
            w.writerow(asdict(e))
    print(f"  {GRN}â events CSV: {path} ({len(session.events)} events){RESET}")
    return path

def export_json(session: ReplaySession, path: str = None):
    """Full timeline as JSON for UI consumption."""
    _ensure_dirs()
    path = path or os.path.join(EXPORT_DIR,
                                f"{session.ticker}_{session.spike_date}_timeline.json")
    out = {
        "ticker":          session.ticker,
        "spike_date":      session.spike_date,
        "actual_section":  session.actual_section(),
        "static_fields":   session.static,
        "bars": [{
            "bar_index": s.bar.bar_index,
            "ts_et":     s.bar.ts_et_full,
            "session":   s.bar.session,
            "o": s.bar.open, "h": s.bar.high, "l": s.bar.low, "c": s.bar.close,
            "v": s.bar.volume,
            "vwap": s.bar.vwap_running,
            "wick": s.bar.wick_running,
            "vol_ratio": s.bar.vol_ratio_running,
            "pre_fall_score":  s.result.pre_fall_score,
            "pre_fall_tier":   s.result.pre_fall_tier,
            "s1_score":        s.result.s1_score,
            "s2_score":        s.result.s2_score,
            "section":         s.result.section,
            "score_delta":     s.result.delta_from_prev,
            "active_signals":  [{"name":sig.name,"pts":sig.contribution}
                                 for sig in s.result.active_signals],
        } for s in session.timeline],
        "events": [asdict(e) for e in session.events],
    }
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"  {GRN}â JSON: {path}{RESET}")
    return path

def export_summary_txt(session: ReplaySession, trades: list[Trade] = None, path: str = None):
    """Human-readable summary report."""
    _ensure_dirs()
    path = path or os.path.join(EXPORT_DIR,
                                f"{session.ticker}_{session.spike_date}_summary.txt")

    lines = [
        f"Cat5ive Simulation Report â {session.ticker} {session.spike_date}",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "=" * 60,
        f"Actual section: {session.actual_section()}",
        f"Total bars:     {len(session.timeline)}",
        f"Events:         {len(session.events)}",
        "",
        "SCORE AT KEY MILESTONES",
        "-" * 40,
    ]

    milestones = [
        ("PRE-MARKET (first bar)", lambda s: s.bar.session == "PRE_MARKET"),
        ("9:30am RTH open",        lambda s: s.bar.ts_et == "09:30" and s.bar.session == "RTH"),
        ("9:31am",                 lambda s: s.bar.ts_et == "09:31" and s.bar.session == "RTH"),
        ("9:35am (W1 close)",      lambda s: s.bar.ts_et == "09:35" and s.bar.session == "RTH"),
        ("10:00am",                lambda s: s.bar.ts_et == "10:00" and s.bar.session == "RTH"),
        ("12:00pm",                lambda s: s.bar.ts_et == "12:00" and s.bar.session == "RTH"),
        ("15:55pm (near close)",   lambda s: s.bar.ts_et == "15:55" and s.bar.session == "RTH"),
        ("16:00pm close",          lambda s: s.bar.session == "AFTER_HOURS"),
    ]

    for label, pred in milestones:
        match = next((s for s in session.timeline if pred(s)), None)
        if match:
            r = match.result
            lines.append(f"  {label:30} score={r.pre_fall_score:>4} [{r.pre_fall_tier:<6}] "
                         f"S1={r.s1_score:>4.1f} S2={r.s2_score:>4.1f} â {r.section}")

    lines += ["", "KEY EVENTS", "-" * 40]
    for e in session.events:
        lines.append(f"  {e.ts_et} bar={e.bar_index:>4}  {e.event_type:<20} {e.description}")

    if trades:
        lines += ["", "STRATEGY TRADES", "-" * 40]
        for t in trades:
            lines.append(f"  Entry {t.entry_time} bar={t.entry_bar} ${t.entry_price:.2f} score={t.entry_score} [{t.entry_tier}]")
            lines.append(f"  Exit  {t.exit_time} bar={t.exit_bar} ${t.exit_price:.2f} PnL={t.pnl_pct:+.2f}% ({t.exit_reason})")
        perf = evaluate_performance(trades)
        lines += ["", "PERFORMANCE", "-" * 40]
        for k, v in perf.items():
            lines.append(f"  {k}: {v}")

    with open(path, "w") as f:
        f.write("\n".join(lines))
    print(f"  {GRN}â summary: {path}{RESET}")
    return path

def export_trades_csv(trades: list[Trade], path: str = None):
    """P&L log as CSV."""
    _ensure_dirs()
    path = path or os.path.join(EXPORT_DIR, "trades_log.csv")
    if not trades:
        print(f"  {YEL}No trades to export{RESET}")
        return path
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(asdict(trades[0]).keys()))
        w.writeheader()
        for t in trades: w.writerow(asdict(t))
    print(f"  {GRN}â trades CSV: {path} ({len(trades)} trades){RESET}")
    return path

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# INTERACTIVE REPLAY UI â terminal slider
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _render_frame(session: ReplaySession, idx: int, show_signals: bool = True):
    """Render the current bar state to terminal."""
    state   = session.seek(idx)
    bar     = state.bar
    result  = state.result
    events  = session.events_at(idx)
    total   = len(session.timeline)
    actual  = session.actual_section()

    tc = _tier_color(result.pre_fall_tier)
    sec_color = GRN if result.section == "S1" else BLU

    # Header
    print("\033[H\033[J", end="")   # clear screen
    print(f"{BOLD}{'â'*68}{RESET}")
    print(f"{BOLD} Cat5ive Simulation â {session.ticker} {session.spike_date}  "
          f"  Actual: {GRN if actual=='S1' else BLU}{actual}{RESET}{BOLD}  "
          f"[{idx+1}/{total}]{RESET}")
    print(f"{'â'*68}{RESET}")

    # Time + session
    sess_color = {"PRE_MARKET":YEL,"RTH":GRN,"AFTER_HOURS":CYN}.get(bar.session, DIM)
    print(f"\n  {BOLD}{bar.ts_et_full}{RESET}  "
          f"{sess_color}[{bar.session}]{RESET}  bar {bar.bar_index}")

    # OHLCV
    print(f"\n  {'O':>8} {'H':>8} {'L':>8} {'C':>8}  {'VOL':>10}  {'VWAP':>8}")
    print(f"  {bar.open:>8.2f} {bar.high:>8.2f} {bar.low:>8.2f} {bar.close:>8.2f}  "
          f"{bar.volume:>10,}  {bar.vwap_running:>8.4f}")

    # Running metrics
    vwap_rel = bar.close - bar.vwap_running
    vr_col   = GRN if vwap_rel >= 0 else RED
    print(f"\n  VOL_RATIO: {bar.vol_ratio_running:>6.1f}Ã  "
          f"WICK: {bar.wick_running:>5.3f}  "
          f"INTRA_MOVE: {bar.intraday_move_pct:>6.1f}%  "
          f"vs_VWAP: {vr_col}{vwap_rel:+.4f}{RESET}")

    # Scores
    delta_str = f"{result.delta_from_prev:+d}" if result.delta_from_prev else " 0"
    print(f"\n  {'â'*60}")
    print(f"  PRE-FALL SCORE: {tc}{BOLD}{result.pre_fall_score:>4}{RESET}  "
          f"{tc}[{result.pre_fall_tier}]{RESET}  Î{delta_str}  "
          f"  S1:{result.s1_score:>4.1f}  S2:{result.s2_score:>4.1f}  "
          f"â {sec_color}{BOLD}{result.section}{RESET}  ({result.confidence_pct}%)")

    # Score bar
    bar_width = 40
    filled    = min(bar_width, int(result.pre_fall_score / 150 * bar_width))
    bar_vis   = f"{tc}{'â'*filled}{DIM}{'â'*(bar_width-filled)}{RESET}"
    print(f"  {bar_vis}  {result.pre_fall_score}/150")

    if show_signals:
        # Active signals
        if result.active_signals or result.disqualifiers:
            print(f"\n  {BOLD}ACTIVE:{RESET}")
            for sig in result.active_signals:
                print(f"    {GRN}â {sig.name:<28} +{sig.contribution:>3}{RESET}")
            for d in result.disqualifiers:
                print(f"    {RED}â {d}{RESET}")

        # Suppressed
        if result.suppressed_signals:
            print(f"\n  {DIM}SUPPRESSED (data not yet available):{RESET}")
            for s in result.suppressed_signals[:4]:
                print(f"    {DIM}â {s}{RESET}")

    # Recent events
    recent = [e for e in events if e.bar_index >= idx - 5]
    if recent:
        print(f"\n  {BOLD}RECENT EVENTS:{RESET}")
        for e in recent[-4:]:
            ev_col = RED if "VWAP" in e.event_type or "HOD" in e.event_type else YEL
            print(f"    {ev_col}â¶ {e.ts_et} {e.event_type:<18} {e.description[:45]}{RESET}")

    # Controls
    print(f"\n  {'â'*60}")
    print(f"  {DIM}â â : step bar  |  [j] jump to event  |  [p] play  "
          f"|  [e] export  |  [q] quit{RESET}")

def run_interactive(session: ReplaySession, api_key: str = None):
    """Interactive terminal replay with keyboard controls."""
    idx = 0
    total = len(session.timeline)

    if total == 0:
        print(f"{RED}No bars loaded â check API key or CSV entry{RESET}")
        return

    # Find first RTH bar as default start
    for i, s in enumerate(session.timeline):
        if s.bar.session == "RTH":
            idx = i
            break

    import sys, tty, termios
    import select as _select

    def _getch_nb():
        """Non-blocking single char read (Unix)."""
        if _select.select([sys.stdin], [], [], 0.05)[0]:
            return sys.stdin.read(1)
        return None

    try:
        old_settings = termios.tcgetattr(sys.stdin)
        tty.setcbreak(sys.stdin.fileno())

        playing = False
        show_signals = True

        while True:
            _render_frame(session, idx, show_signals)

            if playing:
                time.sleep(0.15)
                ch = _getch_nb()
                if ch in ("q","Q"," "):
                    playing = False
                else:
                    idx = min(idx + 1, total - 1)
                    if idx == total - 1:
                        playing = False
                continue

            # Blocking read
            ch = sys.stdin.read(1)

            if ch == "\x1b":                # escape sequence
                nxt = sys.stdin.read(2)
                if nxt == "[C": idx = min(idx + 1, total - 1)   # right arrow
                elif nxt == "[D": idx = max(idx - 1, 0)          # left arrow
                elif nxt == "[5": idx = max(idx - 10, 0)         # PgUp
                elif nxt == "[6": idx = min(idx + 10, total - 1) # PgDn
            elif ch in ("q","Q"):
                break
            elif ch in ("p","P"):
                playing = True
            elif ch == " ":
                idx = min(idx + 1, total - 1)
            elif ch in ("j","J"):
                # Jump to next event
                future = [e for e in session.events if e.bar_index > idx]
                if future:
                    idx = future[0].bar_index
            elif ch in ("k","K"):
                # Jump to previous event
                past = [e for e in session.events if e.bar_index < idx]
                if past:
                    idx = past[-1].bar_index
            elif ch in ("s","S"):
                show_signals = not show_signals
            elif ch in ("e","E"):
                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)
                print(f"\n  {BOLD}Exporting ...{RESET}")
                export_bars_csv(session)
                export_events_csv(session)
                export_json(session)
                export_summary_txt(session)
                input("  Press Enter to continue ...")
                tty.setcbreak(sys.stdin.fileno())
            elif ch in ("0",):
                idx = 0
            elif ch in ("$",):
                idx = total - 1

    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)
        print("\033[H\033[J", end="")
        print(f"{GRN}Replay ended.{RESET}")

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# BATCH BACKTEST
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def run_backtest(csv_path: str = DEFAULT_CSV, api_key: str = None,
                 export_trades: bool = True) -> list[Trade]:
    """Run strategy across all sessions in the CSV."""
    rows, _ = load_csv(csv_path)
    if not rows:
        print(f"{YEL}No rows in CSV{RESET}")
        return []

    strategy = StrategyEngine()
    all_trades = []
    all_sessions = []

    print(f"\n{BOLD}Running backtest on {len(rows)} sessions ...{RESET}\n")
    for i, row in enumerate(rows, 1):
        ticker = row["ticker"]
        date   = row["spike_date"]
        print(f"  [{i:>2}/{len(rows)}] {ticker} {date}")
        try:
            session = ReplaySession(ticker, date, csv_path, api_key)
            trades  = strategy.run(session)
            all_trades.extend(trades)
            all_sessions.append((session, trades))
        except Exception as ex:
            print(f"        {RED}Error: {ex}{RESET}")

    perf = evaluate_performance(all_trades)

    print(f"\n{BOLD}{'â'*50}")
    print(f"BACKTEST PERFORMANCE â {len(all_trades)} trades")
    print(f"{'â'*50}{RESET}")
    for k, v in perf.items():
        col = GRN if ("win" in k.lower() or ("pnl" in k.lower() and v > 0)) else (RED if "pnl" in k.lower() and v < 0 else "")
        print(f"  {k:<22}: {col}{v}{RESET}")

    if export_trades:
        _ensure_dirs()
        export_trades_csv(all_trades)
        for session, trades in all_sessions:
            export_summary_txt(session, trades)

        # Run pattern analysis across all sessions
        rows_csv, _ = load_csv(csv_path)
        def _section(ticker):
            if ticker in S1_SET: return 'S1'
            if ticker in S2_SET: return 'S2'
            return 'UNKNOWN'
        def _ret_d1(ticker, date):
            r = next((x for x in rows_csv if x['ticker']==ticker and x['spike_date']==date), {})
            try: return float(r.get('ret_d1',''))
            except: return None

        analyzer_input = [
            (session, _section(session.ticker), _ret_d1(session.ticker, session.spike_date))
            for session, _ in all_sessions
        ]
        if analyzer_input:
            print(f"\n{BOLD}Running pattern analysis ...{RESET}")
            analyzer = PatternAnalyzer(analyzer_input)
            analyzer.export_all()

    return all_trades



# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# PATTERN ANALYZER â extracts timing and signal distributions across sessions
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

class PatternAnalyzer:
    """
    Runs across all completed ReplaySessions and extracts:
      1. Score-at-time distributions (what score at 9:31, 9:35, 10:00, etc.)
      2. When each signal first fires per session (bar index + time)
      3. Entry-quality analysis by tier (HIGH/MEDIUM/LOW â actual outcome)
      4. Signal combination frequency (which pairs always co-occur)
      5. VWAP break timing vs D+1 return correlation
      6. Wick threshold timing (when does 0.65/0.85/0.95 fire?)
    All output writes to sim_exports/pattern_analysis.csv and _summary.txt
    """

    def __init__(self, sessions: list):
        self.sessions = sessions   # list of (ReplaySession, actual_section, ret_d1)

    def _rth_bar(self, session, target_et: str):
        """Get the BarState at a specific ET time string (HH:MM), RTH only."""
        for s in session.timeline:
            if s.bar.session == "RTH" and s.bar.ts_et == target_et:
                return s
        return None

    def score_at_times(self) -> list[dict]:
        """For each session, what was the score at key RTH timestamps?"""
        times = ["09:30","09:31","09:35","09:45","10:00","10:30","11:00","12:00","15:00","15:59"]
        rows = []
        for session, actual, ret_d1 in self.sessions:
            row = {
                "ticker":      session.ticker,
                "spike_date":  session.spike_date,
                "actual":      actual,
                "ret_d1":      ret_d1,
            }
            for t in times:
                bs = self._rth_bar(session, t)
                if bs:
                    row[f"score_{t.replace(':','h')}"] = bs.result.pre_fall_score
                    row[f"s1_{t.replace(':','h')}"]    = bs.result.s1_score
                    row[f"s2_{t.replace(':','h')}"]    = bs.result.s2_score
                    row[f"tier_{t.replace(':','h')}"]  = bs.result.pre_fall_tier
                    row[f"sec_{t.replace(':','h')}"]   = bs.result.section
                else:
                    for k in [f"score_{t.replace(':','h')}",f"s1_{t.replace(':','h')}",
                               f"s2_{t.replace(':','h')}",f"tier_{t.replace(':','h')}",
                               f"sec_{t.replace(':','h')}"]:
                        row[k] = None
            rows.append(row)
        return rows

    def signal_first_fire_times(self) -> list[dict]:
        """When did each signal first fire in each session?"""
        rows = []
        sig_names = [
            "DAY3_EXHAUSTION","AH_REVERSAL_TRAP","SERIAL_HEAVY","424B5_ACTIVE",
            "DILUTION_DUMP","PM_SELL_PRESSURE","VWAP_FAIL_S1","LARGE_FLOAT_LOW_VOL",
            "LIVE_WEAKNESS","PM_FADE_CONFIRMED","MEAN_REVERSION_GAP","LIQUIDITY_TRAP",
        ]
        for session, actual, ret_d1 in self.sessions:
            row = {"ticker":session.ticker,"spike_date":session.spike_date,
                   "actual":actual,"ret_d1":ret_d1}
            fired = {s: None for s in sig_names}
            for state in session.timeline:
                for sig in state.result.active_signals:
                    if sig.name in fired and fired[sig.name] is None:
                        fired[sig.name] = state.bar.ts_et
            for s in sig_names:
                row[f"first_{s.lower()[:20]}"] = fired[s]
            rows.append(row)
        return rows

    def vwap_break_timing(self) -> list[dict]:
        """For each session: when did VWAP first break? What was score then? What was D+1?"""
        rows = []
        for session, actual, ret_d1 in self.sessions:
            vwap_break_bar  = None
            hod_reject_bar  = None
            hod_price       = 0.0
            hod_set_idx     = 0

            for state in session.timeline:
                b = state.bar
                if b.session != "RTH": continue
                if b.high_so_far > hod_price:
                    hod_price = b.high_so_far
                    hod_set_idx = b.bar_index
                if vwap_break_bar is None and b.vwap_running > 0 and b.close < b.vwap_running:
                    vwap_break_bar = state
                if (hod_reject_bar is None and hod_set_idx > 0
                        and b.bar_index > hod_set_idx + 5
                        and b.close < hod_price * 0.97):
                    hod_reject_bar = state

            row = {
                "ticker":           session.ticker,
                "spike_date":       session.spike_date,
                "actual":           actual,
                "ret_d1":           ret_d1,
                "vwap_break_time":  vwap_break_bar.bar.ts_et if vwap_break_bar else None,
                "vwap_break_bar":   vwap_break_bar.bar.bar_index if vwap_break_bar else None,
                "vwap_break_score": vwap_break_bar.result.pre_fall_score if vwap_break_bar else None,
                "vwap_break_s1":    vwap_break_bar.result.s1_score if vwap_break_bar else None,
                "hod_reject_time":  hod_reject_bar.bar.ts_et if hod_reject_bar else None,
                "hod_price":        round(hod_price, 4),
                "final_wick":       session.timeline[-1].bar.wick_running if session.timeline else None,
                "final_score":      session.timeline[-1].result.pre_fall_score if session.timeline else None,
                "total_events":     len(session.events),
            }
            rows.append(row)
        return rows

    def entry_quality_by_tier(self) -> dict:
        """For each tier at 9:31am, what was the actual D+1 outcome?"""
        from collections import defaultdict
        buckets = defaultdict(list)
        for session, actual, ret_d1 in self.sessions:
            if ret_d1 is None: continue
            bs = self._rth_bar(session, "09:31")
            if not bs: bs = self._rth_bar(session, "09:30")
            if not bs: continue
            tier = bs.result.pre_fall_tier
            buckets[tier].append({"actual":actual,"ret_d1":ret_d1,
                                   "section_correct": bs.result.section == actual})
        result = {}
        for tier, entries in buckets.items():
            d1s   = [e["ret_d1"] for e in entries]
            wins  = [d for d in d1s if d < -5]   # profitable short = d1 < -5%
            correct = sum(e["section_correct"] for e in entries)
            result[tier] = {
                "n":             len(entries),
                "dump_rate":     round(len(wins)/len(entries)*100, 1) if entries else 0,
                "avg_d1":        round(sum(d1s)/len(d1s), 2) if d1s else 0,
                "section_acc":   round(correct/len(entries)*100, 1) if entries else 0,
                "median_d1":     round(sorted(d1s)[len(d1s)//2], 2) if d1s else 0,
            }
        return result


    def section_flip_analysis(self) -> list[dict]:
        """
        For every session: track every bar where the S1/S2 section changes.
        Records:
          - total_flips:       how many times section changed across the full day
          - rth_flips:         flips during RTH only (9:30â16:00)
          - first_flip_time:   when the first flip happened
          - first_stable_time: first time section held for 30+ consecutive bars without flipping
          - final_section:     what section was at 15:59
          - flip_times:        list of every flip timestamp + direction + price + score context
          - flip_zone:         where most flips clustered (early/mid/late RTH)
          - contested:         True if 5+ flips in RTH (genuinely ambiguous day)
          - score_at_flip:     pre_fall_score each time section changed
          - s1_s2_diff_at_flip: s1-s2 margin each time section changed (near 0 = weak conviction)
          - vwap_correlation:  fraction of flips that happened within 2 bars of a VWAP cross
          - price_range_at_flips: how wide the price range was during flip zone
        """
        rows = []
        for session, actual, ret_d1 in self.sessions:
            tl = session.timeline
            if not tl:
                continue

            flips       = []   # each flip: {bar, time, from_sec, to_sec, price, score, s1, s2}
            prev_sec    = tl[0].result.section
            stable_run  = 0
            first_stable_time = None

            for i, state in enumerate(tl):
                r   = state.result
                bar = state.bar
                sec = r.section

                if sec != prev_sec:
                    flips.append({
                        "bar_index":    bar.bar_index,
                        "time":         bar.ts_et,
                        "session":      bar.session,
                        "from_sec":     prev_sec,
                        "to_sec":       sec,
                        "price":        bar.close,
                        "vwap":         bar.vwap_running,
                        "wick":         bar.wick_running,
                        "score":        r.pre_fall_score,
                        "s1":           r.s1_score,
                        "s2":           r.s2_score,
                        "margin":       round(r.s1_score - r.s2_score, 2),
                        "near_vwap":    abs(bar.close - bar.vwap_running) / bar.vwap_running < 0.015
                                        if bar.vwap_running > 0 else False,
                    })
                    stable_run = 0
                    prev_sec   = sec
                else:
                    stable_run += 1
                    if stable_run == 30 and first_stable_time is None:
                        first_stable_time = bar.ts_et

            rth_flips = [f for f in flips if f["session"] == "RTH"]
            total_flips = len(flips)
            rth_flip_count = len(rth_flips)

            # Flip zone: which RTH hour had most flips
            hour_counts = {"early": 0, "mid": 0, "late": 0}
            for f in rth_flips:
                try:
                    mins = int(f["time"][:2])*60 + int(f["time"][3:5])
                    if mins < 630:    hour_counts["early"] += 1   # 9:30â10:30
                    elif mins < 780:  hour_counts["mid"]   += 1   # 10:30â13:00
                    else:             hour_counts["late"]  += 1   # 13:00â16:00
                except:
                    pass
            flip_zone = max(hour_counts, key=hour_counts.get) if rth_flips else "none"

            # VWAP correlation: fraction of flips near VWAP
            near_vwap_flips = sum(1 for f in rth_flips if f["near_vwap"])
            vwap_corr = round(near_vwap_flips / rth_flip_count, 3) if rth_flip_count > 0 else 0

            # Average margin at flip points â low margin = weak conviction
            margins = [abs(f["margin"]) for f in rth_flips]
            avg_margin = round(sum(margins)/len(margins), 2) if margins else None

            # Price range during all flip bars
            flip_prices = [f["price"] for f in rth_flips]
            price_range = round(max(flip_prices)-min(flip_prices), 4) if len(flip_prices)>=2 else 0

            # Final section at last RTH bar
            rth_states  = [s for s in tl if s.bar.session == "RTH"]
            final_sec   = rth_states[-1].result.section if rth_states else tl[-1].result.section
            final_score = rth_states[-1].result.pre_fall_score if rth_states else 0
            final_s1    = rth_states[-1].result.s1_score if rth_states else 0
            final_s2    = rth_states[-1].result.s2_score if rth_states else 0

            rows.append({
                "ticker":               session.ticker,
                "spike_date":           session.spike_date,
                "actual":               actual,
                "ret_d1":               ret_d1,
                "final_score":          final_score,
                "final_tier":           _tier(final_score),
                "final_section":        final_sec,
                "actual_correct":       final_sec == actual if actual not in ("UNKNOWN","?") else None,
                "total_flips":          total_flips,
                "rth_flips":            rth_flip_count,
                "contested":            rth_flip_count >= 5,
                "flip_zone":            flip_zone,
                "first_flip_time":      flips[0]["time"] if flips else None,
                "first_stable_time":    first_stable_time,
                "vwap_correlation":     vwap_corr,
                "avg_margin_at_flip":   avg_margin,
                "price_range_at_flips": price_range,
                "flip_times":           "|".join(
                    f"{f['time']}({f['from_sec']}â{f['to_sec']},Î{f['margin']:+.1f})"
                    for f in rth_flips
                ),
            })
        return rows

    def export_flip_analysis(self, out_dir: str = EXPORT_DIR):
        """Run section flip analysis and write pattern_section_flips.csv"""
        import os; os.makedirs(out_dir, exist_ok=True)
        rows = self.section_flip_analysis()
        if not rows:
            print("  No sessions for flip analysis")
            return rows

        path = os.path.join(out_dir, "pattern_section_flips.csv")
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)

        # Print summary to terminal
        contested  = [r for r in rows if r["contested"]]
        clean      = [r for r in rows if not r["contested"]]
        correct    = [r for r in rows if r["actual_correct"] is True]
        wrong      = [r for r in rows if r["actual_correct"] is False]

        high_flip  = sorted(rows, key=lambda r: r["rth_flips"], reverse=True)[:5]

        print(f"\n  {BOLD}SECTION FLIP ANALYSIS â {len(rows)} sessions{RESET}")
        print(f"  {'â'*60}")
        print(f"  Contested days (5+ RTH flips):  {len(contested)}/{len(rows)} "
              f"({len(contested)*100//len(rows) if rows else 0}%)")
        print(f"  Clean days (0-4 flips):          {len(clean)}/{len(rows)}")
        print(f"  Section accuracy (non-unknown):  "
              f"{len(correct)}/{len(correct)+len(wrong)} "
              f"({len(correct)*100//(len(correct)+len(wrong)) if correct or wrong else 0}%)")

        print(f"\n  {BOLD}Most contested sessions:{RESET}")
        for r in high_flip:
            c_mark = f"{RED}â{RESET}" if r["actual_correct"] is False else (
                     f"{GRN}â{RESET}" if r["actual_correct"] else f"{DIM}?{RESET}")
            print(f"  {c_mark} {r['ticker']:6} {r['spike_date']}  "
                  f"rth_flips={r['rth_flips']:>2}  "
                  f"final={r['final_section']}  actual={r['actual']}  "
                  f"zone={r['flip_zone']}  vwap_corr={r['vwap_correlation']:.2f}")

        # Insight: do more flips = worse accuracy?
        if len(rows) >= 5:
            contested_acc  = sum(1 for r in contested if r["actual_correct"] is True)
            contested_tot  = sum(1 for r in contested if r["actual_correct"] is not None)
            clean_acc      = sum(1 for r in clean if r["actual_correct"] is True)
            clean_tot      = sum(1 for r in clean if r["actual_correct"] is not None)
            if contested_tot > 0 and clean_tot > 0:
                print(f"\n  {BOLD}Accuracy by contestedness:{RESET}")
                print(f"  Contested days (5+ flips): "
                      f"{contested_acc}/{contested_tot} = "
                      f"{contested_acc*100//contested_tot}% correct")
                print(f"  Clean days (0-4 flips):    "
                      f"{clean_acc}/{clean_tot} = "
                      f"{clean_acc*100//clean_tot}% correct")

        print(f"\n  {GRN}â pattern_section_flips.csv ({len(rows)} rows){RESET}")
        return rows

    def export_all(self, out_dir: str = EXPORT_DIR):
        """Run all analyses and write to export dir."""
        import os; os.makedirs(out_dir, exist_ok=True)

        # Score-at-time table
        score_rows = self.score_at_times()
        path = os.path.join(out_dir, "pattern_score_timeline.csv")
        if score_rows:
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=list(score_rows[0].keys()))
                w.writeheader(); w.writerows(score_rows)
            print(f"  {GRN}â pattern_score_timeline.csv ({len(score_rows)} sessions){RESET}")

        # Signal fire times
        sig_rows = self.signal_first_fire_times()
        path2 = os.path.join(out_dir, "pattern_signal_timing.csv")
        if sig_rows:
            with open(path2, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=list(sig_rows[0].keys()))
                w.writeheader(); w.writerows(sig_rows)
            print(f"  {GRN}â pattern_signal_timing.csv ({len(sig_rows)} sessions){RESET}")

        # VWAP break timing
        vwap_rows = self.vwap_break_timing()
        path3 = os.path.join(out_dir, "pattern_vwap_timing.csv")
        if vwap_rows:
            with open(path3, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=list(vwap_rows[0].keys()))
                w.writeheader(); w.writerows(vwap_rows)
            print(f"  {GRN}â pattern_vwap_timing.csv ({len(vwap_rows)} sessions){RESET}")

        # Entry quality
        eq = self.entry_quality_by_tier()
        lines = ["Entry Quality by Tier at 9:31am", "="*50]
        for tier in ["HIGH","MEDIUM","LOW","SKIP"]:
            if tier in eq:
                d = eq[tier]
                lines.append(f"  {tier:<8} n={d['n']}  dump={d['dump_rate']}%  "
                              f"avg_d1={d['avg_d1']:+.1f}%  sec_acc={d['section_acc']}%")
        path4 = os.path.join(out_dir, "pattern_entry_quality.txt")
        with open(path4, "w") as f:
            f.write("\n".join(lines))
        print("  ".join(lines[:4]))
        print(f"  {GRN}â pattern_entry_quality.txt{RESET}")

        # Section flip analysis
        self.export_flip_analysis(out_dir)

        return score_rows, sig_rows, vwap_rows, eq

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# PRINT-MODE TIMELINE â full bar-by-bar output for non-interactive environments
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _print_timeline(session: ReplaySession):
    """
    Full timeline printed to terminal.
    Shows every bar. Highlights rows where something changed:
      - score changed (any delta)
      - tier changed
      - section changed
      - key events (VWAP break, wick threshold, HOD rejected, etc.)
    Unchanged rows between two significant bars are collapsed to a single
    dim "ââ [N bars unchanged] ââ" line so the output stays readable.
    """
    tl     = session.timeline
    events = {e.bar_index: e for e in session.events}
    total  = len(tl)
    actual = session.actual_section()

    # Header
    print()
    print(f"{BOLD}{'â'*80}{RESET}")
    print(f"{BOLD}  {session.ticker}  {session.spike_date}  Â·  Actual: "
          f"{GRN if actual=='S1' else BLU}{actual}{RESET}{BOLD}  Â·  {total} bars{RESET}")
    print(f"{BOLD}{'â'*80}{RESET}")
    print(f"  {DIM}{'TIME':6}  {'SESSION':12}  {'CLOSE':>7}  {'VWAP':>7}  {'WICK':>6}  "
          f"{'SCORE':>6}  {'TIER':8}  {'S1':>5}  {'S2':>5}  SIGNALS / EVENTS{RESET}")
    print(f"  {'â'*78}")

    prev_score   = 0
    prev_tier    = None
    prev_section = None
    skip_start   = None   # first bar index of an unchanged run

    def _is_notable(i: int, s: BarState) -> bool:
        """True if this bar should print unconditionally."""
        r = s.result
        if r.pre_fall_score != prev_score:   return True
        if r.pre_fall_tier  != prev_tier:    return True
        if r.section != prev_section and r.pre_fall_score >= 10: return True
        if i in events:                      return True
        # Always print first/last bar and session transitions
        if i == 0 or i == total - 1:         return True
        if i > 0 and tl[i].bar.session != tl[i-1].bar.session:
            return True
        return False

    def _flush_skip(skip_start, skip_end):
        if skip_start is not None and skip_end > skip_start:
            n = skip_end - skip_start
            print(f"  {DIM}  {'â':6}  {'Â·'*12}  {'Â·':>7}  {'Â·':>7}  {'Â·':>6}  "
                  f"{'Â·':>6}  {'Â·':8}  {'Â·':>5}  {'Â·':>5}  "
                  f"[{n} bar{'s' if n>1 else ''} â score unchanged]{RESET}")

    skip_start = None

    for i, s in enumerate(tl):
        bar = s.bar; r = s.result
        notable = _is_notable(i, s)

        if notable:
            # Flush any pending skip block
            _flush_skip(skip_start, i)
            skip_start = None

            # Color by tier
            tc  = _tier_color(r.pre_fall_tier)
            sec_col = GRN if r.section == "S1" else BLU
            vb  = bar.close < bar.vwap_running if bar.vwap_running > 0 else False
            vb_marker = f"{RED}â¼VWAP{RESET}" if vb else "     "

            # Score delta marker
            delta = r.delta_from_prev
            if delta > 0:   d_str = f"{GRN}+{delta}{RESET}"
            elif delta < 0: d_str = f"{RED}{delta}{RESET}"
            else:           d_str = "   "

            # Active signals (short names)
            sig_names = [sig.name for sig in r.active_signals]
            # Add VWAP/wick live markers
            if vb:             sig_names.append("VWAPâ")
            if r.delta_from_prev != 0:
                sig_names.append(f"Î{d_str}")

            # Event marker
            ev = events.get(i)
            ev_str = f"  {YEL}â{ev.event_type}{RESET}" if ev else ""

            # Tier change marker
            tier_change = f" {YEL}âTIER{RESET}" if r.pre_fall_tier != prev_tier and prev_tier else ""
            sect_change = (f" {CYN}âSEC{RESET}" if (r.section != prev_section and prev_section
                             and r.pre_fall_score >= 10) else "")

            sess_col = {"PRE_MARKET": YEL, "RTH": GRN, "AFTER_HOURS": CYN}.get(bar.session, DIM)

            print(f"  {bar.ts_et:6}  "
                  f"{sess_col}{bar.session[:10]:12}{RESET}  "
                  f"{bar.close:>7.3f}  "
                  f"{bar.vwap_running:>7.4f}  "
                  f"{bar.wick_running:>6.3f}  "
                  f"{tc}{BOLD}{r.pre_fall_score:>6}{RESET}  "
                  f"{tc}{r.pre_fall_tier:<8}{RESET}  "
                  f"{r.s1_score:>5.1f}  "
                  f"{r.s2_score:>5.1f}  "
                  f"{' '.join(sig_names[:4])}"
                  f"{ev_str}{tier_change}{sect_change}")

            prev_score   = r.pre_fall_score
            prev_tier    = r.pre_fall_tier
            prev_section = r.section
        else:
            if skip_start is None:
                skip_start = i

    _flush_skip(skip_start, total)

    # Summary
    print(f"  {'â'*78}")
    final = tl[-1].result if tl else None
    if final:
        tc = _tier_color(final.pre_fall_tier)
        print(f"\n  {BOLD}FINAL{RESET}  score={tc}{final.pre_fall_score}{RESET} "
              f"[{tc}{final.pre_fall_tier}{RESET}]  "
              f"S1={final.s1_score}  S2={final.s2_score}  â {final.section}")

    # Events summary
    if session.events:
        print(f"\n  {BOLD}KEY EVENTS ({len(session.events)}){RESET}")
        for e in session.events:
            print(f"    {YEL}â{RESET} {e.ts_et}  {e.event_type:<22}  {e.description}")

    # Active signals â use last RTH bar (not AH which has fewer fields visible)
    if tl:
        rth_states = [s for s in tl if s.bar.session == "RTH"]
        last_rth   = rth_states[-1] if rth_states else tl[-1]
        last_r     = last_rth.result
        if last_r.active_signals:
            print(f"\n  {BOLD}ACTIVE SIGNALS AT CLOSE{RESET}")
            for sig in last_r.active_signals:
                print(f"    {GRN}â{RESET} {sig.name:<30} +{sig.contribution}")
        if last_r.suppressed_signals:
            meaningful_suppressed = [s for s in last_r.suppressed_signals
                                     if "not in RTH yet" not in s
                                     and "RTH bars not started" not in s]
            if meaningful_suppressed:
                print(f"\n  {DIM}SUPPRESSED (data not yet visible){RESET}")
                for s in meaningful_suppressed:
                    print(f"    {DIM}â {s}{RESET}")
        if last_r.disqualifiers:
            print(f"\n  {RED}DISQUALIFIERS{RESET}")
            for d in last_r.disqualifiers:
                print(f"    {RED}â {d}{RESET}")
    print()

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# CLI ENTRY POINT
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def main():
    parser = argparse.ArgumentParser(
        description="Cat5ive Time-Synchronized Score Simulation System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python cat5ive_sim.py --replay SKYQ 2026-04-13
  python cat5ive_sim.py --replay SKYQ 2026-04-13 --export all
  python cat5ive_sim.py --add-ticker NVDA 2026-04-14
  python cat5ive_sim.py --remove-ticker ALLO 2026-04-10
  python cat5ive_sim.py --update ALLO 2026-04-13 ret_d1 -22.5
  python cat5ive_sim.py --list
  python cat5ive_sim.py --backtest
  python cat5ive_sim.py --backtest --no-export
  python cat5ive_sim.py --clear-cache SKYQ 2026-04-13
  python cat5ive_sim.py --clear-cache --all
        """
    )

    # Replay
    parser.add_argument("--replay", nargs=2, metavar=("TICKER","DATE"),
                        help="Interactive replay: --replay SKYQ 2026-04-13")
    parser.add_argument("--export", nargs="?", const="all",
                        choices=["bars","events","json","summary","all"],
                        help="Export format (use with --replay)")
    parser.add_argument("--no-interactive", action="store_true",
                        help="Skip interactive UI, just export")

    # Ticker management
    parser.add_argument("--list", action="store_true",
                        help="List all tickers in CSV")
    parser.add_argument("--add-ticker", nargs=2, metavar=("TICKER","DATE"),
                        help="Add ticker+date with interactive prompts")
    parser.add_argument("--remove-ticker", nargs=2, metavar=("TICKER","DATE"),
                        help="Remove ticker+date from CSV")
    parser.add_argument("--update", nargs=4, metavar=("TICKER","DATE","FIELD","VALUE"),
                        help="Update a single field: --update SKYQ 2026-04-13 ret_d1 -38.3")

    # Backtest
    parser.add_argument("--backtest", action="store_true",
                        help="Run strategy backtest on all CSV sessions")
    parser.add_argument("--backtest-deep", nargs="*", metavar="TICKER",
                        help="Full 8-file data export for all sessions, or specific tickers: "
                             "--backtest-deep  (all)  or  --backtest-deep SKYQ ATON")
    parser.add_argument("--finra", nargs=2, metavar=("TICKER","DATE"),
                        help="Fetch FINRA short vol for a single ticker+date and print")
    parser.add_argument("--patterns", action="store_true",
                        help="Run pattern analysis on all sessions (no strategy â just data)")
    parser.add_argument("--flips", nargs="*", metavar=("TICKER", "DATE"),
                        help="Show S1/S2 flip timeline for one ticker (or all if no args)")
    parser.add_argument("--no-export", action="store_true",
                        help="Skip file exports in backtest")

    # Cache management
    parser.add_argument("--clear-cache", nargs="*",
                        help="Clear bar cache: --clear-cache TICKER DATE or --clear-cache --all")

    # Config
    parser.add_argument("--csv", default=DEFAULT_CSV,
                        help=f"CSV path (default: {DEFAULT_CSV})")
    parser.add_argument("--polygon-key", default=None,
                        help="Polygon API key (or set POLYGON_API_KEY env var)")
    parser.add_argument("--set-key", metavar="KEY",
                        help="Save your Polygon API key to config.txt (Windows-friendly)")

    args = parser.parse_args()

    # ââ --set-key: save key to config.txt then exit ââââââââââââââââââââââââââ
    if args.set_key:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cfg_path   = os.path.join(script_dir, "config.txt")
        with open(cfg_path, "w") as f:
            f.write(f"# Cat5ive Polygon API key\n")
            f.write(f"POLYGON_API_KEY={args.set_key.strip()}\n")
        print(f"{GRN}â API key saved to {cfg_path}{RESET}")
        print(f"  You can now run commands without --polygon-key")
        print(f"  To verify: python cat5ive_sim.py --list")
        return


    # ââ API key resolution (Windows-friendly) âââââââââââââââââââââââââââââââââââ
    # Priority: --polygon-key flag > config.txt in script dir > POLYGON_API_KEY env var
    def _load_key_from_config() -> str:
        """Read Polygon API key from config.txt next to the script."""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cfg_path   = os.path.join(script_dir, "config.txt")
        if not os.path.exists(cfg_path):
            return ""
        with open(cfg_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("#") or not line:
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    if key.strip().upper() == "POLYGON_API_KEY":
                        return val.strip()
                else:
                    return line.strip()   # bare key value
        return ""

    api_key = (args.polygon_key
               or os.environ.get("POLYGON_API_KEY")
               or _load_key_from_config())

    # ââ Commands ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

    if args.list:
        cmd_list(args.csv, api_key=api_key)
        return

    if args.add_ticker:
        cmd_add_ticker(args.add_ticker[0], args.add_ticker[1], args.csv, api_key=api_key)
        return

    if args.remove_ticker:
        cmd_remove_ticker(args.remove_ticker[0], args.remove_ticker[1], args.csv)
        return

    if args.update:
        cmd_update_field(args.update[0], args.update[1],
                         args.update[2], args.update[3], args.csv)
        return

    if args.clear_cache is not None:
        _ensure_dirs()
        if not args.clear_cache or "--all" in sys.argv:
            count = 0
            for f in os.listdir(BARS_CACHE):
                os.remove(os.path.join(BARS_CACHE, f))
                count += 1
            print(f"{GRN}Cleared {count} cached bar files{RESET}")
        else:
            if len(args.clear_cache) >= 2:
                fname = f"{args.clear_cache[0].upper()}_{args.clear_cache[1]}_1min.json"
                fpath = os.path.join(BARS_CACHE, fname)
                if os.path.exists(fpath):
                    os.remove(fpath)
                    print(f"{GRN}Cleared cache: {fname}{RESET}")
                else:
                    print(f"{YEL}Cache file not found: {fname}{RESET}")
        return

    if args.backtest:
        run_backtest(args.csv, api_key, export_trades=not args.no_export)
        return

    if args.finra:
        ticker, date = args.finra
        if not HAS_FINRA:
            print("finra_loader.py not found. Place it in the same directory.")
        else:
            print(f"\nFINRA Short Volume Analysis: {ticker.upper()} {date}")
            data = fetch_finra_short_data(ticker.upper(), date)
            print(f"  Short vol ratio (spike day): {data.get('spike_short_vol_ratio')}")
            print(f"  Baseline (30-day avg):       {data.get('baseline_short_vol_ratio')}")
            print(f"  Abnormal ratio:              {data.get('abnormal_short_ratio')}")
            print(f"  Classification:              {data.get('short_vol_classification')}")
            print(f"  Spike short vol:             {data.get('spike_short_vol'):,}" if data.get('spike_short_vol') else "  Spike data: not available")
            print(f"  Lookback days:               {len(data.get('lookback_data',[]))}")
        return

    if args.flips is not None:
        # Single ticker deep-dive OR all sessions
        if args.flips:
            # Single session: show bar-by-bar flip timeline
            ticker_arg = args.flips[0].upper()
            date_arg   = args.flips[1] if len(args.flips) > 1 else None
            if not date_arg:
                # Find all dates for this ticker in CSV
                rows_csv, _ = load_csv(args.csv)
                dates = [r["spike_date"] for r in rows_csv
                         if r["ticker"].upper() == ticker_arg]
                if not dates:
                    print(f"{YEL}No sessions found for {ticker_arg}{RESET}")
                    return
                date_arg = dates[-1]
                print(f"Using most recent: {ticker_arg} {date_arg}")

            print(f"\n{BOLD}S1/S2 Flip Timeline â {ticker_arg} {date_arg}{RESET}")
            session = ReplaySession(ticker_arg, date_arg, args.csv, api_key)

            # Build flip list
            prev_sec = session.timeline[0].result.section
            flips = []
            for state in session.timeline:
                r = state.result; b = state.bar
                if r.section != prev_sec:
                    margin = r.s1_score - r.s2_score
                    near_v = (abs(b.close - b.vwap_running) / b.vwap_running < 0.015
                              if b.vwap_running > 0 else False)
                    flips.append((b.ts_et, b.session, prev_sec, r.section,
                                  b.close, b.vwap_running, b.wick_running,
                                  r.pre_fall_score, r.s1_score, r.s2_score,
                                  round(margin, 2), near_v))
                    prev_sec = r.section

            rth_flips = [f for f in flips if f[1] == "RTH"]
            print(f"Total flips: {len(flips)}  RTH flips: {len(rth_flips)}")
            print(f"\n{'TIME':6}  {'FROM':4} {'TO':4}  {'PRICE':>7}  {'VWAP':>7}  "
                  f"{'WICK':>6}  {'SCORE':>6}  {'S1':>5}  {'S2':>5}  {'MARGIN':>7}  VWAP?")
            print("â" * 85)
            for f in flips:
                ts,ses,fr,to,px,vw,wk,sc,s1,s2,mg,nv = f
                ses_col = {
                    "PRE_MARKET":  YEL,
                    "RTH":         GRN,
                    "AFTER_HOURS": CYN,
                }.get(ses, DIM)
                arrow = f"{GRN}âS1{RESET}" if to == "S1" else f"{BLU}âS2{RESET}"
                vwap_flag = f"  {YEL}âVWAP{RESET}" if nv else ""
                print(f"{ts:6}  {ses_col}{fr:4}{RESET} {arrow}  "
                      f"{px:>7.3f}  {vw:>7.4f}  {wk:>6.3f}  "
                      f"{sc:>6}  {s1:>5.1f}  {s2:>5.1f}  "
                      f"{mg:>+7.2f}{vwap_flag}")

            if not flips:
                print(f"  {GRN}No flips â section held {prev_sec} all day (high conviction){RESET}")
            else:
                near_vwap = sum(1 for f in rth_flips if f[11])
                print(f"\n  RTH flips near VWAP (<1.5%): {near_vwap}/{len(rth_flips)} "
                      f"({near_vwap*100//len(rth_flips) if rth_flips else 0}%)")
                contested = len(rth_flips) >= 5
                print(f"  {'Contested day (5+ RTH flips) â ambiguous S1/S2' if contested else 'Clean day â section largely committed'}")
        else:
            # All sessions â run full PatternAnalyzer
            rows_csv, _ = load_csv(args.csv)
            def _section(ticker):
                return 'S1' if ticker in S1_SET else ('S2' if ticker in S2_SET else 'UNKNOWN')
            def _ret_d1(r):
                try: return float(r.get('ret_d1',''))
                except: return None
            print(f"\n{BOLD}Loading sessions for flip analysis ...{RESET}")
            sessions_for_analysis = []
            for row in rows_csv:
                try:
                    sess = ReplaySession(row['ticker'], row['spike_date'], args.csv, api_key)
                    sessions_for_analysis.append(
                        (sess, _section(row['ticker']), _ret_d1(row))
                    )
                except Exception as ex:
                    print(f"  {RED}{row['ticker']} {row['spike_date']}: {ex}{RESET}")
            analyzer = PatternAnalyzer(sessions_for_analysis)
            analyzer.export_flip_analysis()
        return

    if args.backtest_deep is not None:
        # Load all sessions (or filtered by ticker list)
        rows_csv, _ = load_csv(args.csv)
        ticker_filter = [t.upper() for t in args.backtest_deep] if args.backtest_deep else None
        if ticker_filter:
            rows_csv = [r for r in rows_csv if r["ticker"].upper() in ticker_filter]
        if not rows_csv:
            print(f"{RED}No matching sessions found.{RESET}")
            return

        print(f"\n{BOLD}DEEP BACKTEST EXPORT â {len(rows_csv)} sessions{RESET}")
        if ticker_filter:
            print(f"  Filter: {', '.join(ticker_filter)}")

        sessions_for_export = []
        for row in rows_csv:
            try:
                sess = ReplaySession(row["ticker"], row["spike_date"], args.csv, api_key)
                actual = "S1" if row["ticker"] in S1_SET else (
                         "S2" if row["ticker"] in S2_SET else "UNKNOWN")
                try: ret_d1 = float(row.get("ret_d1",""))
                except: ret_d1 = None
                sessions_for_export.append((sess, actual, ret_d1))
            except Exception as ex:
                print(f"  {RED}{row['ticker']} {row['spike_date']}: {ex}{RESET}")

        if not sessions_for_export:
            print(f"{RED}No sessions loaded.{RESET}")
            return

        out_dir = "sim_exports/backtest"
        if ticker_filter and len(ticker_filter) == 1:
            out_dir = f"sim_exports/backtest_{ticker_filter[0].lower()}"

        exporter = BacktestExporter(sessions_for_export, rows_csv)
        exporter.export_all(out_dir)
        return

    if args.patterns:
        rows_csv, _ = load_csv(args.csv)
        def _section(ticker):
            if ticker in S1_SET: return 'S1'
            if ticker in S2_SET: return 'S2'
            return 'UNKNOWN'
        def _ret_d1(r):
            try: return float(r.get('ret_d1',''))
            except: return None
        sessions_for_analysis = []
        print(f"\n{BOLD}Loading {len(rows_csv)} sessions for pattern analysis ...{RESET}")
        for i, row in enumerate(rows_csv, 1):
            print(f"  [{i:>2}/{len(rows_csv)}] {row['ticker']} {row['spike_date']}")
            try:
                session = ReplaySession(row['ticker'], row['spike_date'], args.csv, api_key)
                sessions_for_analysis.append(
                    (session, _section(row['ticker']), _ret_d1(row))
                )
            except Exception as ex:
                print(f"        {RED}Error: {ex}{RESET}")
        analyzer = PatternAnalyzer(sessions_for_analysis)
        analyzer.export_all()
        return

    if args.replay:
        ticker, date = args.replay
        print(f"\n{BOLD}Loading replay: {ticker.upper()} {date}{RESET}")
        session = ReplaySession(ticker, date, args.csv, api_key)

        # Export if requested
        if args.export:
            print(f"\n{BOLD}Exporting ...{RESET}")
            if args.export in ("bars","all"):    export_bars_csv(session)
            if args.export in ("events","all"):  export_events_csv(session)
            if args.export in ("json","all"):    export_json(session)
            if args.export in ("summary","all"): export_summary_txt(session)

        # Run strategy
        strategy = StrategyEngine()
        trades   = strategy.run(session)
        if trades:
            print(f"\n{BOLD}Strategy: {len(trades)} trade(s){RESET}")
            for t in trades:
                col = GRN if t.pnl_pct > 0 else RED
                print(f"  Entry {t.entry_time} ${t.entry_price:.2f} [{t.entry_tier}] â "
                      f"Exit {t.exit_time} ${t.exit_price:.2f}  "
                      f"{col}{t.pnl_pct:+.2f}%{RESET} ({t.exit_reason})")

        # Interactive UI
        if not args.no_interactive and sys.platform != "win32":
            try:
                run_interactive(session, api_key)
            except Exception as e:
                print(f"{YEL}Interactive UI unavailable ({e}) â use --no-interactive{RESET}")
                _print_timeline(session)
        else:
            _print_timeline(session)
        return

    # No command â show help
    parser.print_help()

if __name__ == "__main__":
    main()


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# COMPREHENSIVE BACKTEST EXPORTER
# Collects every meaningful signal, score snapshot, event, and cross-ticker
# comparison metric for one or more tickers into a structured export package.
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

class BacktestExporter:
    """
    Full data collection for one or more tickers. Exports:

    1. backtest_master.csv         â one row per session Â· all static fields +
                                     score snapshots at key times + outcome metrics
    2. backtest_bars.csv           â every bar for every session (raw OHLCV + scores)
    3. backtest_signals.csv        â every signal that fired per session per bar
    4. backtest_events.csv         â every event (VWAP_BREAK, HOD_REJECTED, etc.)
    5. backtest_score_path.csv     â score evolution: how score built bar-by-bar
    6. backtest_cross_compare.csv  â cross-ticker comparison (S1 vs S2 averages,
                                     regime clusters, signal co-occurrence matrix)
    7. backtest_flip_analysis.csv  â S1/S2 section flip timeline per session
    8. backtest_summary.txt        â human-readable narrative summary
    """

    SNAPSHOT_TIMES = ["09:30","09:31","09:35","09:45","10:00","10:30",
                      "11:00","12:00","13:00","14:00","15:00","15:30","15:59"]

    def __init__(self, sessions: list, csv_rows: list = None):
        """
        sessions  â list of (ReplaySession, actual_section str, ret_d1 float|None)
        csv_rows  â raw CSV rows for static field enrichment
        """
        self.sessions  = sessions
        self.csv_rows  = {(r['ticker'], r['spike_date']): r
                          for r in (csv_rows or [])}

    # ââ HELPER: get raw CSV row for a session âââââââââââââââââââââââââââââââââ
    def _csv(self, session) -> dict:
        return self.csv_rows.get((session.ticker, session.spike_date), {})

    def _flt(self, v):
        try: return float(v)
        except: return None

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 1. MASTER ROW â everything known about a session in one flat row
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def _build_master_row(self, session, actual, ret_d1) -> dict:
        tl  = session.timeline
        csv = self._csv(session)

        # â static fields from CSV â
        row = {
            "ticker":               session.ticker,
            "spike_date":           session.spike_date,
            "actual_section":       actual,
            "ret_d1":               ret_d1,
            "ret_d5":               self._flt(csv.get("ret_d5")),
            "market_regime":        csv.get("market_regime",""),
            "company_intent":       csv.get("company_intent",""),
            "dilution_status":      csv.get("dilution_status",""),
            "tier1_filings":        csv.get("tier1_filings",""),
            "prior_offerings_12m":  csv.get("prior_offerings_12m",""),
            "run_day":              csv.get("run_day",""),
            "float_shares":         csv.get("float_shares",""),
            "vol_ratio":            csv.get("vol_ratio",""),
            "ah_move_pct":          csv.get("ah_move_pct",""),
            "pm_move_pct":          csv.get("pm_move_pct",""),
            "supply_overhang":      csv.get("supply_overhang",""),
            "liquidity_flag":       csv.get("liquidity_flag",""),
            "structure_quality":    csv.get("structure_quality",""),
            "vpin_open":            csv.get("vpin_open",""),
            "short_vol_ratio":      csv.get("short_vol_ratio",""),
        }

        # â pre-fall score (static â from first available bar) â
        first = tl[0] if tl else None
        row["pre_fall_score"]  = first.result.pre_fall_score if first else None
        row["pre_fall_tier"]   = first.result.pre_fall_tier  if first else None

        # â score snapshots at key times â
        rth_map = {b.bar.ts_et: b for b in tl if b.bar.session == "RTH"}
        for t in self.SNAPSHOT_TIMES:
            bs = rth_map.get(t)
            tk = t.replace(":", "h")
            row[f"score_{tk}"]    = bs.result.pre_fall_score  if bs else None
            row[f"s1_{tk}"]       = bs.result.s1_score        if bs else None
            row[f"s2_{tk}"]       = bs.result.s2_score        if bs else None
            row[f"section_{tk}"]  = bs.result.section         if bs else None
            row[f"tier_{tk}"]     = bs.result.pre_fall_tier   if bs else None
            row[f"price_{tk}"]    = bs.bar.close              if bs else None
            row[f"vwap_{tk}"]     = bs.bar.vwap_running       if bs else None
            row[f"wick_{tk}"]     = bs.bar.wick_running       if bs else None

        # â final RTH state (15:59) â
        rth_bars = [b for b in tl if b.bar.session == "RTH"]
        last_rth = rth_bars[-1] if rth_bars else None
        row["final_score"]       = last_rth.result.pre_fall_score if last_rth else None
        row["final_section"]     = last_rth.result.section        if last_rth else None
        row["final_tier"]        = last_rth.result.pre_fall_tier  if last_rth else None
        row["final_s1_score"]    = last_rth.result.s1_score       if last_rth else None
        row["final_s2_score"]    = last_rth.result.s2_score       if last_rth else None
        row["final_confidence"]  = last_rth.result.confidence_pct if last_rth else None
        row["final_wick"]        = last_rth.bar.wick_running      if last_rth else None
        row["final_vwap"]        = last_rth.bar.vwap_running      if last_rth else None
        row["final_price"]       = last_rth.bar.close             if last_rth else None
        row["hod"]               = last_rth.bar.high_so_far       if last_rth else None

        # â HOD timing: when did HOD form? â
        hod_bar = None
        if rth_bars:
            hod_val = rth_bars[-1].bar.high_so_far
            for b in rth_bars:
                if abs(b.bar.high - hod_val) < 0.001:
                    hod_bar = b; break
        row["hod_time"]          = hod_bar.bar.ts_et if hod_bar else None
        row["hod_bar_index"]     = hod_bar.bar.bar_index if hod_bar else None

        # â VWAP break timing â
        vwap_break_bar = None
        prev_vwap_held = True
        for b in rth_bars:
            above = b.bar.close >= b.bar.vwap_running
            if prev_vwap_held and not above:
                vwap_break_bar = b; break
            prev_vwap_held = above
        row["vwap_break_time"]   = vwap_break_bar.bar.ts_et if vwap_break_bar else None
        row["vwap_break_score"]  = vwap_break_bar.result.pre_fall_score if vwap_break_bar else None

        # â section flip count (RTH only) â
        rth_flips = 0
        prev_sec = rth_bars[0].result.section if rth_bars else None
        for b in rth_bars[1:]:
            if b.result.section != prev_sec:
                rth_flips += 1
                prev_sec = b.result.section
        row["rth_section_flips"] = rth_flips
        row["contested_day"]     = rth_flips >= 5

        # â signal inventory: which W1/W2/W3 signals fired? â
        if last_rth:
            fired = {s.name for s in last_rth.result.active_signals}
            for sig in ["DAY3_EXHAUSTION","AH_REVERSAL_TRAP","SERIAL_HEAVY",
                        "PRIOR3+DILUTION","424B5_ACTIVE","PM_SELL_PRESSURE",
                        "VWAP_FAIL_S1","WICK_0.65","WICK_0.85","WICK_0.95",
                        "SUPPLY_OVERHANG","INSIDER_144","AH_NEGATIVE",
                        "VPIN_HIGH","VPIN_ELEVATED","LAMBDA_THIN"]:
                row[f"sig_{sig.replace('.','_').replace('+','_')}"] = sig in fired

        # â section accuracy â
        row["section_correct"] = (
            (row["final_section"] == actual)
            if actual not in ("UNKNOWN", "?", "", None) else None
        )

        # â dump classification â
        row["dumped_d1"]  = ret_d1 is not None and ret_d1 < -5
        row["dumped_d5"]  = self._flt(csv.get("ret_d5")) is not None and self._flt(csv.get("ret_d5","")) < -5

        # â total bars by session â
        row["n_bars_total"]  = len(tl)
        row["n_bars_pm"]     = sum(1 for b in tl if b.bar.session == "PRE_MARKET")
        row["n_bars_rth"]    = len(rth_bars)
        row["n_bars_ah"]     = sum(1 for b in tl if b.bar.session == "AFTER_HOURS")

        return row

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 2. BAR-LEVEL ROWS â every 1-min bar with scores
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def _build_bar_rows(self, session, actual, ret_d1) -> list[dict]:
        rows = []
        for bs in session.timeline:
            b = bs.bar; r = bs.result
            rows.append({
                "ticker":          session.ticker,
                "spike_date":      session.spike_date,
                "actual_section":  actual,
                "ret_d1":          ret_d1,
                "bar_index":       b.bar_index,
                "ts_et":           b.ts_et,
                "session":         b.session,
                "open":            b.open,
                "high":            b.high,
                "low":             b.low,
                "close":           b.close,
                "volume":          b.volume,
                "vwap_running":    round(b.vwap_running, 4),
                "wick_running":    round(b.wick_running, 4),
                "intraday_move":   round(b.intraday_move_pct, 2),
                "pre_fall_score":  r.pre_fall_score,
                "pre_fall_tier":   r.pre_fall_tier,
                "s1_score":        round(r.s1_score, 2),
                "s2_score":        round(r.s2_score, 2),
                "section":         r.section,
                "confidence_pct":  r.confidence_pct,
                "score_delta":     r.delta_from_prev,
                "above_vwap":      b.close >= b.vwap_running if b.vwap_running > 0 else None,
                "n_active_signals":len(r.active_signals),
                "n_disqualifiers": len(r.disqualifiers),
            })
        return rows

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 3. SIGNAL FIRE ROWS â every signal at every bar it was active
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def _build_signal_rows(self, session, actual, ret_d1) -> list[dict]:
        rows = []
        for bs in session.timeline:
            b = bs.bar; r = bs.result
            for sig in r.active_signals:
                rows.append({
                    "ticker":         session.ticker,
                    "spike_date":     session.spike_date,
                    "actual_section": actual,
                    "ret_d1":         ret_d1,
                    "bar_index":      b.bar_index,
                    "ts_et":          b.ts_et,
                    "session":        b.session,
                    "signal_name":    sig.name,
                    "contribution":   sig.contribution,
                    "window":         sig.window,
                    "score_at_bar":   r.pre_fall_score,
                    "section_at_bar": r.section,
                    "price_at_bar":   b.close,
                    "wick_at_bar":    b.wick_running,
                })
        return rows

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 4. EVENT ROWS â VWAP breaks, HOD rejections, section flips, etc.
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def _build_event_rows(self, session, actual, ret_d1) -> list[dict]:
        rows = []
        for ev in session.events:
            rows.append({
                "ticker":         session.ticker,
                "spike_date":     session.spike_date,
                "actual_section": actual,
                "ret_d1":         ret_d1,
                "bar_index":      ev.bar_index,
                "ts_et":          ev.ts_et,
                "event_type":     ev.event_type,
                "price":          ev.price,
                "score_before":   ev.score_before,
                "score_after":    ev.score_after,
                "signal_name":    ev.signal_name,
                "description":    ev.description,
            })
        return rows

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 5. SCORE PATH â how the score evolved each bar (compressed: only changes)
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def _build_score_path_rows(self, session, actual, ret_d1) -> list[dict]:
        rows = []
        prev_score = None; prev_section = None
        for bs in session.timeline:
            score = bs.result.pre_fall_score
            sec   = bs.result.section
            # emit on change OR at key milestone times
            is_milestone = bs.bar.ts_et in ("09:30","09:35","09:45","10:00",
                                             "11:00","12:00","15:00","15:59")
            changed = (score != prev_score or sec != prev_section)
            if changed or is_milestone:
                rows.append({
                    "ticker":         session.ticker,
                    "spike_date":     session.spike_date,
                    "actual_section": actual,
                    "ret_d1":         ret_d1,
                    "bar_index":      bs.bar.bar_index,
                    "ts_et":          bs.bar.ts_et,
                    "session":        bs.bar.session,
                    "pre_fall_score": score,
                    "pre_fall_tier":  bs.result.pre_fall_tier,
                    "s1_score":       round(bs.result.s1_score, 2),
                    "s2_score":       round(bs.result.s2_score, 2),
                    "section":        sec,
                    "score_delta":    bs.result.delta_from_prev,
                    "section_changed":sec != prev_section,
                    "score_changed":  score != prev_score,
                    "price":          bs.bar.close,
                    "vwap":           round(bs.bar.vwap_running, 4),
                    "wick":           round(bs.bar.wick_running, 4),
                    "trigger":        "milestone" if is_milestone else "change",
                })
            prev_score = score; prev_section = sec
        return rows

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 6. CROSS-COMPARE â aggregated stats for reinforcing findings across tickers
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def build_cross_compare(self) -> dict:
        """
        Returns a dict of comparison tables:
          - by_section:   S1 vs S2 metric averages
          - by_tier:      HIGH/MEDIUM/LOW/SKIP breakdown
          - by_regime:    performance by market_regime
          - by_run_day:   performance by run_day
          - signal_cooccurrence: which signals always fire together
          - score_vs_d1:  pre_fall_score buckets vs actual D1 return
        """
        from collections import defaultdict

        master = [self._build_master_row(s, a, r) for s, a, r in self.sessions]

        def avg(vals): return round(sum(v for v in vals if v is not None) /
                                    max(1, sum(1 for v in vals if v is not None)), 2)
        def pct(n, d): return round(n/d*100, 1) if d else 0

        # â by_section â
        by_sec = defaultdict(list)
        for m in master: by_sec[m["actual_section"]].append(m)
        section_rows = []
        for sec, ms in by_sec.items():
            d1s = [m["ret_d1"] for m in ms if m["ret_d1"] is not None]
            d5s = [m["ret_d5"] for m in ms if m["ret_d5"] is not None]
            section_rows.append({
                "section":       sec,
                "n":             len(ms),
                "dump_pct":      pct(sum(1 for d in d1s if d < -5), len(d1s)),
                "avg_d1":        avg(d1s),
                "avg_d5":        avg(d5s),
                "avg_pre_fall":  avg([m["pre_fall_score"] for m in ms]),
                "avg_final_wick":avg([m["final_wick"] for m in ms]),
                "avg_rth_flips": avg([m["rth_section_flips"] for m in ms]),
                "correct_pct":   pct(sum(1 for m in ms if m["section_correct"]),
                                     sum(1 for m in ms if m["section_correct"] is not None)),
                "avg_hod_bar":   avg([m["hod_bar_index"] for m in ms]),
                "vwap_break_pct":pct(sum(1 for m in ms if m["vwap_break_time"]), len(ms)),
            })

        # â by_tier â
        by_tier = defaultdict(list)
        for m in master: by_tier[m["pre_fall_tier"] or "SKIP"].append(m)
        tier_rows = []
        for tier in ["HIGH","MEDIUM","LOW","SKIP"]:
            ms = by_tier.get(tier, [])
            if not ms: continue
            d1s = [m["ret_d1"] for m in ms if m["ret_d1"] is not None]
            tier_rows.append({
                "tier":          tier,
                "n":             len(ms),
                "s1_pct":        pct(sum(1 for m in ms if m["actual_section"]=="S1"), len(ms)),
                "dump_pct":      pct(sum(1 for d in d1s if d < -5), len(d1s)),
                "avg_d1":        avg(d1s),
                "avg_pre_fall":  avg([m["pre_fall_score"] for m in ms]),
                "correct_pct":   pct(sum(1 for m in ms if m["section_correct"]),
                                     sum(1 for m in ms if m["section_correct"] is not None)),
            })

        # â by_regime â
        by_regime = defaultdict(list)
        for m in master: by_regime[m["market_regime"] or "UNKNOWN"].append(m)
        regime_rows = []
        for reg, ms in sorted(by_regime.items(), key=lambda x: -len(x[1])):
            d1s = [m["ret_d1"] for m in ms if m["ret_d1"] is not None]
            regime_rows.append({
                "regime":        reg,
                "n":             len(ms),
                "s1_pct":        pct(sum(1 for m in ms if m["actual_section"]=="S1"), len(ms)),
                "dump_pct":      pct(sum(1 for d in d1s if d < -5), len(d1s)),
                "avg_d1":        avg(d1s),
                "avg_pre_fall":  avg([m["pre_fall_score"] for m in ms]),
            })

        # â score_vs_d1 buckets â
        buckets = [(0,9),(10,24),(25,49),(50,74),(75,99),(100,150)]
        score_rows = []
        for lo, hi in buckets:
            ms = [m for m in master if m["pre_fall_score"] is not None
                  and lo <= m["pre_fall_score"] <= hi]
            d1s = [m["ret_d1"] for m in ms if m["ret_d1"] is not None]
            score_rows.append({
                "score_range":   f"{lo}-{hi}",
                "n":             len(ms),
                "s1_pct":        pct(sum(1 for m in ms if m["actual_section"]=="S1"), len(ms)),
                "dump_pct":      pct(sum(1 for d in d1s if d < -5), len(d1s)),
                "avg_d1":        avg(d1s),
                "correct_pct":   pct(sum(1 for m in ms if m["section_correct"]),
                                     sum(1 for m in ms if m["section_correct"] is not None)),
            })

        # â signal co-occurrence: which signals appear together most often â
        sig_cols = [k for k in (master[0] if master else {}) if k.startswith("sig_")]
        cooc_rows = []
        for i, sa in enumerate(sig_cols):
            for sb in sig_cols[i+1:]:
                both = sum(1 for m in master if m.get(sa) and m.get(sb))
                a_only = sum(1 for m in master if m.get(sa))
                b_only = sum(1 for m in master if m.get(sb))
                if both >= 3:
                    cooc_rows.append({
                        "signal_a": sa.replace("sig_",""),
                        "signal_b": sb.replace("sig_",""),
                        "both":     both,
                        "a_total":  a_only,
                        "b_total":  b_only,
                        "lift":     round(both/max(1,a_only)*both/max(1,b_only)*len(master), 2),
                    })
        cooc_rows.sort(key=lambda x: -x["both"])

        return {
            "by_section":   section_rows,
            "by_tier":      tier_rows,
            "by_regime":    regime_rows,
            "score_vs_d1":  score_rows,
            "cooccurrence": cooc_rows[:20],  # top 20 pairs
        }

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # 7. HUMAN SUMMARY TEXT
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def _build_summary_txt(self, master_rows: list, cross: dict) -> str:
        n = len(master_rows)
        n_s1 = sum(1 for m in master_rows if m["actual_section"]=="S1")
        n_s2 = sum(1 for m in master_rows if m["actual_section"]=="S2")
        d1s  = [m["ret_d1"] for m in master_rows if m["ret_d1"] is not None]
        correct = [m for m in master_rows if m["section_correct"]]
        known   = [m for m in master_rows if m["section_correct"] is not None]

        lines = [
            "â"*70,
            "CAT5IVE â COMPREHENSIVE BACKTEST SUMMARY",
            f"Generated: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "â"*70, "",
            f"Sessions analyzed:   {n}  ({n_s1} S1  Â·  {n_s2} S2)",
            f"With D+1 outcome:    {len(d1s)}",
            f"Overall dump rate:   {sum(1 for d in d1s if d < -5)}/{len(d1s)} = "
            f"{round(sum(1 for d in d1s if d<-5)/len(d1s)*100,1) if d1s else 0}%",
            f"Avg D+1 return:      {round(sum(d1s)/len(d1s),1) if d1s else 'n/a'}%",
            f"Section accuracy:    {len(correct)}/{len(known)} = "
            f"{round(len(correct)/len(known)*100,1) if known else 0}%",
            "",
            "â"*70,
            "BY PRE-FALL TIER",
            "â"*70,
        ]
        for t in cross["by_tier"]:
            lines.append(f"  {t['tier']:8}  n={t['n']:>3}  S1={t['s1_pct']:>5.1f}%  "
                         f"dump={t['dump_pct']:>5.1f}%  avg_D1={t['avg_d1']:>+7.1f}%  "
                         f"correct={t['correct_pct']:>5.1f}%")

        lines += ["", "â"*70, "BY SECTION", "â"*70]
        for s in cross["by_section"]:
            lines.append(f"  {s['section']:4}  n={s['n']:>3}  dump={s['dump_pct']:>5.1f}%  "
                         f"avg_D1={s['avg_d1']:>+7.1f}%  avg_score={s['avg_pre_fall']:>5.0f}  "
                         f"avg_wick={s['avg_final_wick']:.3f}  rth_flips={s['avg_rth_flips']:.1f}")

        lines += ["", "â"*70, "BY REGIME", "â"*70]
        for r in cross["by_regime"]:
            lines.append(f"  {r['regime']:25}  n={r['n']:>3}  S1={r['s1_pct']:>5.1f}%  "
                         f"dump={r['dump_pct']:>5.1f}%  avg_D1={r['avg_d1']:>+7.1f}%")

        lines += ["", "â"*70, "SCORE RANGE â OUTCOME", "â"*70]
        for s in cross["score_vs_d1"]:
            lines.append(f"  Score {s['score_range']:>7}  n={s['n']:>3}  S1={s['s1_pct']:>5.1f}%  "
                         f"dump={s['dump_pct']:>5.1f}%  avg_D1={s['avg_d1']:>+7.1f}%")

        lines += ["", "â"*70, "TOP SIGNAL CO-OCCURRENCES (nâ¥3)", "â"*70]
        for c in cross["cooccurrence"][:10]:
            lines.append(f"  {c['signal_a']:30} â {c['signal_b']:30}  n={c['both']}  lift={c['lift']}")

        lines += ["", "â"*70, "SESSION DETAIL", "â"*70]
        for m in sorted(master_rows, key=lambda x: -(x["pre_fall_score"] or 0)):
            d1s = f"{m['ret_d1']:+.1f}%" if m['ret_d1'] is not None else "pending"
            corr = "â" if m["section_correct"] else ("â" if m["section_correct"] is False else "?")
            lines.append(f"  {corr} {m['ticker']:6} {m['spike_date']}  "
                         f"score={m['pre_fall_score']:>4}  {m['pre_fall_tier']:7}  "
                         f"sec={m['final_section']}  actual={m['actual_section']}  "
                         f"D1={d1s}  wick={m['final_wick'] or 'n/a'}  "
                         f"flips={m['rth_section_flips']}")
        lines.append("")
        return "\n".join(lines)

    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # MAIN EXPORT â runs all 8 outputs
    # âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    def export_all(self, out_dir: str = "sim_exports/backtest") -> str:
        import os, csv as csv_mod
        os.makedirs(out_dir, exist_ok=True)

        master_rows    = []
        bar_rows       = []
        signal_rows    = []
        event_rows     = []
        score_path_rows= []

        print(f"\n  {BOLD}Building backtest export â {len(self.sessions)} sessions{RESET}")
        for i, (session, actual, ret_d1) in enumerate(self.sessions, 1):
            print(f"  [{i:>2}/{len(self.sessions)}] {session.ticker} {session.spike_date}"
                  f"  bars={len(session.timeline)}", end="\r")
            master_rows.append(self._build_master_row(session, actual, ret_d1))
            bar_rows.extend(self._build_bar_rows(session, actual, ret_d1))
            signal_rows.extend(self._build_signal_rows(session, actual, ret_d1))
            event_rows.extend(self._build_event_rows(session, actual, ret_d1))
            score_path_rows.extend(self._build_score_path_rows(session, actual, ret_d1))
        print()

        cross = self.build_cross_compare()

        def write_csv(name, rows):
            if not rows: return
            path = os.path.join(out_dir, name)
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv_mod.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader(); w.writerows(rows)
            print(f"  {GRN}â {name} ({len(rows)} rows){RESET}")

        write_csv("backtest_master.csv",       master_rows)
        write_csv("backtest_bars.csv",         bar_rows)
        write_csv("backtest_signals.csv",      signal_rows)
        write_csv("backtest_events.csv",       event_rows)
        write_csv("backtest_score_path.csv",   score_path_rows)

        # cross-compare â multiple tables in one file using blank separator rows
        cc_path = os.path.join(out_dir, "backtest_cross_compare.csv")
        with open(cc_path, "w", newline="", encoding="utf-8-sig") as f:
            for table_name, rows in cross.items():
                if not rows: continue
                f.write(f"# {table_name.upper()}\n")
                w = csv_mod.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader(); w.writerows(rows)
                f.write("\n")
        print(f"  {GRN}â backtest_cross_compare.csv (6 tables){RESET}")

        # flip analysis (reuse existing PatternAnalyzer method)
        pa = PatternAnalyzer(self.sessions)
        flip_rows = pa.section_flip_analysis()
        write_csv("backtest_flip_analysis.csv", flip_rows)

        # summary text
        summary = self._build_summary_txt(master_rows, cross)
        spath = os.path.join(out_dir, "backtest_summary.txt")
        with open(spath, "w", encoding="utf-8") as f:
            f.write(summary)
        print(f"  {GRN}â backtest_summary.txt{RESET}")
        print(summary)

        return out_dir

