#!/usr/bin/env python3
"""
finra_loader.py - FINRA Daily Short Volume (RegSHO) + VPIN Loader
==================================================================
Fetches FINRA's daily short sale volume files and computes:

  short_vol_ratio      - short volume / total volume for spike day
  abnormal_short_ratio - spike day ratio vs 30-day baseline

Also computes VPIN (Volume-Synchronized Probability of Informed Trading)
from the 1-min Polygon bars, and Kyle's Lambda.

FINRA data source:
  https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt
"""

import os, csv, time, math, datetime, io
from collections import defaultdict
from typing import Optional

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# -- Cache -------------------------------------------------------------------
FINRA_CACHE = "finra_cache"
FINRA_BASE  = "https://cdn.finra.org/equity/regsho/daily"

def _finra_url(date_str: str) -> str:
    d = date_str.replace("-", "")
    return f"{FINRA_BASE}/CNMSshvol{d}.txt"

# ---------------------------------------------------------------------------
# FINRA FETCHER
# ---------------------------------------------------------------------------

def _load_finra_file(date_str: str) -> dict:
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

    if rows_out:
        with open(cache_file, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["symbol","short_vol","exempt_vol","total_vol"])
            w.writeheader(); w.writerows(rows_out)

    print(f"  [finra] {date_str}: {len(result)} tickers loaded")
    return result


def fetch_finra_short_data(ticker: str, spike_date: str, lookback_days: int = 30) -> dict:
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

    spike_dt = datetime.date.fromisoformat(spike_date)
    dates_to_fetch = []
    d = spike_dt
    while len(dates_to_fetch) < lookback_days + 1:
        if d.weekday() < 5:
            dates_to_fetch.append(d.isoformat())
        d -= datetime.timedelta(days=1)
    dates_to_fetch.reverse()

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

    if baseline_ratios:
        baseline = round(sum(baseline_ratios) / len(baseline_ratios), 4)
        result["baseline_short_vol_ratio"] = baseline
        if result["spike_short_vol_ratio"] is not None and baseline > 0:
            abnormal = round(result["spike_short_vol_ratio"] / baseline, 3)
            result["abnormal_short_ratio"] = abnormal
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


# ---------------------------------------------------------------------------
# VPIN - Volume-Synchronized Probability of Informed Trading
# ---------------------------------------------------------------------------

