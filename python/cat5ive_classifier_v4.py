#!/usr/bin/env python3
"""
cat5ive_classifier_v4.py Ã¢Â€Â” Real-Time Trade Classifier with Tick Layer
=======================================================================
v4.0 Ã¢Â€Â” Tradier timesales tick data integrated as optional scoring layer.

Builds on v3 (all 8 temporal-contamination fixes applied) and adds:

  TICK LAYER (optional Ã¢Â€Â” requires TRADIER_API_KEY + interval=tick):
  Ã¢ÂœÂ¦ fetch_tradier_ticks()     Ã¢Â€Â” pulls tick prints from Tradier timesales
  Ã¢ÂœÂ¦ TickFeatures dataclass    Ã¢Â€Â” holds all computed tick metrics
  Ã¢ÂœÂ¦ compute_tick_features()   Ã¢Â€Â” computes per-session tick signals:
      Ã¢Â€Â¢ proxy_vpin             Running order flow toxicity proxy
      Ã¢Â€Â¢ buy_pressure_pct       % of volume in up-ticks (buyer-initiated)
      Ã¢Â€Â¢ sell_pressure_pct      % of volume in down-ticks
      Ã¢Â€Â¢ large_print_pct        % of volume in prints > 5ÃƒÂ— avg size
      Ã¢Â€Â¢ tick_rate_pm           Prints per minute during PM (quote activity)
      Ã¢Â€Â¢ running_dp_proxy       Large-print ratio (dark pool proxy)
      Ã¢Â€Â¢ price_path_efficiency  Net move / total path from ticks
  Ã¢ÂœÂ¦ apply_tick_score_adj()    Ã¢Â€Â” adjusts classifier score from tick features
  Ã¢ÂœÂ¦ tick_safe gates           Ã¢Â€Â” all tick fields marked live-safe or calibration-only

TEMPORAL CONTAMINATION RULES (v4 enforces strictly):
  - No pre_hod anchored fields used in live scoring (all require future HOD time)
  - Tick features computed from window [PM_open Ã¢Â†Â’ current_bar] only
  - HOD stability guard: tick features that depend on HOD use 30+ bar confirmation
  - pm_open validation: tick features skip gracefully when PM data unavailable

TRADIER TIMESALES ENDPOINT:
  GET https://api.tradier.com/v1/markets/timesales
  params: symbol, interval=tick, start, end, session_filter=all
  Response fields per tick: time, timestamp, price, open, high, low,
                             close, volume, vwap

USAGE:
  python cat5ive_classifier_v4.py LABT
  python cat5ive_classifier_v4.py LABT --ticks            # enable tick layer
  python cat5ive_classifier_v4.py LABT --ticks --json --once
  python cat5ive_classifier_v4.py LABT --interval 60      # poll every 60s
  python cat5ive_classifier_v4.py LABT --no-float --ticks

  Config (same as v3):
    setx TRADIER_API_KEY "your_production_key"
    setx POLYGON_API_KEY "your_polygon_key"
    setx FMP_API_KEY     "your_fmp_key"

  Or config.json: {"tradier_key": "...", "polygon_key": "...", "fmp_key": "..."}

TICK AVAILABILITY NOTE:
  Tradier timesales tick data is very large for high-volume symbols.
  For OTC/small-cap Cat5ive candidates (low volume), tick data is
  manageable. Recommended: fetch PM ticks at RTH open (4am-9:30am window)
  as a one-time pull, then use 1-min bars for intraday updates.

V3 Ã¢Â†Â’ V4 SCORE ADJUSTMENTS (tick features, applied on top of v3 score):
  buy_pressure_pct < 35%     Ã¢Â†Â’ +10   (strong sell pressure in PM ticks)
  large_print_pct > 20%      Ã¢Â†Â’ +8    (institutional block prints)
  proxy_vpin > 0.55          Ã¢Â†Â’ +6    (elevated order flow toxicity)
  tick_rate_pm > 50/min      Ã¢Â†Â’ +5    (high quote activity = algo positioning)
  running_dp_proxy > 25%     Ã¢Â†Â’ +8    (dark pool volume proxy elevated)
  buy_pressure_pct > 65%     Ã¢Â†Â’ Ã¢ÂˆÂ’10   (buyers dominating Ã¢Â€Â” don't short)
  proxy_vpin < 0.2           Ã¢Â†Â’ Ã¢ÂˆÂ’5    (benign order flow Ã¢Â€Â” setup unclear)
"""

