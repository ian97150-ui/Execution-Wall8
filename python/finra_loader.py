#!/usr/bin/env python3
"""
finra_loader.py â FINRA Daily Short Volume (RegSHO) + VPIN Loader
==================================================================
Fetches FINRA's daily short sale volume files and computes:

  short_vol_ratio      â short volume / total volume for spike day
                         (what fraction of the day's volume was shorts)
  abnormal_short_ratio â spike day ratio vs 30-day baseline
                         (is today's shorting activity unusual?)

Also computes VPIN (Volume-Synchronized Probability of Informed Trading)
from the 1-min Polygon bars, returning order flow toxicity at W1 open
and across full RTH.

FINRA data source:
  https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt
  Free. Published each evening for the prior trading day.
  No API key needed. Fields: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market

VPIN (Easley, Lopez de Prado, O'Hara 2012):
  Computed from Polygon 1-min bars. No additional data source needed.
  Measures probability that order flow is information-driven (0=noise, 1=informed).
  High VPIN at open â institutional sellers dominating â S1 confirmation.
  Low VPIN at open â retail buyers dominating â S2 squeeze still running.

Kyle's Lambda (price impact per unit signed flow):
  Computed from 1-min bars. High lambda â thin book â fragile spike â S1.

Usage:
    from finra_loader import fetch_finra_short_data, compute_vpin, compute_kyle_lambda
    from finra_loader import enrich_static_fields

    # Full enrichment for a ticker+date (adds fields to static dict)
    enriched = enrich_static_fields(ticker, date, static_fields, polygon_bars)
"""

import os, csv, time, math, datetime, io
from collections import defaultdict
from typing import Optional

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# ââ Cache âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
FINRA_CACHE = "finra_cache"

# ââ FINRA URL pattern âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# CNMS = consolidated (NYSE+NASDAQ+OTC) short sale volume
FINRA_BASE = "https://cdn.finra.org/equity/regsho/daily"

def _finra_url(date_str: str) -> str:
    """YYYYMMDD format for the filename."""
    d = date_str.replace("-", "")
    return f"{FINRA_BASE}/CNMSshvol{d}.txt"

# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# FINRA FETCHER
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _load_finra_file(date_str: str) -> dict:
    """
    Returns dict: {TICKER: {'short_vol': int, 'exempt_vol': int, 'total_vol': int}}
    for all tickers in the FINRA daily short vol file for date_str.
    """
    os.makedirs(FINRA_CACHE, exist_ok=True)
    cache_file = os.path.join(FINRA_CACHE, f"finra_shortvol_{date_str.replace('-','')}.csv")

    if os.path.exists(cache_file):
        result = {}
        with open(cache_file, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                result[row["symbol"]] = {
                    "short_vol":   int(row["short_vol"]),
                    "exempt_vol":  int(row["exempt_vol"]),
                    "total_vol":   int(row["total_vol"]),
                }
        return result

    if not HAS_REQUESTS:
        print("  [finra] requests not installed â pip install requests")
        return {}

    url = _finra_url(date_str)
    try:
        time.sleep(0.5)
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
        text = resp.text
    except Exception as e:
        print(f"  [finra] fetch failed for {date_str}: {e}")
        return {}

    result = {}
    rows_out = []
    for line in text.strip().splitlines():
        if line.startswith("Date") or "|" not in line:
            continue
        parts = line.strip().split("|")
        if len(parts) < 5:
            continue
        try:
            # Format: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
            sym        = parts[1].strip().upper()
            short_vol  = int(parts[2])
            exempt_vol = int(parts[3])
            total_vol  = int(parts[4])
            result[sym] = {"short_vol": short_vol, "exempt_vol": exempt_vol,
                           "total_vol": total_vol}
            rows_out.append({"symbol": sym, "short_vol": short_vol,
                             "exempt_vol": exempt_vol, "total_vol": total_vol})
        except (IndexError, ValueError):
            continue

    # Cache
    if rows_out:
        with open(cache_file, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["symbol","short_vol","exempt_vol","total_vol"])
            w.writeheader(); w.writerows(rows_out)

    print(f"  [finra] {date_str}: {len(result)} tickers loaded")
    return result


def fetch_finra_short_data(ticker: str, spike_date: str,
                            lookback_days: int = 30) -> dict:
    """
    Fetch FINRA short vol for spike_date and the prior lookback_days trading days.

    Returns:
      spike_short_vol_ratio:   short_vol / total_vol on spike day (0-1)
      spike_short_vol:         raw short volume on spike day
      spike_total_vol:         raw total volume on spike day
      baseline_short_vol_ratio: 30-day average ratio (trading days only)
      abnormal_short_ratio:    spike_ratio / baseline_ratio (>1.5 = institutional loading)
      short_vol_classification: INSTITUTIONAL_LOADING | THIN_SHORT | BALANCED
      lookback_data:           list of {date, ratio} for the baseline
    """
    ticker = ticker.upper()
    result = {
        "spike_short_vol_ratio":    None,
        "spike_short_vol":          None,
        "spike_total_vol":          None,
        "baseline_short_vol_ratio": None,
        "abnormal_short_ratio":     None,
        "short_vol_classification": "UNKNOWN",
        "lookback_data":            [],
    }

    # Generate prior trading days (approximate â skip weekends)
    spike_dt = datetime.date.fromisoformat(spike_date)
    dates_to_fetch = []
    d = spike_dt
    while len(dates_to_fetch) < lookback_days + 1:
        if d.weekday() < 5:  # Mon-Fri
            dates_to_fetch.append(d.isoformat())
        d -= datetime.timedelta(days=1)

    dates_to_fetch.reverse()

    # Fetch each date's file
    baseline_ratios = []
    for date_str in dates_to_fetch:
        day_data = _load_finra_file(date_str)
        if ticker not in day_data:
            continue

        row = day_data[ticker]
        sv  = row["short_vol"]
        tv  = row["total_vol"]
        if tv == 0:
            continue
        ratio = round(sv / tv, 4)

        if date_str == spike_date:
            result["spike_short_vol_ratio"] = ratio
            result["spike_short_vol"]       = sv
            result["spike_total_vol"]       = tv
        else:
            baseline_ratios.append(ratio)
            result["lookback_data"].append({"date": date_str, "ratio": ratio})

    # Compute baseline and abnormal ratio
    if baseline_ratios:
        baseline = round(sum(baseline_ratios) / len(baseline_ratios), 4)
        result["baseline_short_vol_ratio"] = baseline
        if result["spike_short_vol_ratio"] is not None and baseline > 0:
            abnormal = round(result["spike_short_vol_ratio"] / baseline, 3)
            result["abnormal_short_ratio"] = abnormal

            # Classification
            svr = result["spike_short_vol_ratio"]
            if abnormal >= 1.5 and svr >= 0.55:
                result["short_vol_classification"] = "INSTITUTIONAL_LOADING"
            elif svr <= 0.30:
                result["short_vol_classification"] = "THIN_SHORT"
            elif 0.40 <= svr <= 0.60:
                result["short_vol_classification"] = "BALANCED"
            elif abnormal < 0.7:
                result["short_vol_classification"] = "BELOW_NORMAL_SHORT"
            else:
                result["short_vol_classification"] = "BALANCED"

    return result


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# VPIN â Volume-Synchronized Probability of Informed Trading
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def compute_vpin(bars: list, n_buckets: int = 50) -> dict:
    """
    Compute VPIN from 1-min bar list (Easley, Lopez de Prado, O'Hara 2012).

    VPIN = rolling mean of |buy_vol - sell_vol| / bucket_size over last n_buckets.
    Ranges 0â1. Values above 0.5 indicate high order flow toxicity (informed trading).

    Bulk volume classification:
      Up bar (close >= prev_close) â all volume buyer-initiated
      Down bar                     â all volume seller-initiated
    This is the Easley et al. approximation â simpler than tick-by-tick Lee-Ready
    but produces equivalent results on 1-min bars.

    Returns:
      vpin_open:    VPIN computed over first 30 bars (W1+W2 window)
      vpin_full:    VPIN across entire RTH session
      vpin_close:   VPIN computed over last 30 bars
      vpin_delta:   vpin_close - vpin_open (direction of toxicity)
      vpin_regime:  HIGH (>0.6) | ELEVATED (>0.4) | LOW (<0.4) | UNKNOWN
      vpin_at_open: single VPIN value at bar 1 (the first complete bucket)
      toxicity_rising: True if delta > 0.1 (informed traders becoming more active)
    """
    rth_bars = [b for b in bars if isinstance(b, dict) and b.get("session") == "RTH"]
    if not rth_bars:
        # Handle Bar dataclass objects too
        rth_bars = [b for b in bars if hasattr(b, "session") and b.session == "RTH"]
        if rth_bars:
            rth_bars = [{"v": b.volume, "c": b.close, "o": b.open, "session": b.session}
                        for b in rth_bars]

    empty = {
        "vpin_open": None, "vpin_full": None, "vpin_close": None,
        "vpin_delta": None, "vpin_regime": "UNKNOWN",
        "vpin_at_open": None, "toxicity_rising": None,
    }

    if len(rth_bars) < 5:
        return empty

    total_vol = sum(b.get("v", b.get("volume", 0)) for b in rth_bars)
    if total_vol == 0:
        return empty

    bucket_size = max(1, total_vol // n_buckets)

    # Walk bars building buckets
    imbalances = []
    cum_vol = 0
    buy_vol = 0
    prev_close = rth_bars[0].get("o", rth_bars[0].get("open", 0))
    bucket_imbalances = []  # raw stream

    for bar in rth_bars:
        v = bar.get("v", bar.get("volume", 0))
        c = bar.get("c", bar.get("close", 0))

        # Bulk classification: up bar = buy
        if c >= prev_close:
            buy_vol += v
        # else: all sells (sell_vol = v - buy_vol portion)
        cum_vol += v
        prev_close = c

        # Emit buckets when we have enough volume
        while cum_vol >= bucket_size:
            # Portion of this bar's volume going into the bucket
            bucket_buy  = min(buy_vol, bucket_size)
            bucket_sell = bucket_size - bucket_buy
            imb = abs(bucket_buy - bucket_sell) / bucket_size
            bucket_imbalances.append(imb)

            buy_vol  = max(0, buy_vol - bucket_size)
            cum_vol -= bucket_size

    if not bucket_imbalances:
        return empty

    # Rolling VPIN over last n_buckets
    def rolling_vpin(imbs, window):
        if len(imbs) < window:
            return round(sum(imbs) / len(imbs), 4) if imbs else None
        return round(sum(imbs[-window:]) / window, 4)

    n_open  = max(1, n_buckets // 3)   # first ~17 buckets = first 30-40 bars
    n_close = max(1, n_buckets // 3)

    vpin_open  = rolling_vpin(bucket_imbalances[:n_open],  n_open)
    vpin_full  = rolling_vpin(bucket_imbalances,           n_buckets)
    vpin_close = rolling_vpin(bucket_imbalances[-n_close:], n_close)
    vpin_at    = bucket_imbalances[0] if bucket_imbalances else None

    delta = None
    if vpin_open is not None and vpin_close is not None:
        delta = round(vpin_close - vpin_open, 4)

    regime = "UNKNOWN"
    if vpin_full is not None:
        if vpin_full >= 0.60:  regime = "HIGH"
        elif vpin_full >= 0.40: regime = "ELEVATED"
        else:                   regime = "LOW"

    toxicity_rising = delta > 0.1 if delta is not None else None

    return {
        "vpin_open":       vpin_open,
        "vpin_full":       vpin_full,
        "vpin_close":      vpin_close,
        "vpin_at_open":    round(vpin_at, 4) if vpin_at else None,
        "vpin_delta":      delta,
        "vpin_regime":     regime,
        "toxicity_rising": toxicity_rising,
    }


def vpin_s1_signal(vpin_data: dict) -> tuple[float, str]:
    """
    Convert VPIN result into S1 score contribution and explanation.

    High VPIN at open = institutional sellers dominating = S1 confirmation.
    Low VPIN at open = retail buyers dominating = S2 lean.

    Returns: (score_delta: float, signal_name: str)
    """
    vpin_open = vpin_data.get("vpin_open")
    regime    = vpin_data.get("vpin_regime", "UNKNOWN")
    rising    = vpin_data.get("toxicity_rising")

    if vpin_open is None or regime == "UNKNOWN":
        return 0.0, "VPIN_UNAVAILABLE"

    if regime == "HIGH":
        # High toxicity = informed sellers active from bar 1 = strong S1
        bonus = 3.0 if rising else 2.0
        return bonus, f"VPIN_HIGH_{vpin_open:.2f}"
    elif regime == "ELEVATED":
        return 1.0, f"VPIN_ELEVATED_{vpin_open:.2f}"
    elif regime == "LOW":
        # Low toxicity = retail buyers = S2 lean
        return -1.5, f"VPIN_LOW_{vpin_open:.2f}"

    return 0.0, "VPIN_BALANCED"


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# KYLE'S LAMBDA â price impact per unit signed flow
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def compute_kyle_lambda(bars: list, window: str = "open") -> dict:
    """
    Compute Kyle's Lambda = regress(price_change ~ signed_volume).
    High lambda = thin book = price moves a lot per share = fragile spike = S1.
    Low lambda  = thick book = price absorbs volume = real demand = S2.

    window: "open" (first 30 bars), "full" (all RTH), "close" (last 30 bars)

    Returns:
      kyle_lambda_open:  lambda for first 30 bars
      kyle_lambda_full:  lambda for full RTH
      kyle_lambda_close: lambda for last 30 bars
      lambda_regime:     THIN | MODERATE | THICK | UNKNOWN
      lambda_signal:     S1_THIN | S2_THICK | NEUTRAL
    """
    rth_bars = [b for b in bars if hasattr(b, "session") and b.session == "RTH"]
    if not rth_bars:
        rth_bars = [b for b in bars if isinstance(b, dict) and b.get("session") == "RTH"]

    if not rth_bars:
        return {"kyle_lambda_open": None, "kyle_lambda_full": None,
                "kyle_lambda_close": None, "lambda_regime": "UNKNOWN",
                "lambda_signal": "NEUTRAL"}

    def _bar_vals(b):
        if hasattr(b, "open"):
            return b.open, b.close, b.volume
        return b.get("o", b.get("open", 0)), b.get("c", b.get("close", 0)), b.get("v", b.get("volume", 0))

    def _lambda_from_bars(bar_list) -> Optional[float]:
        if len(bar_list) < 5:
            return None
        dp = []  # price changes
        sv = []  # signed volumes
        for b in bar_list:
            o, c, v = _bar_vals(b)
            if o <= 0 or v == 0:
                continue
            dp.append(c - o)
            sv.append(v if c >= o else -v)

        if len(dp) < 5:
            return None
        n    = len(dp)
        mx   = sum(sv) / n
        my   = sum(dp) / n
        cov  = sum((x - mx) * (y - my) for x, y in zip(sv, dp)) / n
        varx = sum((x - mx) ** 2 for x in sv) / n
        if varx == 0:
            return None
        lam = cov / varx
        return round(lam, 10)

    lam_open  = _lambda_from_bars(rth_bars[:30])
    lam_full  = _lambda_from_bars(rth_bars)
    lam_close = _lambda_from_bars(rth_bars[-30:])

    # Regime: lambda is in $/share per share units â normalize by price level
    # Use the median close price to get a dimensionless ratio
    prices = [_bar_vals(b)[1] for b in rth_bars if _bar_vals(b)[1] > 0]
    med_price = sorted(prices)[len(prices) // 2] if prices else 1.0

    # Normalized lambda (bps per share) = lambda * 10000 / med_price
    norm_lam = (lam_open * 10000 / med_price) if lam_open and med_price > 0 else None

    regime = "UNKNOWN"
    signal = "NEUTRAL"
    if norm_lam is not None:
        if norm_lam > 0.05:
            regime = "THIN"
            signal = "S1_THIN"      # fragile â each order moves price a lot
        elif norm_lam > 0.01:
            regime = "MODERATE"
            signal = "NEUTRAL"
        else:
            regime = "THICK"
            signal = "S2_THICK"     # resilient â price absorbs large orders

    return {
        "kyle_lambda_open":  lam_open,
        "kyle_lambda_full":  lam_full,
        "kyle_lambda_close": lam_close,
        "kyle_lambda_norm":  norm_lam,
        "lambda_regime":     regime,
        "lambda_signal":     signal,
    }


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# FULL ENRICHMENT â add all new signals to a session's static fields
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def enrich_static_fields(ticker: str, spike_date: str,
                          static: dict, bars: list,
                          fetch_finra: bool = True) -> dict:
    """
    Compute FINRA short vol + VPIN + Kyle's Lambda and merge into static dict.
    Call this before building a ReplaySession timeline so new fields are available
    in the field mask from bar 0.

    Returns enriched static dict (original not modified).
    """
    enriched = dict(static)

    # ââ VPIN ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    vpin = compute_vpin(bars)
    enriched["vpin_open"]       = vpin.get("vpin_open")
    enriched["vpin_full"]       = vpin.get("vpin_full")
    enriched["vpin_close"]      = vpin.get("vpin_close")
    enriched["vpin_delta"]      = vpin.get("vpin_delta")
    enriched["vpin_regime"]     = vpin.get("vpin_regime", "UNKNOWN")
    enriched["vpin_at_open"]    = vpin.get("vpin_at_open")
    enriched["toxicity_rising"] = vpin.get("toxicity_rising")

    vpin_score, vpin_sig = vpin_s1_signal(vpin)
    enriched["vpin_s1_delta"] = vpin_score   # added to S1 scorer
    enriched["vpin_signal"]   = vpin_sig

    # ââ Kyle's Lambda ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    kyle = compute_kyle_lambda(bars)
    enriched["kyle_lambda_open"]  = kyle.get("kyle_lambda_open")
    enriched["kyle_lambda_full"]  = kyle.get("kyle_lambda_full")
    enriched["kyle_lambda_norm"]  = kyle.get("kyle_lambda_norm")
    enriched["lambda_regime"]     = kyle.get("lambda_regime", "UNKNOWN")
    enriched["lambda_signal"]     = kyle.get("lambda_signal", "NEUTRAL")

    # ââ FINRA short vol ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if fetch_finra:
        try:
            finra = fetch_finra_short_data(ticker, spike_date)
            enriched["short_vol_ratio"]         = finra.get("spike_short_vol_ratio")
            enriched["baseline_short_vol_ratio"] = finra.get("baseline_short_vol_ratio")
            enriched["abnormal_short_ratio"]     = finra.get("abnormal_short_ratio")
            enriched["short_vol_classification"] = finra.get("short_vol_classification", "UNKNOWN")
        except Exception as e:
            print(f"  [finra] error for {ticker} {spike_date}: {e}")
            enriched["short_vol_ratio"]         = None
            enriched["baseline_short_vol_ratio"] = None
            enriched["abnormal_short_ratio"]     = None
            enriched["short_vol_classification"] = "UNAVAILABLE"
    else:
        enriched["short_vol_ratio"]         = static.get("short_vol_ratio")
        enriched["baseline_short_vol_ratio"] = static.get("baseline_short_vol_ratio")
        enriched["abnormal_short_ratio"]     = static.get("abnormal_short_ratio")
        enriched["short_vol_classification"] = static.get("short_vol_classification", "UNKNOWN")

    return enriched


# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# STANDALONE DEMO
# âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

if __name__ == "__main__":
    import argparse, sys
    sys.path.insert(0, ".")

    parser = argparse.ArgumentParser(description="FINRA/VPIN/Lambda loader")
    parser.add_argument("--ticker", default="SKYQ")
    parser.add_argument("--date",   default="2026-04-13")
    parser.add_argument("--finra-only", action="store_true")
    parser.add_argument("--vpin-only",  action="store_true")
    args = parser.parse_args()

    print(f"\nFinRA Short Volume â {args.ticker} {args.date}")
    data = fetch_finra_short_data(args.ticker, args.date, lookback_days=20)
    print(f"  Spike day short vol ratio:  {data['spike_short_vol_ratio']}")
    print(f"  30-day baseline ratio:      {data['baseline_short_vol_ratio']}")
    print(f"  Abnormal ratio:             {data['abnormal_short_ratio']}")
    print(f"  Classification:             {data['short_vol_classification']}")
    print(f"  Lookback data points:       {len(data['lookback_data'])}")

    print(f"\nTo test VPIN, run with Polygon bars loaded via cat5ive_sim.py")
    print(f"  from finra_loader import compute_vpin, compute_kyle_lambda")
    print(f"  vpin = compute_vpin(session.bars)")
    print(f"  print(vpin)")