def compute_vpin(bars: list, n_buckets: int = 50) -> dict:
    rth_bars = [b for b in bars if isinstance(b, dict) and b.get("session") == "RTH"]
    if not rth_bars:
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

    imbalances = []
    cum_vol = 0
    buy_vol = 0
    prev_close = rth_bars[0].get("o", rth_bars[0].get("open", 0))
    bucket_imbalances = []

    for bar in rth_bars:
        v = bar.get("v", bar.get("volume", 0))
        c = bar.get("c", bar.get("close", 0))
        if c >= prev_close:
            buy_vol += v
        cum_vol += v
        prev_close = c

        while cum_vol >= bucket_size:
            bucket_buy  = min(buy_vol, bucket_size)
            bucket_sell = bucket_size - bucket_buy
            imb = abs(bucket_buy - bucket_sell) / bucket_size
            bucket_imbalances.append(imb)
            buy_vol  = max(0, buy_vol - bucket_size)
            cum_vol -= bucket_size

    if not bucket_imbalances:
        return empty

    def rolling_vpin(imbs, window):
        if len(imbs) < window:
            return round(sum(imbs) / len(imbs), 4) if imbs else None
        return round(sum(imbs[-window:]) / window, 4)

    n_open  = max(1, n_buckets // 3)
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
        if vpin_full >= 0.60:   regime = "HIGH"
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


def vpin_s1_signal(vpin_data: dict) -> tuple:
    vpin_open = vpin_data.get("vpin_open")
    regime    = vpin_data.get("vpin_regime", "UNKNOWN")
    rising    = vpin_data.get("toxicity_rising")

    if vpin_open is None or regime == "UNKNOWN":
        return 0.0, "VPIN_UNAVAILABLE"

    if regime == "HIGH":
        bonus = 3.0 if rising else 2.0
        return bonus, f"VPIN_HIGH_{vpin_open:.2f}"
    elif regime == "ELEVATED":
        return 1.0, f"VPIN_ELEVATED_{vpin_open:.2f}"
    elif regime == "LOW":
        return -1.5, f"VPIN_LOW_{vpin_open:.2f}"

    return 0.0, "VPIN_BALANCED"


# ---------------------------------------------------------------------------
# KYLE'S LAMBDA
# ---------------------------------------------------------------------------

def compute_kyle_lambda(bars: list, window: str = "open") -> dict:
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
        dp = []
        sv = []
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
        return round(cov / varx, 10)

    lam_open  = _lambda_from_bars(rth_bars[:30])
    lam_full  = _lambda_from_bars(rth_bars)
    lam_close = _lambda_from_bars(rth_bars[-30:])

    prices = [_bar_vals(b)[1] for b in rth_bars if _bar_vals(b)[1] > 0]
    med_price = sorted(prices)[len(prices) // 2] if prices else 1.0
    norm_lam = (lam_open * 10000 / med_price) if lam_open and med_price > 0 else None

    regime = "UNKNOWN"
    signal = "NEUTRAL"
    if norm_lam is not None:
        if norm_lam > 0.05:
            regime = "THIN";    signal = "S1_THIN"
        elif norm_lam > 0.01:
            regime = "MODERATE"; signal = "NEUTRAL"
        else:
            regime = "THICK";   signal = "S2_THICK"

    return {
        "kyle_lambda_open":  lam_open,
        "kyle_lambda_full":  lam_full,
        "kyle_lambda_close": lam_close,
        "kyle_lambda_norm":  norm_lam,
        "lambda_regime":     regime,
        "lambda_signal":     signal,
    }


# ---------------------------------------------------------------------------
# FULL ENRICHMENT
# ---------------------------------------------------------------------------

def enrich_static_fields(ticker: str, spike_date: str,
                          static: dict, bars: list,
                          fetch_finra: bool = True) -> dict:
    enriched = dict(static)

    vpin = compute_vpin(bars)
    enriched["vpin_open"]       = vpin.get("vpin_open")
    enriched["vpin_full"]       = vpin.get("vpin_full")
    enriched["vpin_close"]      = vpin.get("vpin_close")
    enriched["vpin_delta"]      = vpin.get("vpin_delta")
    enriched["vpin_regime"]     = vpin.get("vpin_regime", "UNKNOWN")
    enriched["vpin_at_open"]    = vpin.get("vpin_at_open")
    enriched["toxicity_rising"] = vpin.get("toxicity_rising")

    vpin_score, vpin_sig = vpin_s1_signal(vpin)
    enriched["vpin_s1_delta"] = vpin_score
    enriched["vpin_signal"]   = vpin_sig

    kyle = compute_kyle_lambda(bars)
    enriched["kyle_lambda_open"]  = kyle.get("kyle_lambda_open")
    enriched["kyle_lambda_full"]  = kyle.get("kyle_lambda_full")
    enriched["kyle_lambda_norm"]  = kyle.get("kyle_lambda_norm")
    enriched["lambda_regime"]     = kyle.get("lambda_regime", "UNKNOWN")
    enriched["lambda_signal"]     = kyle.get("lambda_signal", "NEUTRAL")

    if fetch_finra:
        try:
            finra = fetch_finra_short_data(ticker, spike_date)
            enriched["short_vol_ratio"]          = finra.get("spike_short_vol_ratio")
            enriched["baseline_short_vol_ratio"] = finra.get("baseline_short_vol_ratio")
            enriched["abnormal_short_ratio"]     = finra.get("abnormal_short_ratio")
            enriched["short_vol_classification"] = finra.get("short_vol_classification", "UNKNOWN")
        except Exception as e:
            print(f"  [finra] error for {ticker} {spike_date}: {e}")
            enriched["short_vol_ratio"]          = None
            enriched["baseline_short_vol_ratio"] = None
            enriched["abnormal_short_ratio"]     = None
            enriched["short_vol_classification"] = "UNAVAILABLE"
    else:
        enriched["short_vol_ratio"]          = static.get("short_vol_ratio")
        enriched["baseline_short_vol_ratio"] = static.get("baseline_short_vol_ratio")
        enriched["abnormal_short_ratio"]     = static.get("abnormal_short_ratio")
        enriched["short_vol_classification"] = static.get("short_vol_classification", "UNKNOWN")

    return enriched


# ---------------------------------------------------------------------------
# STANDALONE DEMO
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, sys
    parser = argparse.ArgumentParser(description="FINRA/VPIN/Lambda loader")
    parser.add_argument("--ticker", default="SKYQ")
    parser.add_argument("--date",   default="2026-04-13")
    args = parser.parse_args()

    print(f"\nFINRA Short Volume - {args.ticker} {args.date}")
    data = fetch_finra_short_data(args.ticker, args.date, lookback_days=20)
    print(f"  Spike day short vol ratio:  {data['spike_short_vol_ratio']}")
    print(f"  30-day baseline ratio:      {data['baseline_short_vol_ratio']}")
    print(f"  Abnormal ratio:             {data['abnormal_short_ratio']}")
    print(f"  Classification:             {data['short_vol_classification']}")