import os, sys, time, json, argparse, math, statistics
from datetime import datetime, date, timedelta
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict

# Ã¢Â”Â€Ã¢Â”Â€ Import everything from v3 Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
# v4 is a thin wrapper Ã¢Â€Â” all OHLCV classification comes from v3
_V3_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        'cat5ive_classifier_v3.py')
if not os.path.exists(_V3_PATH):
    print(f"ERROR: cat5ive_classifier_v3.py not found at {_V3_PATH}")
    sys.exit(1)

import importlib.util as _ilu
_spec = _ilu.spec_from_file_location('cat5ive_v3', _V3_PATH)
_v3   = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_v3)

# Re-export all v3 public names
Bar                 = _v3.Bar
ClassifierSignal    = _v3.ClassifierSignal
get_bars            = _v3.get_bars
run_classification  = _v3.run_classification
fetch_float_shares  = _v3.fetch_float_shares
load_keys           = _v3.load_keys
log_signal          = _v3.log_signal
print_signal        = _v3.print_signal

try:    import requests;    HAS_REQUESTS = True
except: HAS_REQUESTS = False

BOLD='\033[1m'; RESET='\033[0m'; GRN='\033[92m'; YEL='\033[93m'
RED='\033[91m'; CYN='\033[96m'; MAG='\033[95m'; DIM='\033[2m'

PM_START_ET = 4   * 3600   # 04:00 ET in seconds
PM_END_ET   = 9.5 * 3600   # 09:30 ET

# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# TICK DATA LAYER
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

@dataclass
class TickPrint:
    """Single trade print from Tradier timesales tick endpoint."""
    ts_str:    str     # '2026-03-16 13:30:00' UTC
    timestamp: int     # unix seconds
    price:     float
    volume:    int
    et_sec:    float   # ET seconds from midnight (derived)


@dataclass
class TickFeatures:
    """
    Tick-derived features computed from the PM session (04:00-09:30 ET).

    ALL fields are computed from the window [PM open Ã¢Â†Â’ decision bar].
    NO fields use pre_hod anchoring (future-contaminated).
    All are marked live-safe (Ã¢ÂœÂ…) or calibration-only (Ã¢ÂÂŒ).

    When tick data is unavailable, all fields default to None.
    The score adjustments skip gracefully when field is None.
    """
    # Ã¢Â”Â€Ã¢Â”Â€ Order flow Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    proxy_vpin:         Optional[float] = None  # Ã¢ÂœÂ… 0-1 toxicity proxy (PM window)
    buy_pressure_pct:   Optional[float] = None  # Ã¢ÂœÂ… % vol in up-ticks PM
    sell_pressure_pct:  Optional[float] = None  # Ã¢ÂœÂ… % vol in down-ticks PM
    neutral_pct:        Optional[float] = None  # Ã¢ÂœÂ… % vol in flat ticks PM

    # Ã¢Â”Â€Ã¢Â”Â€ Institutional proxy Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    large_print_pct:    Optional[float] = None  # Ã¢ÂœÂ… % vol in large prints (>5ÃƒÂ— avg)
    running_dp_proxy:   Optional[float] = None  # Ã¢ÂœÂ… large-print ratio (DP proxy)
    avg_print_size:     Optional[float] = None  # Ã¢ÂœÂ… mean volume per tick

    # Ã¢Â”Â€Ã¢Â”Â€ Liquidity / activity Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    tick_rate_pm:       Optional[float] = None  # Ã¢ÂœÂ… prints per minute in PM
    tick_count_pm:      Optional[int]   = None  # Ã¢ÂœÂ… total PM tick count
    price_path_eff:     Optional[float] = None  # Ã¢ÂœÂ… net_move / total_path (0-1)

    # Ã¢Â”Â€Ã¢Â”Â€ Diagnostics Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    pm_open_tick:       Optional[float] = None  # Ã¢ÂœÂ… first tick price (4am ET)
    pm_close_tick:      Optional[float] = None  # Ã¢ÂœÂ… last PM tick price (9:30am ET)
    pm_vol_total:       Optional[int]   = None  # Ã¢ÂœÂ… total PM volume from ticks
    ticks_available:    bool            = False  # True when tick data was fetched

    # Ã¢Â”Â€Ã¢Â”Â€ Score adjustment (computed from above fields) Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    tick_score_delta:   int             = 0     # net score change from tick layer
    tick_gate_notes:    List[str]       = field(default_factory=list)


# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# TRADIER TICK FETCHING
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

def fetch_tradier_ticks(ticker: str, date_str: str,
                        tradier_key: str,
                        start_et_hour: float = 4.0,
                        end_et_hour:   float = 9.5,
                        chunk_minutes: int   = 30) -> List[TickPrint]:
    """
    Fetch tick-level trade data from Tradier timesales endpoint.

    Fetches in chunks of chunk_minutes (default 30 min) to avoid
    Tradier response-size limits for high-volume tickers.
    SOAR had 8,350 ticks in 30 min Ã¢Â€Â” a full 5.5h window would exceed limits.
    Chunks are concatenated into a single sorted list.

    Returns [] if API unavailable, key missing, or no data returned.
    """
    if not HAS_REQUESTS or not tradier_key:
        return []

    all_ticks: List[TickPrint] = []
    chunk_h    = chunk_minutes / 60.0
    window_start = start_et_hour

    while window_start < end_et_hour:
        window_end = min(window_start + chunk_h, end_et_hour)

        def _fmt(h):
            hh = int(h)
            mm = int(round((h - hh) * 60))
            return f"{hh:02d}:{mm:02d}"

        start_str = f"{date_str} {_fmt(window_start)}"
        end_str   = f"{date_str} {_fmt(window_end)}"

        try:
            resp = requests.get(
                'https://api.tradier.com/v1/markets/timesales',
                headers={
                    'Authorization': f'Bearer {tradier_key}',
                    'Accept':        'application/json',
                },
                params={
                    'symbol':         ticker.upper(),
                    'interval':       'tick',
                    'start':          start_str,
                    'end':            end_str,
                    'session_filter': 'all',
                },
                timeout=30,
            )
            if resp.status_code != 200:
                window_start = window_end
                continue

            data   = resp.json()
            series = (data.get('series') or {}).get('data') or []
            if isinstance(series, dict):
                series = [series]

            for item in series:
                try:
                    ts_str    = str(item.get('time', ''))
                    timestamp = int(item.get('timestamp', 0))
                    price     = float(item.get('price', 0) or item.get('close', 0) or 0)
                    volume    = int(item.get('volume', 0) or 0)
                    if price <= 0 or volume <= 0:
                        continue
                    if timestamp > 0:
                        et_sec = (timestamp - 4 * 3600) % 86400
                    else:
                        et_sec = _parse_tradier_time(ts_str)
                    all_ticks.append(TickPrint(
                        ts_str=ts_str, timestamp=timestamp,
                        price=price, volume=volume, et_sec=et_sec,
                    ))
                except Exception:
                    continue

        except Exception:
            pass

        window_start = window_end

    return all_ticks


def _parse_tradier_time(ts_str: str) -> float:
    """
    Parse Tradier time string to ET seconds.
    Tradier returns: '2026-03-16 13:30:00' (UTC) or '09:30:00' (ET).
    """
    try:
        s = ts_str.strip()
        if len(s) >= 19 and ' ' in s:
            # Full UTC datetime: '2026-03-16 13:30:00'
            time_part = s[11:19]
            h, m, sec = int(time_part[0:2]), int(time_part[3:5]), int(time_part[6:8])
            utc_sec   = h * 3600 + m * 60 + sec
            return (utc_sec - 4 * 3600) % 86400   # UTC Ã¢Â†Â’ EDT
        elif len(s) >= 8 and ':' in s:
            # Time only: '09:30:00' Ã¢Â€Â” assume already ET
            parts = s.split(':')
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        return 0.0
    except Exception:
        return 0.0


# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# TICK FEATURE COMPUTATION
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

def compute_tick_features(ticks: List[TickPrint],
                          pm_open_price: float = 0.0,
                          start_et: float = PM_START_ET,
                          end_et:   float = PM_END_ET) -> TickFeatures:
    """
    Compute all tick-derived features from a list of trade prints.

    ALL computations use only the PM window [start_et, end_et] by default.
    No HOD-anchored windows. No future data.

    Feature definitions:
      proxy_vpin: Simplified VPIN proxy using tick direction.
                  Up-tick vol = price > prev_price, down-tick vol = price < prev_price.
                  VPIN = |buy_vol - sell_vol| / total_vol (bulk-volume classification).
                  Range 0-1. Higher = more imbalanced order flow = more informed trading.

      buy/sell_pressure_pct: % of volume classified as buyer/seller initiated.
                  Up-tick = buyer aggressor. Down-tick = seller aggressor.
                  Flat = neutral (same price as prev print).

      large_print_pct: % of volume in prints that are > 5x average print size.
                  Large prints = potential institutional block trades / dark pool bypass.
                  Note: not a true DP detection (no routing info) Ã¢Â€Â” a proxy.

      running_dp_proxy: Same as large_print_pct but with 10x threshold.
                  Higher bar for calling a print 'institutional'.

      tick_rate_pm: Prints per minute in the PM window.
                  Calibration: compare to quote_update_rate from L1/L2 data.
                  >50/min = active algo environment (Cat5ive data: A=Ã¢ÂˆÂ’13.4%).

      price_path_eff: |net PM move| / sum(|tick-to-tick changes|).
                  1.0 = perfectly directional (straight line up then down).
                  0.0 = random walk (no net direction).
    """
    # Filter to requested window
    pm_ticks = [t for t in ticks if start_et <= t.et_sec < end_et]
    if len(pm_ticks) < 3:
        return TickFeatures(ticks_available=len(ticks) > 0)

    # Ã¢Â”Â€Ã¢Â”Â€ Order flow classification via bulk-volume method Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    buy_vol = sell_vol = neutral_vol = 0
    prev_price = pm_ticks[0].price

    for tick in pm_ticks[1:]:
        if tick.price > prev_price:
            buy_vol     += tick.volume
        elif tick.price < prev_price:
            sell_vol    += tick.volume
        else:
            neutral_vol += tick.volume
        prev_price = tick.price

    total_vol = buy_vol + sell_vol + neutral_vol
    if total_vol == 0:
        return TickFeatures(ticks_available=True, tick_count_pm=len(pm_ticks))

    buy_pct  = buy_vol  / total_vol * 100
    sell_pct = sell_vol / total_vol * 100
    neut_pct = neutral_vol / total_vol * 100

    # Proxy VPIN = order imbalance (simplified bulk-volume method)
    proxy_vpin = abs(buy_vol - sell_vol) / total_vol

    # Ã¢Â”Â€Ã¢Â”Â€ Large print detection Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    volumes = [t.volume for t in pm_ticks]
    avg_size = statistics.mean(volumes) if volumes else 1
    large_threshold = avg_size * 5    # 5ÃƒÂ— average = large print
    dp_threshold    = avg_size * 10   # 10ÃƒÂ— average = very large print

    large_vol = sum(t.volume for t in pm_ticks if t.volume >= large_threshold)
    dp_vol    = sum(t.volume for t in pm_ticks if t.volume >= dp_threshold)
    large_pct = large_vol / total_vol * 100
    dp_pct    = dp_vol    / total_vol * 100

    # Ã¢Â”Â€Ã¢Â”Â€ Tick rate Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    dur_min = (end_et - start_et) / 60   # PM duration in minutes
    tick_rate = len(pm_ticks) / dur_min if dur_min > 0 else 0

    # Ã¢Â”Â€Ã¢Â”Â€ Price path efficiency (PM) Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    prices     = [t.price for t in pm_ticks]
    net_move   = abs(prices[-1] - prices[0])
    total_path = sum(abs(prices[i] - prices[i-1]) for i in range(1, len(prices)))
    path_eff   = net_move / total_path if total_path > 0 else 0.0

    return TickFeatures(
        proxy_vpin          = round(proxy_vpin, 4),
        buy_pressure_pct    = round(buy_pct, 2),
        sell_pressure_pct   = round(sell_pct, 2),
        neutral_pct         = round(neut_pct, 2),
        large_print_pct     = round(large_pct, 2),
        running_dp_proxy    = round(dp_pct, 2),
        avg_print_size      = round(avg_size, 1),
        tick_rate_pm        = round(tick_rate, 2),
        tick_count_pm       = len(pm_ticks),
        price_path_eff      = round(path_eff, 4),
        pm_open_tick        = prices[0],
        pm_close_tick       = prices[-1],
        pm_vol_total        = total_vol,
        ticks_available     = True,
    )


# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# TICK SCORE ADJUSTMENT
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

def apply_tick_score_adj(base_score: int,
                         tf: TickFeatures,
                         pm_open_valid: bool = True) -> tuple:
    """
    Adjust v3 base score with tick-derived signals.

    Only fires when tick data is available AND pm_open_valid is True.
    Returns (adjusted_score, tick_score_delta, gate_notes).

    All adjustments derived from backtest data findings:
      buy_pressure < 35%:   sell side dominant in PM Ã¢Â†Â’ A=Ã¢ÂˆÂ’13.7% analog
      large_print > 20%:    institutional block prints Ã¢Â†Â’ quiet distribution
      proxy_vpin > 0.55:    elevated order flow toxicity
      tick_rate > 50/min:   active algo environment Ã¢Â†Â’ A=Ã¢ÂˆÂ’13.4%
      running_dp_proxy > 25: large-print ratio elevated

    CALIBRATION STATUS:
      These thresholds are INITIAL estimates based on the OHLCV backtest findings.
      They have NOT been directly validated against tick-level session data.
      As tick sessions accumulate, thresholds should be retrained.
      Mark as CALIBRATION_v1 until 50+ sessions validated.
    """
    if not tf.ticks_available or not pm_open_valid:
        return base_score, 0, []

    delta = 0
    notes = []

    v = tf.buy_pressure_pct
    if v is not None:
        if v < 35.0:
            delta += 10
            notes.append(f"LOW_BUY_PRESSURE({v:.0f}%): +10 (sellers dominant)")
        elif v > 65.0:
            delta -= 10
            notes.append(f"HIGH_BUY_PRESSURE({v:.0f}%): Ã¢ÂˆÂ’10 (buyers active)")

    v = tf.large_print_pct
    if v is not None and v > 20.0:
        delta += 8
        notes.append(f"LARGE_PRINTS({v:.0f}%): +8 (institutional proxy)")

    v = tf.proxy_vpin
    if v is not None:
        if v > 0.55:
            delta += 6
            notes.append(f"HIGH_VPIN({v:.3f}): +6 (toxic order flow)")
        elif v < 0.20:
            delta -= 5
            notes.append(f"LOW_VPIN({v:.3f}): Ã¢ÂˆÂ’5 (benign order flow)")

    v = tf.tick_rate_pm
    if v is not None and v > 50.0:
        delta += 5
        notes.append(f"HIGH_TICK_RATE({v:.0f}/min): +5 (algo positioning)")

    v = tf.running_dp_proxy
    if v is not None and v > 25.0:
        delta += 8
        notes.append(f"DP_PROXY_ELEVATED({v:.0f}%): +8 (quiet distribution)")

    adjusted = max(0, min(150, base_score + delta))
    return adjusted, delta, notes


# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# V4 CLASSIFICATION Ã¢Â€Â” wraps v3 + adds tick layer
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

def run_classification_v4(ticker: str, bars: List[Bar],
                           ticks: List[TickPrint] = None,
                           session_date: str = None,
                           no_sec: bool = False,
                           float_shares: int = 0) -> tuple:
    """
    Full v4 classification: v3 OHLCV + optional tick score adjustment.

    Returns (ClassifierSignal, TickFeatures).

    The ClassifierSignal is identical to v3 output EXCEPT:
      - sig.score may be adjusted by tick layer (if ticks available)
      - sig.tier may shift if tick adjustment crosses tier boundary
      - sig.reasons/warnings include tick gate notes

    Temporal safety:
      - v3 classification uses only bars received so far (live-safe)
      - Tick features use PM window only (finalized at 9:30am ET)
      - No HOD-anchored tick windows used
    """
    # Ã¢Â”Â€Ã¢Â”Â€ v3 base classification Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    sig = run_classification(ticker, bars,
                             session_date=session_date,
                             no_sec=no_sec,
                             float_shares=float_shares)

    # Ã¢Â”Â€Ã¢Â”Â€ Tick feature computation Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    if ticks:
        pm_open_price = sig.pm_open_price
        pm_open_valid = (pm_open_price is not None and pm_open_price > 0)

        tf = compute_tick_features(
            ticks,
            pm_open_price = pm_open_price,
            start_et      = PM_START_ET,
            end_et        = PM_END_ET,
        )

        # Apply tick score adjustment
        adj_score, tick_delta, tick_notes = apply_tick_score_adj(
            sig.score, tf, pm_open_valid
        )

        # Update score and tier if tick layer fired
        if tick_delta != 0:
            sig.score = adj_score
            # Recompute tier
            if   sig.score >= 50: sig.tier = 'HIGH'
            elif sig.score >= 25: sig.tier = 'MEDIUM'
            elif sig.score >= 10: sig.tier = 'LOW'
            else:                 sig.tier = 'SKIP'

        # Attach tick notes to reasons/warnings
        for note in tick_notes:
            if note.startswith('LOW_BUY') or note.startswith('HIGH_VPIN') or \
               note.startswith('LARGE') or note.startswith('DP_PROXY') or \
               note.startswith('HIGH_TICK'):
                sig.reasons.append(f"[TICK] {note}")
            else:
                sig.warnings.append(f"[TICK] {note}")

        # Store on signal for JSON output
        tf.tick_score_delta = tick_delta
        tf.tick_gate_notes  = tick_notes

    else:
        tf = TickFeatures(ticks_available=False)

    return sig, tf


# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# TICK DISPLAY
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

def print_tick_features(tf: TickFeatures):
    """Print tick layer summary row in the classifier output."""
    if not tf.ticks_available:
        # Only print unavailable if ticks were explicitly expected
        # (i.e., --ticks flag was set but data didn't come back)
        # Suppress silently when running OHLCV-only mode
        return

    vpin_c  = RED if (tf.proxy_vpin or 0) > 0.55 else (
              YEL if (tf.proxy_vpin or 0) > 0.35 else GRN)
    buy_c   = RED if (tf.buy_pressure_pct or 50) > 65 else (
              GRN if (tf.buy_pressure_pct or 50) < 35 else DIM)
    lp_c    = GRN if (tf.large_print_pct or 0) > 20 else DIM
    rate_c  = GRN if (tf.tick_rate_pm or 0) > 50 else DIM
    delta_c = GRN if tf.tick_score_delta > 0 else (
              RED if tf.tick_score_delta < 0 else DIM)

    print(f"  {'Ã¢Â”Â€'*68}")
    print(f"  {CYN}TICK:{RESET}  "
          f"n={tf.tick_count_pm:>5,}  "
          f"Rate:{rate_c}{tf.tick_rate_pm or 0:.0f}/min{RESET}  "
          f"VPIN:{vpin_c}{tf.proxy_vpin or 0:.3f}{RESET}  "
          f"Buy:{buy_c}{tf.buy_pressure_pct or 0:.0f}%{RESET}  "
          f"Sell:{tf.sell_pressure_pct or 0:.0f}%")
    print(f"         LargePrint:{lp_c}{tf.large_print_pct or 0:.0f}%{RESET}  "
          f"DPproxy:{tf.running_dp_proxy or 0:.0f}%  "
          f"PathEff:{tf.price_path_eff or 0:.3f}  "
          f"ScoreÃŽÂ”:{delta_c}{tf.tick_score_delta:+d}{RESET}")
    if tf.tick_gate_notes:
        print(f"  {CYN}         {' | '.join(tf.tick_gate_notes[:3])}{RESET}")


# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â
# MAIN Ã¢Â€Â” v4 CLI (extends v3 with --ticks flag)
# Ã¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•ÂÃ¢Â•Â

def main():
    p = argparse.ArgumentParser(
        description='Cat5ive Classifier v4.0 Ã¢Â€Â” OHLCV + Tick Layer')
    p.add_argument('tickers', nargs='+')
    p.add_argument('--date',       default=None,
                   help='YYYY-MM-DD Ã¢Â€Â” historical session date')
    p.add_argument('--time',       default=None,
                   help='HH:MM ET Ã¢Â€Â” snapshot time for backtesting '
                        '(truncates bars to this point). '
                        'Example: --date 2026-05-06 --time 09:35 --once')
    p.add_argument('--no-sec',     action='store_true')
    p.add_argument('--interval',   type=int, default=90)
    p.add_argument('--once',       action='store_true')
    p.add_argument('--json',       action='store_true')
    p.add_argument('--quiet',      action='store_true')
    p.add_argument('--high-value-only', action='store_true')
    p.add_argument('--min-quality',    type=int, default=0)
    p.add_argument('--config',     default=None)
    p.add_argument('--log-dir',    default=None)
    p.add_argument('--no-float',   action='store_true')
    # v4 additions
    p.add_argument('--ticks',      action='store_true',
                   help='Enable Tradier tick data layer (requires TRADIER_API_KEY)')
    p.add_argument('--tick-window-start', type=float, default=4.0,
                   help='PM tick window start in ET hours (default 4.0 = 4am)')
    p.add_argument('--tick-window-end', type=float, default=9.5,
                   help='PM tick window end in ET hours (default 9.5 = 9:30am)')
    p.add_argument('--tick-only-once', action='store_true',
                   help='Fetch ticks once at startup then reuse (faster polling)')

    args    = p.parse_args()
    tickers = [t.upper() for t in args.tickers]
    tradier_key, polygon_key, fmp_key = load_keys(args.config)
    session_date = args.date or date.today().isoformat()
    log_dir = args.log_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'classifier_logs')

    if not args.json:
        print(f"\n{BOLD}{'='*64}")
        print(f"CAT5IVE CLASSIFIER v4.0  {'(+ TICK LAYER)' if args.ticks else ''}")
        print(f"{'='*64}{RESET}")
        print(f"  Date:     {session_date}"
              + (f"  @{args.time} ET (snapshot)" if args.time else ""))
        print(f"  Tickers:  {', '.join(tickers)}")
        src = 'Tradier' if tradier_key else 'Polygon' if polygon_key else 'yfinance'
        print(f"  Bars:     {src}")
        if tradier_key:
            print(f"  Ticks:    Tradier (auto Ã¢Â€Â” same key as bars)  "
                  f"window={args.tick_window_start:.1f}h-{args.tick_window_end:.1f}h ET")
        elif args.ticks:
            print(f"  Ticks:    UNAVAILABLE Ã¢Â€Â” no Tradier key found")
        print(f"  Interval: {args.interval}s  "
              f"Mode: {'once' if args.once else 'continuous'}")
        print(f"{BOLD}{'='*64}{RESET}\n")

    # Ã¢Â”Â€Ã¢Â”Â€ Prefetch float shares Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    float_map = {}
    if not args.no_float:
        for tkr in tickers:
            fs = fetch_float_shares(tkr, fmp_key)
            float_map[tkr] = fs
            if not args.json and fs > 0:
                print(f"  {tkr:8} float: {GRN}{fs/1e6:.2f}M{RESET}")
            elif not args.json:
                print(f"  {tkr:8} float: {YEL}not found{RESET}")

    # Ã¢Â”Â€Ã¢Â”Â€ Prefetch ticks (optional) Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
    tick_cache: Dict[str, List[TickPrint]] = {}
    if args.tick_only_once and tradier_key:  # auto-use Tradier key
        if not args.json:
            print(f"\n  Prefetching PM ticks [{args.tick_window_start:.1f}h-"
                  f"{args.tick_window_end:.1f}h ET]...")
        for tkr in tickers:
            ticks = fetch_tradier_ticks(
                tkr, session_date, tradier_key,
                args.tick_window_start, args.tick_window_end)
            tick_cache[tkr] = ticks
            if not args.json:
                print(f"  {tkr:8} {len(ticks):>6,} tick prints loaded")

    poll_count = 0
    try:
        while True:
            poll_count += 1
            now = datetime.now()

            if not args.json:
                print(f"{DIM}[poll {poll_count}] {now.strftime('%H:%M:%S')} ET{RESET}")

            if not args.date and (now.hour < 4 or now.hour >= 20):
                if not args.json:
                    print(f"  {DIM}Outside 4am-8pm ET Ã¢Â€Â” sleeping{RESET}")
                if args.once: break
                time.sleep(args.interval)
                continue

            for tkr in tickers:
                try:
                    if not args.json:
                        print(f"  {tkr:8} {DIM}fetching bars...{RESET}", end='\r', flush=True)

                    bars = _v3.get_bars(tkr, session_date, tradier_key, polygon_key)

                    # --time: truncate bars to the requested snapshot time
                    # This shows exactly what the classifier would have said
                    # at that moment Ã¢Â€Â” no future data, strict temporal safety.
                    if args.time and bars:
                        cutoff = args.time.strip()[:5]  # 'HH:MM'
                        bars   = [b for b in bars if b.ts <= cutoff]
                        if not bars:
                            if not args.json:
                                print(f"  {tkr:8} No bars before {cutoff} "
                                      f"on {session_date}")
                            continue

                    if args.date and not bars:
                        if not args.json:
                            print(f"  {tkr:8} No bars for {session_date}")
                        continue

                    # Fetch ticks per-poll unless --tick-only-once
                    ticks_for_session = []
                    # Auto-use Tradier key for ticks Ã¢Â€Â” same key as bars.
                    # --ticks flag still respected but not required.
                    _use_ticks = tradier_key and (args.ticks or tradier_key)
                    if _use_ticks:
                        if args.tick_only_once:
                            ticks_for_session = tick_cache.get(tkr, [])
                        else:
                            ticks_for_session = fetch_tradier_ticks(
                                tkr, session_date, tradier_key,
                                args.tick_window_start, args.tick_window_end)

                    fs  = float_map.get(tkr, 0)
                    sig, tf = run_classification_v4(
                        tkr, bars,
                        ticks        = ticks_for_session,  # auto from Tradier key
                        session_date = session_date,
                        no_sec       = args.no_sec,
                        float_shares = fs,
                    )

                    log_signal(sig, log_dir)

                    if args.high_value_only and sig.signal in ('WAIT', 'SKIP'):
                        if not args.json:
                            print(f"  {tkr:8} {DIM}{sig.signal} (filtered){RESET}      ")
                        continue
                    if sig.quality_score < args.min_quality:
                        continue

                    if args.json:
                        out = asdict(sig)
                        out['tick_features'] = asdict(tf)
                        print(json.dumps(out))
                    else:
                        # Store tf on sig so print_signal can access it
                        sig._tick_features = tf
                        print_signal(sig, verbose=not args.quiet)
                        if tf.ticks_available:
                            print_tick_features(tf)

                except Exception as e:
                    if not args.json:
                        print(f"  {tkr:8} {RED}Error: {e}{RESET}")

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

