#!/usr/bin/env python3
"""
STATUS.INQUISIT v2 - Upward Spike Classifier for Open Short Positions
======================================================================
8-layer spike classification system for Cat5ive open short positions.

LAYERS:
  1. Dual threshold  - fixed 5% tiers AND ATR-relative tiers side-by-side
  2. Terminal class  - A (reversal) / B (temporary) / C (clean) / D (chop)
  3. Time-to-threshold  - velocity buckets from backtest ret_Nmin series
  4. Momentum derivatives - first + second derivatives of price/volume
  5. Spike state taxonomy  - 8 states from INITIATION to DOWNSIDE_PRESSURE
  6. High-water mark + drawdown from HWM
  7. Forward-looking metrics - prob_reach_next_tier, prob_reverse, prob_stop
  8. Databento tick layer  - architecture ready, activates when data flows

USAGE:
  python status_inquisit.py --analyze
  python status_inquisit.py --ticker LABT --entry 5.42
  python status_inquisit.py --ticker LABT --entry 5.42 --entry-time 09:47
  python status_inquisit.py --ticker LABT --entry 5.42 --date 2026-06-09 --time 10:30 --once
  python status_inquisit.py --analyze --report

APP INTEGRATION (--json):
  Add --json to either live mode (--ticker --entry) or pretrade mode
  (--ticker --pretrade) to emit a single JSON object on stdout instead of
  colored CLI text. Combine with --once for a single snapshot, suitable for
  spawning as a subprocess (mirrors cat5ive_classifier_v3.py's --json --once
  convention used elsewhere in this app).
"""

import os, sys, csv, json, time, math, argparse, statistics
from datetime import datetime, date
from dataclasses import dataclass, field, asdict
from collections import defaultdict
from typing import Optional, List, Dict, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

RESULTS_DIR = os.path.join(os.path.dirname(__file__), 'dual_results')
RET_INTERVALS = [1,2,3,4,5,10,15,20,25,30,35,40,45,50,55,60,70,80,90,100,110,120]

# Layer 1A - Fixed 5% tiers
FIXED_TIERS = [
    (0,   5,   'NOISE',    'normal fluctuation'),
    (5,   10,  'MINOR',    '5% bounce threshold'),
    (10,  15,  'MODERATE', 'danger zone'),
    (15,  25,  'MAJOR',    'cover or exit'),
    (25,  999, 'EXTREME',  'squeeze / stop'),
]

# Layer 1B - ATR-relative multipliers
ATR_TIERS = [
    (0.0,  0.5, 'NOISE',    '< 0.5x ATR'),
    (0.5,  1.0, 'MINOR',    '0.5-1x ATR'),
    (1.0,  2.0, 'MODERATE', '1-2x ATR'),
    (2.0,  3.0, 'MAJOR',    '2-3x ATR'),
    (3.0,  999, 'EXTREME',  '> 3x ATR'),
]

# Layer 5 - Spike state labels
SPIKE_STATES = {
    'SPIKE_INITIATION': 'Early stage, direction unclear',
    'CONTINUATION':     'Spike accelerating with volume support',
    'EXHAUSTION':       'Spike slowing, volume fading',
    'ABSORPTION':       'Sellers absorbing buyers at spike peak',
    'FAILED_BREAKOUT':  'Crossed tier then retreated - spike losing conviction',
    'DISTRIBUTION':     'High volume at peak - institutional selling into buying',
    'LIQUIDITY_VACUUM': 'Fast move with thin volume - dangerous',
    'DOWNSIDE_PRESSURE':'Stock accelerating below entry - thesis on track',
}

# CLI colors
GRN='\033[32m'; GRN2='\033[92m'; RED='\033[31m'; RED2='\033[91m'
YEL='\033[33m'; CYN='\033[36m';  DIM='\033[2m';  WHT='\033[97m'
MAG='\033[35m'; BOLD='\033[1m';  RST='\033[0m'


# ─────────────────────────────────────────────────────────────────────────────
# DATA HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _flt(v) -> Optional[float]:
    try: return float(v) if v not in (None,'','None','nan') else None
    except: return None

def _tier_fixed(pct: float) -> Tuple[str,str]:
    for lo,hi,name,label in FIXED_TIERS:
        if lo <= pct < hi: return name, label
    return 'EXTREME','squeeze'

def _tier_atr(pct: float, atr_pct: float) -> Tuple[str,str]:
    if atr_pct <= 0: return 'UNKNOWN','no ATR data'
    mult = pct / atr_pct
    for lo,hi,name,label in ATR_TIERS:
        if lo <= mult < hi: return name, label
    return 'EXTREME','> 3x ATR'

def _is_winner(row: dict) -> bool:
    r = _flt(row.get('a_ret_rth_close'))
    return r is not None and r < 0

def _is_quality(row: dict) -> bool:
    wc = _flt(row.get('wc_score') or 0) or 0
    qd = _flt(row.get('quiet_dump_flag') or 0) or 0
    return wc >= 4 and qd >= 0.5


# ─────────────────────────────────────────────────────────────────────────────
# DATA STRUCTURES
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TerminalClass:
    """Distribution of terminal classes for sessions at a spike tier."""
    tier:      str
    n_total:   int   = 0
    n_a:       int   = 0   # reversal - closed above entry
    n_b:       int   = 0   # temporary - recovered below entry
    n_c:       int   = 0   # clean - never crossed +5%
    n_d:       int   = 0   # chop - stayed within +-5%
    # Velocity sub-buckets
    n_b_fast:  int   = 0   # Class B sessions where spike was fast (<15min)
    n_b_slow:  int   = 0   # Class B sessions where spike was slow (>45min)
    n_a_fast:  int   = 0
    n_a_slow:  int   = 0
    # ATR-adjusted equivalent tier count
    n_atr_match: int = 0

    def prob(self, cls: str) -> float:
        if self.n_total == 0: return 0.0
        return {'A':self.n_a,'B':self.n_b,'C':self.n_c,'D':self.n_d}.get(cls,0) / self.n_total * 100

    def recovery_rate(self) -> float:
        """% of sessions at this tier that still closed below entry (B+C)."""
        return (self.n_b + self.n_c) / self.n_total * 100 if self.n_total else 0


@dataclass
class VelocityProfile:
    """Spike velocity profile - how fast did sessions reach each tier?"""
    tier:       str
    ultra_n:    int   = 0   # reached tier in < 5 min  (squeeze/halt/vacuum)
    ultra_rec:  int   = 0
    fast_n:     int   = 0   # 5-15 min  (active buying)
    fast_rec:   int   = 0
    mod_n:      int   = 0   # 15-45 min
    mod_rec:    int   = 0
    slow_n:     int   = 0   # > 45 min
    slow_rec:   int   = 0
    avg_bars_to_tier: float = 0.0

    def ultra_recovery(self) -> float:
        return self.ultra_rec / self.ultra_n * 100 if self.ultra_n else 0
    def fast_recovery(self) -> float:
        return self.fast_rec / self.fast_n * 100 if self.fast_n else 0
    def mod_recovery(self) -> float:
        return self.mod_rec / self.mod_n * 100 if self.mod_n else 0
    def slow_recovery(self) -> float:
        return self.slow_rec / self.slow_n * 100 if self.slow_n else 0


@dataclass
class L1Profile:
    """
    Aggregated L1 microstructure stats from backtest sessions, split by
    terminal class. Only populated when the CSV has real Databento-derived
    L1 columns (a_spread_bps_entry etc.) - gracefully empty otherwise.
    """
    n_with_l1:            int = 0    # sessions with any L1 data at all
    n_excluded_outliers:  int = 0    # sessions dropped for absurd values
    avg_spread_widening_a: Optional[float] = None  # Class A (reversal) sessions
    avg_spread_widening_b: Optional[float] = None  # Class B (temporary) sessions
    avg_microprice_drift_a: Optional[float] = None
    avg_microprice_drift_b: Optional[float] = None
    n_a: int = 0
    n_b: int = 0


@dataclass
class ForwardMetrics:
    """Forward-looking probability estimates."""
    prob_reach_next_tier: float = 0.0   # % that go on to next 5% tier
    prob_reverse_below_entry: float = 0.0  # % that recover below entry
    prob_stop_hit: float = 0.0          # % that hit 20%+ adverse
    median_time_to_peak_min: float = 0.0  # median bars until HWM is set


@dataclass
class LiveSpikeResult:
    """Complete live spike assessment."""
    ticker:          str
    entry_price:     float
    current_price:   float
    spike_pct:       float
    elapsed_min:     float
    hwm_pct:         float    # GLOBAL high-water mark % from entry (all bars)
    hwm_drawdown:    float    # % current price is below GLOBAL HWM
    # Layer 1 - Dual threshold
    fixed_tier:      str
    atr_tier:        str
    atr_pct:         float    # ATR as % of entry price
    tiers_agree:     bool
    recent_hwm_pct:      float = 0.0   # ROLLING high-water mark (last N bars)
    recent_hwm_drawdown: float = 0.0   # % current price is below ROLLING HWM
    # Layer 2 - Terminal class distribution
    term_class:      Optional[TerminalClass] = None
    # Layer 3 - Velocity
    vel_profile:     Optional[VelocityProfile] = None
    velocity_bucket: str = ''  # 'fast' / 'moderate' / 'slow'
    # Layer 4 - Momentum derivatives
    price_velocity:  float = 0.0   # $/min
    price_accel:     float = 0.0   # velocity change
    volume_velocity: float = 0.0   # ratio vs avg
    volume_accel:    float = 0.0
    # Layer 5 - State
    state:           str = 'UNKNOWN'
    state_run_length: int = 0   # consecutive trailing bars with this same state;
                                 # used to distinguish DISTRIBUTION "forming" (1-2 bars)
                                 # from "confirmed" (3+), matching the first-appearance
                                 # study finding that DISTRIBUTION confirmed is the only
                                 # classification where the blip-to-confirmed gap is large
                                 # enough to meaningfully change the action recommendation.
    # Layer 7 - Forward
    forward:         Optional[ForwardMetrics] = None
    # Comparables
    comparables:     List[dict] = field(default_factory=list)
    # Layer 1C - L1 microstructure (Tradier live / Databento bbo-* backtest)
    l1_available:        bool  = False
    spread_bps:           float = 0.0
    microprice:           float = 0.0
    top_depth_imbalance:  float = 0.0   # +1 = all bid size, -1 = all ask size
    spread_widening_pct:  Optional[float] = None
    quote_changed:        Optional[bool]  = None


# ─────────────────────────────────────────────────────────────────────────────
# LAYER 2+3+7 - BACKTEST PROFILE BUILDER
# ─────────────────────────────────────────────────────────────────────────────

def _classify_terminal(row: dict) -> str:
    """Assign terminal class A/B/C/D to a backtest session."""
    mae = abs(_flt(row.get('a_mae_pct')) or 0)
    ret = _flt(row.get('a_ret_rth_close'))
    if ret is None: return 'D'
    crossed_5 = mae >= 5.0
    if not crossed_5:
        return 'C' if ret < 0 else 'D'
    return 'B' if ret < 0 else 'A'

def _time_to_tier(row: dict, threshold_pct: float) -> Optional[int]:
    """Return the 5-min interval bar at which session first crossed threshold_pct adverse."""
    for t in RET_INTERVALS:
        ret = _flt(row.get(f'a_ret_{t}min'))
        if ret is not None and ret >= threshold_pct:
            return t
    return None

def build_profiles(rows: List[dict]) -> Dict:
    """Build all Layer 2/3/7 profiles from backtest rows."""
    tc   = {tier: TerminalClass(tier=tier) for _,_,tier,_ in FIXED_TIERS}
    vel  = {tier: VelocityProfile(tier=tier) for _,_,tier,_ in FIXED_TIERS}
    fwd  = {tier: ForwardMetrics() for _,_,tier,_ in FIXED_TIERS}

    # Track raw data for forward metric computation
    raw  = {tier: {'next_hit':[], 'recovered':[], 'stop_hit':[], 'time_to_peak':[]}
            for _,_,tier,_ in FIXED_TIERS}

    # Dual-threshold agreement: computed ONCE per session using its actual
    # MAE (not per cumulative tier boundary - that was the bug). Only
    # counted for sessions that reached at least MINOR (mae>=5) and have
    # valid ATR data, since NOISE-tier sessions trivially "agree" by
    # definition (0% is always NOISE under both systems).
    dual_total = 0
    dual_agree = 0

    for row in rows:
        mae    = abs(_flt(row.get('a_mae_pct')) or 0)
        mfe    = abs(_flt(row.get('a_mfe_pct')) or 0)
        ret    = _flt(row.get('a_ret_rth_close'))
        atr_e  = _flt(row.get('a_atr_at_entry')) or 0
        ep     = _flt(row.get('a_entry_price')) or 0
        atr_pct = (atr_e / ep * 100) if ep > 0 and atr_e > 0 else 0
        cls    = _classify_terminal(row)
        won    = ret is not None and ret < 0

        # Single per-session dual-threshold check (fixed) on real spike data
        if atr_pct > 0 and mae >= 5.0:
            fixed_t, _ = _tier_fixed(mae)
            atr_t,   _ = _tier_atr(mae, atr_pct)
            dual_total += 1
            if fixed_t == atr_t:
                dual_agree += 1

        # For each tier this session reached:
        tiers_hit = [name for lo,_,name,_ in FIXED_TIERS if mae >= lo]

        for lo, hi, tier, _ in FIXED_TIERS:
            if mae < lo: continue  # session didn't reach this tier
            p = tc[tier]; v = vel[tier]; r = raw[tier]

            p.n_total += 1
            if   cls == 'A': p.n_a += 1
            elif cls == 'B': p.n_b += 1
            elif cls == 'C': p.n_c += 1
            else:            p.n_d += 1

            # (dual-threshold agreement is computed separately, once per
            #  session, using actual MAE - see dual_total/dual_agree below)

            # Velocity - when did session first cross this tier's lower bound?
            # NOISE (lo=0) is skipped: every session starts there at t=0,
            # so "time to cross" is not a meaningful concept for it.
            if lo > 0:
                t_cross = _time_to_tier(row, lo)
                if t_cross is not None:
                    v.avg_bars_to_tier = ((v.avg_bars_to_tier * (p.n_total-1) + t_cross)
                                           / p.n_total)
                    if t_cross < 5:        # ultra-fast: [0,5) min - squeeze/halt/vacuum
                        v.ultra_n += 1
                        if won: v.ultra_rec += 1
                    elif t_cross < 15:     # fast: [5,15) min - active buying
                        v.fast_n += 1
                        if won: v.fast_rec += 1
                        if cls=='A': p.n_a_fast+=1
                        if cls=='B': p.n_b_fast+=1
                    elif t_cross < 45:     # moderate: [15,45) min
                        v.mod_n += 1
                        if won: v.mod_rec += 1
                    else:                  # slow: [45,inf) min
                        v.slow_n += 1
                        if won: v.slow_rec += 1
                        if cls=='B': p.n_b_slow+=1

            # Forward metrics raw data
            next_lo = hi  # next tier's lower bound
            if next_lo < 999:
                r['next_hit'].append(1 if mae >= next_lo else 0)
            r['recovered'].append(1 if won else 0)
            r['stop_hit'].append(1 if mae >= 20 else 0)
            # Time to peak: find bar where return was max adverse
            peak_t = None
            peak_v = 0.0
            for t in RET_INTERVALS:
                rv = _flt(row.get(f'a_ret_{t}min'))
                if rv is not None and rv > peak_v:
                    peak_v = rv; peak_t = t
            if peak_t:
                r['time_to_peak'].append(peak_t)

    # Compute forward metric averages
    for _, _, tier, _ in FIXED_TIERS:
        r = raw[tier]
        f = fwd[tier]
        if r['next_hit']:
            f.prob_reach_next_tier = sum(r['next_hit'])/len(r['next_hit'])*100
        if r['recovered']:
            f.prob_reverse_below_entry = sum(r['recovered'])/len(r['recovered'])*100
        if r['stop_hit']:
            f.prob_stop_hit = sum(r['stop_hit'])/len(r['stop_hit'])*100
        if r['time_to_peak']:
            f.median_time_to_peak_min = statistics.median(r['time_to_peak'])

    return {'tc': tc, 'vel': vel, 'fwd': fwd,
            'dual_total': dual_total, 'dual_agree': dual_agree}


def build_comparables(rows: List[dict], spike_pct: float,
                       tol: float = 3.0) -> List[dict]:
    out = []
    for row in rows:
        mae = abs(_flt(row.get('a_mae_pct')) or 0)
        if abs(mae - spike_pct) > tol: continue
        ret = _flt(row.get('a_ret_rth_close'))
        out.append({
            'ticker': row.get('ticker',''), 'date': row.get('date',''),
            'mae': mae, 'final': ret, 'cls': _classify_terminal(row),
            'winner': ret is not None and ret < 0,
            'quality': _is_quality(row),
            'wc': _flt(row.get('wc_score')) or 0,
            'chop': _flt(row.get('chop')) or 0,
        })
    out.sort(key=lambda x: abs(x['mae'] - spike_pct))
    return out[:8]


def build_l1_profile(rows: List[dict]) -> L1Profile:
    """
    Aggregate L1 microstructure stats (spread widening, microprice drift)
    split by terminal class A vs B - does spread behavior during a spike
    actually distinguish a real reversal (A) from a temporary one (B)?

    Graceful fallback: if the CSV was built before a backtest run with a
    Databento key (i.e. these columns are all None/missing), returns an
    empty L1Profile rather than crashing or showing fabricated zeros.

    Outlier guard: values beyond +-1000% are excluded from the average and
    counted in n_excluded_outliers. These are near-zero-denominator
    artifacts (e.g. a degenerate entry quote), not real findings - a single
    such value can otherwise swing a 45-session average by orders of
    magnitude, as happened with an early run of this exact pipeline.
    """
    SANITY_BOUND = 1000.0
    p = L1Profile()
    sw_a, sw_b, md_a, md_b = [], [], [], []

    for row in rows:
        sw = _flt(row.get('a_spread_widening_pct_mae'))
        md = _flt(row.get('a_microprice_drift_pct'))
        if sw is None and md is None:
            continue  # no L1 data for this session - skip, don't fabricate
        p.n_with_l1 += 1
        cls = _classify_terminal(row)

        if sw is not None and abs(sw) > SANITY_BOUND:
            p.n_excluded_outliers += 1
            sw = None
        if md is not None and abs(md) > SANITY_BOUND:
            p.n_excluded_outliers += 1
            md = None

        if cls == 'A':
            p.n_a += 1
            if sw is not None: sw_a.append(sw)
            if md is not None: md_a.append(md)
        elif cls == 'B':
            p.n_b += 1
            if sw is not None: sw_b.append(sw)
            if md is not None: md_b.append(md)

    if sw_a: p.avg_spread_widening_a  = statistics.mean(sw_a)
    if sw_b: p.avg_spread_widening_b  = statistics.mean(sw_b)
    if md_a: p.avg_microprice_drift_a = statistics.mean(md_a)
    if md_b: p.avg_microprice_drift_b = statistics.mean(md_b)
    return p


# ─────────────────────────────────────────────────────────────────────────────
# LAYER 4 - MOMENTUM DERIVATIVES
# ─────────────────────────────────────────────────────────────────────────────

def compute_derivatives(bars: list, current_price: float = 0) -> Dict:
    """Compute first + second derivatives of price and volume from 1-min bars."""
    if len(bars) < 3:
        return {'price_vel':0,'price_vel_pct':0,'price_accel':0,'price_accel_pct':0,'vol_vel':1.0,'vol_accel':0}

    closes = [b.get('close', b.get('c', 0)) for b in bars[-8:]]
    vols   = [b.get('volume', b.get('v', 0)) for b in bars[-8:]]

    # First derivative: price velocity ($/min) over last 5 bars
    def slope(series, n=5):
        s = series[-n:] if len(series) >= n else series
        if len(s) < 2: return 0.0
        return (s[-1] - s[0]) / max(len(s)-1, 1)

    price_vel   = slope(closes, 5)
    price_vel2  = slope(closes, 3)    # recent 3 bars
    price_accel = price_vel2 - price_vel  # +ve = accelerating, -ve = decelerating

    # Percentage-normalized velocity (%/min) - scale-invariant, used for
    # threshold comparisons (e.g. LIQUIDITY_VACUUM) that need to mean the
    # same thing on a $0.50 stock as on a $20 stock. A flat dollar threshold
    # would otherwise be ~40x more sensitive on the cheaper name. Falls back
    # to the most recent close if current_price isn't supplied.
    ref_price = current_price or (closes[-1] if closes else 0)
    price_vel_pct = (price_vel / ref_price * 100) if ref_price > 0 else 0
    price_accel_pct = (price_accel / ref_price * 100) if ref_price > 0 else 0

    avg_vol = statistics.mean(vols[:-1]) if len(vols) > 1 else 1
    vol_vel = vols[-1] / avg_vol if avg_vol > 0 else 1.0
    vol_vel_prev = (vols[-2] / avg_vol) if len(vols) >= 2 and avg_vol > 0 else vol_vel
    vol_accel = vol_vel - vol_vel_prev

    return {
        'price_vel':       round(price_vel, 4),
        'price_vel_pct':   round(price_vel_pct, 4),
        'price_accel':     round(price_accel, 4),
        'price_accel_pct': round(price_accel_pct, 4),
        'vol_vel':         round(vol_vel, 3),
        'vol_accel':     round(vol_accel, 3),
    }


# ─────────────────────────────────────────────────────────────────────────────
# LAYER 5 - SPIKE STATE TAXONOMY
# ─────────────────────────────────────────────────────────────────────────────

def _spike_conditions(spike_pct: float, hwm_pct: float, hwm_drawdown: float,
                      price_vel: float, price_accel: float,
                      vol_vel: float, vol_accel: float,
                      price_vel_pct: float = None, price_accel_pct: float = None,
                      local_swing_pct: float = None) -> Dict[str, bool]:
    """
    Single source of truth for every named state's boolean condition.
    classify_state() picks the first True one in priority order below; the
    replay/audit feature inspects ALL of them independently, so it can show
    when each condition was first satisfied even if a higher-priority one
    had already "won" that bar. Keeping this in one place means the replay
    audit trail can never silently drift from what the live classifier
    actually does.

    price_vel_pct/price_accel_pct (both %/min, optional): scale-invariant
    versions of price_vel/price_accel. Only CONTINUATION and EXHAUSTION use
    magnitude thresholds on these - DISTRIBUTION and ABSORPTION only check
    their *sign* (<=0 / >=0), which is already scale-invariant and needs no
    fix. Falls back to the old raw-dollar comparison if not supplied.

    local_swing_pct (optional): used as the "has this spike grown large
    enough to matter" gate (>=5%/>=8%) instead of hwm_pct. hwm_pct is
    expressed relative to entry_price, which is fine for the live monitor
    (a real position entry that doesn't drift) but breaks down across a
    long pretrade replay - once price has moved far enough from the
    session's original reference point, hwm_pct becomes permanently,
    trivially true, turning these gates into no-ops and leaving only the
    other (well-scaled) conditions to fire on every ordinary bar-to-bar
    wiggle. local_swing_pct is self-contained to the recent window, so it
    stays meaningful regardless of how far the overall session has
    drifted. Falls back to hwm_pct if not supplied - for a normal session
    that hasn't drifted far, the two are nearly identical anyway, so this
    is a safe default with no behavior change for typical cases.
    """
    fast_move = (abs(price_vel_pct) > 0.4 if price_vel_pct is not None
                else abs(price_vel) > 0.02)
    # CONTINUATION's "pushing forward" bar: 0.1%/min preserves the original
    # 0.005$/min threshold's intent at ~$5/share, scale-invariant elsewhere.
    pushing = (price_vel_pct > 0.1 if price_vel_pct is not None
              else price_vel > 0.005)
    # EXHAUSTION's "weakening" bar: -0.1%/min preserves -0.005$/min's intent
    # at the same ~$5/share reference point.
    weakening = (price_accel_pct < -0.1 if price_accel_pct is not None
                else price_accel < -0.005)
    sig = local_swing_pct if local_swing_pct is not None else hwm_pct
    return {
        'DOWNSIDE_PRESSURE': spike_pct <= 0,
        'LIQUIDITY_VACUUM':  spike_pct > 0 and fast_move and vol_vel < 0.5,
        'DISTRIBUTION':      sig >= 8 and vol_vel >= 2.0 and hwm_drawdown <= -0.5 and price_vel <= 0,
        'FAILED_BREAKOUT':   sig >= 5.0 and hwm_drawdown <= -2.0,
        'ABSORPTION':        sig >= 5.0 and hwm_drawdown >= -1.5 and vol_vel >= 1.3 and price_accel <= 0,
        'EXHAUSTION':        sig >= 5.0 and price_vel >= 0 and weakening and vol_accel < 0,
        'CONTINUATION':      sig >= 5.0 and pushing and price_accel >= 0 and vol_accel >= 0,
    }


_STATE_PRIORITY = ('DOWNSIDE_PRESSURE', 'LIQUIDITY_VACUUM', 'DISTRIBUTION',
                   'FAILED_BREAKOUT', 'ABSORPTION', 'EXHAUSTION', 'CONTINUATION')


def _resolve_state(conds: Dict[str, bool]) -> str:
    """Single source of truth for priority resolution - given an already-
    computed conditions dict, returns the first True one in priority order,
    or SPIKE_INITIATION if none matched. Used by classify_state() (which
    computes conds itself) and by assess_pretrade() (which already has conds
    computed for its own audit-trail purposes, so it can resolve directly
    without classify_state() redundantly recomputing _spike_conditions())."""
    for name in _STATE_PRIORITY:
        if conds[name]:
            return name
    return 'SPIKE_INITIATION'


def classify_state(spike_pct: float, hwm_pct: float, hwm_drawdown: float,
                   price_vel: float, price_accel: float,
                   vol_vel: float, vol_accel: float,
                   elapsed_min: float, price_vel_pct: float = None,
                   price_accel_pct: float = None, local_swing_pct: float = None) -> str:
    """
    Derive spike state from derivatives and HWM data. Priority order below
    matters - e.g. LIQUIDITY_VACUUM takes priority over CONTINUATION since
    it signals dangerous gap conditions; a spike that reached MINOR+ and is
    now retreating is FAILED_BREAKOUT, not "early stage" just because it
    fell back under +5%.
    """
    conds = _spike_conditions(spike_pct, hwm_pct, hwm_drawdown, price_vel, price_accel,
                              vol_vel, vol_accel, price_vel_pct, price_accel_pct,
                              local_swing_pct)
    return _resolve_state(conds)


# ─────────────────────────────────────────────────────────────────────────────
# LAYER 8 - DATABENTO TICK LAYER (stub)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_tick_features(ticker: str, db_key: str,
                         session_date: str) -> Optional[Dict]:
    """
    Fetch tick-level features from Databento FINN.NLS.
    Architecture ready - activates when Databento key is available.
    Returns: signed_delta, trade_count_pm, large_print_ratio, aggressor_buy_ratio
    """
    if not db_key:
        return None
    try:
        import databento as db
        from datetime import datetime
        from zoneinfo import ZoneInfo
        client = db.Historical(db_key)

        # session_date + regular session hours are US/Eastern wall-clock.
        # Databento treats naive ISO timestamps as UTC, so convert explicitly -
        # otherwise this silently fetches the wrong ~4-5hr window (DST-dependent).
        et = ZoneInfo("America/New_York")
        start_et = datetime.strptime(f"{session_date} 09:30", "%Y-%m-%d %H:%M").replace(tzinfo=et)
        end_et   = datetime.strptime(f"{session_date} 16:00", "%Y-%m-%d %H:%M").replace(tzinfo=et)
        start = start_et.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S")
        end   = end_et.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S")

        # Fetch trades for the session
        data = client.timeseries.get_range(
            dataset='FINN.NLS', schema='trades', stype_in='raw_symbol',
            symbols=[ticker],
            start=start,
            end=end,
        )
        records = list(data)
        if not records: return None

        buy_vol  = sum(r.size for r in records if r.side == 'B')
        sell_vol = sum(r.size for r in records if r.side == 'S')
        total    = buy_vol + sell_vol
        sizes    = sorted(r.size for r in records)
        p95      = sizes[int(len(sizes)*0.95)] if sizes else 0
        large    = sum(r.size for r in records if r.size >= p95)
        delta    = buy_vol - sell_vol

        return {
            'signed_delta':       delta,
            'aggressor_buy_ratio': buy_vol / total * 100 if total else 50,
            'large_print_ratio':  large / total * 100 if total else 0,
            'trade_count':        len(records),
        }
    except Exception as e:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# LIVE DATA - TRADIER
# ─────────────────────────────────────────────────────────────────────────────

def fetch_bars(ticker: str, key: str,
               date_str: str = None, time_str: str = None) -> List[dict]:
    """Fetch 1-min bars from Tradier for live or historical snapshot."""
    try:
        import requests
        today = date_str or date.today().isoformat()
        start = f"{today} 04:00"
        end   = f"{today} {time_str or '20:00'}"
        r = requests.get(
            'https://api.tradier.com/v1/markets/timesales',
            params={'symbol':ticker,'interval':'1min',
                    'start':start,'end':end,'session_filter':'all'},
            headers={'Authorization':f'Bearer {key}','Accept':'application/json'},
            timeout=8
        )
        r.raise_for_status()
        bars = (r.json().get('series') or {}).get('data', [])
        if isinstance(bars, dict): bars = [bars]
        return bars or []
    except Exception as e:
        print(f"  [!] Bar fetch error: {e}")
        return []


# ─────────────────────────────────────────────────────────────────────────────
# L1 MICROSTRUCTURE - live (Tradier) + parity-matched backtest (Databento)
#
# Tradier /v1/markets/quotes returns bid/ask/bid_size/ask_size at the top of
# book - the SAME shape Databento's bbo-1m/bbo-1s schema provides for backtest
# (bid_px_00/ask_px_00/bid_sz_00/ask_sz_00). Both sides feed identical fields
# into the SAME derived-metric formula below, so what the backtest validates
# is exactly what live monitoring will see - no proxy, no degradation.
#
# True L2 depth (multi-level book, ask cancel/replenish rates) is NOT
# available from either source for this OTC universe (Tradier never exposes
# it; Databento's EQUS.MINI is top-of-book only) and is intentionally
# excluded rather than faked with a proxy.
# ─────────────────────────────────────────────────────────────────────────────

def fetch_l1_quote(ticker: str, key: str) -> Optional[Dict]:
    """
    Fetch live top-of-book quote from Tradier.
    Returns {bid, ask, bid_size, ask_size, ts} or None on failure.
    """
    try:
        import requests, time as _t
        r = requests.get(
            'https://api.tradier.com/v1/markets/quotes',
            params={'symbols': ticker, 'greeks': 'false'},
            headers={'Authorization': f'Bearer {key}', 'Accept': 'application/json'},
            timeout=8
        )
        r.raise_for_status()
        q = ((r.json().get('quotes') or {}).get('quote')) or {}
        if isinstance(q, list): q = q[0] if q else {}
        bid = float(q.get('bid') or 0)
        ask = float(q.get('ask') or 0)
        if bid <= 0 or ask <= 0:
            return None
        return {
            'bid': bid, 'ask': ask,
            'bid_size': float(q.get('bidsize') or 0),
            'ask_size': float(q.get('asksize') or 0),
            'ts': _t.time(),
        }
    except Exception as e:
        print(f"  [!] L1 quote fetch error: {e}")
        return None


def compute_l1_metrics(quote: Dict, prev_quote: Optional[Dict] = None) -> Dict:
    """
    Derive spread, microprice, and top-of-book imbalance from a quote.
    Same formula used for both live (Tradier) and backtest (Databento bbo-*)
    quotes - both expose bid/ask price+size at the top level, so this is
    true parity, not an approximation on either side.
    """
    bid, ask = quote['bid'], quote['ask']
    bid_sz, ask_sz = quote['bid_size'], quote['ask_size']
    mid = (bid + ask) / 2

    spread     = ask - bid
    spread_bps = (spread / mid * 10000) if mid > 0 else 0

    total_sz = bid_sz + ask_sz
    # Microprice: size-weighted fair value. Heavier ask size pulls microprice
    # toward bid (more sellers waiting) and vice versa.
    microprice = ((bid * ask_sz + ask * bid_sz) / total_sz) if total_sz > 0 else mid

    # Top-of-book depth imbalance: +1 = all bid size, -1 = all ask size
    top_depth_imbalance = ((bid_sz - ask_sz) / total_sz) if total_sz > 0 else 0

    quote_changed = None
    spread_bps_prev = None
    if prev_quote:
        quote_changed = (quote['bid'] != prev_quote.get('bid') or
                         quote['ask'] != prev_quote.get('ask'))
        pmid = (prev_quote['bid'] + prev_quote['ask']) / 2
        spread_bps_prev = ((prev_quote['ask']-prev_quote['bid'])/pmid*10000) if pmid>0 else 0

    spread_widening_pct = None
    if spread_bps_prev is not None and spread_bps_prev > 0:
        spread_widening_pct = (spread_bps - spread_bps_prev) / spread_bps_prev * 100

    return {
        'spread': spread, 'spread_bps': spread_bps,
        'microprice': microprice, 'mid': mid,
        'top_depth_imbalance': top_depth_imbalance,
        'quote_changed': quote_changed,
        'spread_widening_pct': spread_widening_pct,
        'l1_available': True,
    }


def _extract_hhmm(t: str) -> str:
    """
    Normalize a bar's time field to bare 'HH:MM', regardless of whether it's
    already bare (test/synthetic data) or a full ISO timestamp like
    '2026-06-17T11:18:00' or '2026-06-17 11:18:00' (Tradier's real format).
    Returns '00:00' if empty or unparseable.
    """
    if not t:
        return '00:00'
    for sep in ('T', ' '):
        if sep in t:
            t = t.split(sep, 1)[1]
            break
    return t[:5] if len(t) >= 5 else '00:00'


def compute_live_metrics(bars: list, entry_price: float,
                          entry_time: str = None,
                          recent_window: int = 15) -> Dict:
    """
    Compute spike_pct, HWM, drawdown, elapsed from live bars.

    Two HWM references are computed:
      - hwm_pct / hwm_drawdown:        GLOBAL - max high over ALL bars since
                                        entry. Useful as a worst-case reference
                                        for stop placement.
      - recent_hwm_pct / recent_hwm_drawdown: ROLLING - max high over the last
                                        `recent_window` bars only (default 15
                                        = 15 minutes on 1-min bars). Useful for
                                        state detection (EXHAUSTION /
                                        FAILED_BREAKOUT) since it reflects the
                                        CURRENT spike's own peak rather than a
                                        stale spike from much earlier in the
                                        session.

    Why both: a stock that spiked +12% at minute 10, recovered below entry,
    then spiked again to +8% at minute 45 will show global HWM=+12% (now
    44 minutes stale) while recent_hwm correctly reflects the +8% spike
    that is actually happening right now.
    """
    if not bars or entry_price <= 0:
        return {}

    # Find entry bar index. CRITICAL: bar['time'] from Tradier's real API is a
    # full ISO timestamp like "2026-06-17T11:18:00", not bare "HH:MM". Naively
    # comparing that against entry_time ("11:18") via string >= is meaningless -
    # any string starting with a year digit ("2...") is ALWAYS lexicographically
    # greater than "1118", so entry_idx silently resolved to 0 every time,
    # making "post" the ENTIRE day's bars from market open instead of just the
    # bars since actual entry. This corrupted both elapsed_min (became a raw
    # bar count instead of real minutes) and HWM (picked up the whole morning's
    # range instead of the range since entry). _extract_hhmm() normalizes
    # either format before comparing.
    entry_idx = 0
    if entry_time:
        et = entry_time.replace(':','')
        for i, b in enumerate(bars):
            if _extract_hhmm(b.get('time','')).replace(':','') >= et:
                entry_idx = i; break

    post = bars[entry_idx:]
    if not post: return {}

    highs    = [float(b.get('high', b.get('close', entry_price))) for b in post]
    closes   = [float(b.get('close', entry_price)) for b in post]
    current  = closes[-1]

    # Global HWM - all bars since entry
    hwm_abs  = max(highs)
    hwm_pct  = (hwm_abs - entry_price) / entry_price * 100
    spike_pct= (current - entry_price) / entry_price * 100
    # Drawdown from the recorded HWM - always computed against hwm_abs itself,
    # not clamped to 0 when hwm_abs <= entry_price. Clamping there made the
    # displayed numbers inconsistent: e.g. HWM=-85.6%, current=-86.46%, but
    # drawdown shown as 0.0% even though price had moved further past the
    # recorded high. hwm_abs is always > 0 for any real price series, so no
    # division-by-zero risk here.
    hwm_dd   = (current - hwm_abs) / hwm_abs * 100

    # Recent HWM - rolling window (last N bars only)
    recent_highs   = highs[-recent_window:] if len(highs) > recent_window else highs
    recent_hwm_abs = max(recent_highs)
    recent_hwm_pct = (recent_hwm_abs - entry_price) / entry_price * 100
    recent_hwm_dd  = (current - recent_hwm_abs) / recent_hwm_abs * 100

    # Local swing - how big has price moved within the recent window alone,
    # expressed relative to the recent window's OWN low, not entry_price.
    # This matters once entry_price (or, in a long pretrade replay, the
    # session-low reference) has drifted far from the current price level:
    # recent_hwm_pct above would stay permanently huge (since its denominator
    # never updates), making "hwm_pct >= 5%" checks elsewhere trivially true
    # forever and useless as a "is this spike actually significant" gate.
    # local_swing_pct fixes that by being entirely self-contained to the
    # recent window - for a normal session where price hasn't drifted far,
    # this is nearly identical to recent_hwm_pct anyway, so it's a safe
    # drop-in replacement specifically for that gating role.
    recent_lows    = [float(b.get('low', b.get('close', entry_price))) for b in post[-recent_window:]] \
                     if len(post) > recent_window else [float(b.get('low', b.get('close', entry_price))) for b in post]
    recent_low_abs = min(recent_lows) if recent_lows else entry_price
    local_swing_pct = ((recent_hwm_abs - recent_low_abs) / recent_low_abs * 100
                       if recent_low_abs > 0 else recent_hwm_pct)

    # Elapsed time - same format-normalization fix applies here
    elapsed = 0.0
    if entry_time and post:
        try:
            t0 = datetime.strptime(entry_time, '%H:%M')
            t1 = datetime.strptime(_extract_hhmm(post[-1].get('time','00:00')), '%H:%M')
            elapsed = (t1 - t0).total_seconds() / 60
        except: pass

    return {
        'spike_pct': spike_pct,
        'hwm_pct': hwm_pct, 'hwm_drawdown': hwm_dd,
        'recent_hwm_pct': recent_hwm_pct, 'recent_hwm_drawdown': recent_hwm_dd,
        'local_swing_pct': local_swing_pct,
        'elapsed_min': max(elapsed, len(post)),
        'current': current, 'bars_post': post,
    }


def compute_velocity_bucket(elapsed_min: float, spike_pct: float) -> str:
    """
    Classify spike velocity from elapsed time since entry.
    Boundaries are half-open intervals [lo, hi):
      ultra-fast: [0,  5)  min - squeeze/halt/vacuum
      fast:       [5, 15)  min - active buying
      moderate:   [15, 45) min - measured grind
      slow:       [45, inf)  min - exhausted drift
    """
    if spike_pct < 5: return ''
    if elapsed_min <  5:  return 'ultra-fast'
    if elapsed_min < 15:  return 'fast'
    if elapsed_min < 45:  return 'moderate'
    return 'slow'


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ASSESSMENT
# ─────────────────────────────────────────────────────────────────────────────

def _first_met_conditions(bars: List[dict], ref: float) -> Dict[str, dict]:
    """
    Walk forward bar-by-bar from the start of the session (same `bars` list
    assess_pretrade() already has - no extra fetch needed) and record the
    first bar at which each of the 7 named pretrade conditions became true,
    along with the move_pct (off `ref`) at that moment. Single-bar counts,
    no debounce - this answers "when did X first flip true today", not
    "when did X first hold for N consecutive bars" (that's state_run_length,
    computed separately and only for DISTRIBUTION).
    """
    names = ('AT_SESSION_LOW', 'LIQUIDITY_VACUUM', 'DISTRIBUTION', 'FAILED_BREAKOUT',
             'ABSORPTION', 'EXHAUSTION', 'CONTINUATION')
    first_met: Dict[str, dict] = {}
    for i in range(3, len(bars) + 1):
        if len(first_met) == len(names):
            break
        window = bars[:i]
        lm = compute_live_metrics(window, ref, None)
        if not lm:
            continue
        deriv = compute_derivatives(lm.get('bars_post', window), current_price=lm['current'])
        conds = _spike_conditions(lm['spike_pct'],
                                  lm.get('recent_hwm_pct', lm['hwm_pct']),
                                  lm.get('recent_hwm_drawdown', lm['hwm_drawdown']),
                                  deriv['price_vel'], deriv['price_accel'],
                                  deriv['vol_vel'], deriv['vol_accel'],
                                  deriv['price_vel_pct'], deriv['price_accel_pct'],
                                  lm.get('local_swing_pct'))
        if 'DOWNSIDE_PRESSURE' in conds:
            conds = {('AT_SESSION_LOW' if k == 'DOWNSIDE_PRESSURE' else k): v
                    for k, v in conds.items()}
        bar_time = window[-1].get('time', '')
        for name in names:
            if name not in first_met and conds.get(name):
                first_met[name] = {'time': bar_time, 'move_pct': lm['spike_pct']}
    return first_met


def assess_pretrade(ticker: str, bars: List[dict], ref_price: float = None) -> Dict:
    """
    Pre-trade snapshot - Layer 4 (momentum) and Layer 5 (state) only.
    No entry exists yet, so there's nothing to measure spike/HWM against.
    Defaults to today's low so far (bars start at 04:00, so this includes
    premarket) as the reference point - same compute_live_metrics()/
    classify_state() machinery, just pointed at "the move off today's low"
    instead of "the move off my entry".

    Deliberately excludes Layer 1 (tier would be near-meaningless measured
    from the low rather than a real entry), Layer 2/Layer 7 (both built
    from MAE-since-entry, which is undefined before an entry exists - see
    the discriminative-power test run against real data, which didn't show
    a pre-entry variable strong enough yet to justify a substitute table),
    and Layer 1C (kept out for this first version per request - can be
    added the same way Layer 1C is wired into the live monitor, by passing
    a quote through, if wanted later).
    """
    if not bars:
        return {}
    lows = [float(b.get('low', b.get('close', 0))) for b in bars]
    ref = ref_price if (ref_price and ref_price > 0) else min(lows)
    if ref <= 0:
        return {}

    # entry_time=None -> compute_live_metrics uses ALL bars (entry_idx=0),
    # which is exactly what we want: measure from session low, not from
    # any specific clock time.
    lm = compute_live_metrics(bars, ref, None)
    if not lm:
        return {}

    current = lm['current']
    deriv = compute_derivatives(lm.get('bars_post', bars), current_price=current)
    rhwm_pct = lm.get('recent_hwm_pct', lm['hwm_pct'])
    rhwm_dd  = lm.get('recent_hwm_drawdown', lm['hwm_drawdown'])

    # All named conditions, independently evaluated - this is the same
    # single source of truth classify_state() uses, exposed here so the
    # replay/audit feature can track when each one first becomes true
    # without recomputing or duplicating any thresholds.
    conds = _spike_conditions(lm['spike_pct'], rhwm_pct, rhwm_dd,
                              deriv['price_vel'], deriv['price_accel'],
                              deriv['vol_vel'], deriv['vol_accel'],
                              deriv['price_vel_pct'], deriv['price_accel_pct'],
                              lm.get('local_swing_pct'))

    # classify_state()'s DOWNSIDE_PRESSURE is worded for the live monitor
    # ("below entry - thesis on track"). That's meaningless here - there's
    # no entry pretrade, so spike_pct<=0 just means the stock is sitting at
    # (or making) its own session low right now, not "good news for an
    # existing short." Resolve from the conds we already computed above
    # (avoids classify_state() redundantly recomputing _spike_conditions()
    # with identical inputs), then relabel that one key for consistency -
    # the returned 'conditions' dict should match the same pretrade
    # vocabulary as the 'state' field, not silently carry the live-monitor's
    # name for the same condition.
    state = _resolve_state(conds)
    if state == 'DOWNSIDE_PRESSURE':
        state = 'AT_SESSION_LOW'
    if 'DOWNSIDE_PRESSURE' in conds:
        conds = {('AT_SESSION_LOW' if k == 'DOWNSIDE_PRESSURE' else k): v
                for k, v in conds.items()}

    # Count trailing run length for DISTRIBUTION only -- this is the one
    # state where the first-appearance study showed a meaningful
    # blip-vs-confirmed gap warranting a different action recommendation.
    # All other states: raw - blip in outcome, so run length isn't used for
    # any decision and computing it would make replay_pretrade() (which
    # calls assess_pretrade() for every bar) 2-3x slower with no benefit.
    if state == 'DISTRIBUTION':
        state_run = 1  # current bar already counts
        for lookback in range(1, min(5, len(bars))):
            window = bars[:len(bars) - lookback]
            if len(window) < 3:
                break
            sub_lm = compute_live_metrics(window, ref, None)
            if not sub_lm:
                break
            sub_deriv = compute_derivatives(sub_lm.get('bars_post', window),
                                           current_price=sub_lm['current'])
            sub_conds = _spike_conditions(sub_lm['spike_pct'],
                                          sub_lm.get('recent_hwm_pct', sub_lm['hwm_pct']),
                                          sub_lm.get('recent_hwm_drawdown', sub_lm['hwm_drawdown']),
                                          sub_deriv['price_vel'], sub_deriv['price_accel'],
                                          sub_deriv['vol_vel'], sub_deriv['vol_accel'],
                                          sub_deriv['price_vel_pct'], sub_deriv['price_accel_pct'],
                                          sub_lm.get('local_swing_pct'))
            sub_state = _resolve_state(sub_conds)
            if sub_state == 'DOWNSIDE_PRESSURE':
                sub_state = 'AT_SESSION_LOW'
            if sub_state == state:
                state_run += 1
            else:
                break
    else:
        state_run = 1  # current bar counts even without the full trailing check

    # When each named condition first flipped true today - a full bar-by-bar
    # walk over the same `bars` list, so it's only ever computed once per
    # pretrade request (not on every live-monitor poll).
    first_met = _first_met_conditions(bars, ref)

    return {
        'ticker': ticker, 'ref_price': ref, 'current': current,
        'move_pct': lm['spike_pct'], 'bars_since_low': len(lm.get('bars_post', bars)),
        'hwm_pct': lm['hwm_pct'], 'hwm_drawdown': lm['hwm_drawdown'],
        'price_velocity': deriv['price_vel'], 'price_accel': deriv['price_accel'],
        'volume_velocity': deriv['vol_vel'], 'volume_accel': deriv['vol_accel'],
        'state': state, 'conditions': conds, 'state_run_length': state_run,
        'first_met': first_met,
    }


def print_pretrade(p: Dict):
    """Display for the pre-trade snapshot - intentionally much shorter than
    print_live(), since it's only ever Layer 4/5."""
    if not p:
        print(f"  [!] No bars available yet for this ticker.")
        return
    mv = p['move_pct']
    mv_col = RED if mv > 10 else YEL if mv > 5 else GRN2
    print(f"\n{'='*68}")
    print(f"{BOLD}  {p['ticker']}  Session low: ${p['ref_price']:.3f}  "
          f"Current: ${p['current']:.3f}  {mv_col}{mv:+.2f}% off low{RST}")
    print(f"  {DIM}(measured from today's low so far, including premarket - "
          f"there's no position yet, so this isn't HWM/drawdown in the "
          f"live-monitor sense){RST}")
    print('=' * 68)

    pv_col = GRN if p['price_velocity'] < 0 else RED
    pa_col = GRN if p['price_accel'] < 0 else RED
    vv = p['volume_velocity']
    vv_col = GRN if vv < 1.0 else RED if vv > 2 else DIM
    print(f"\n  {BOLD}Momentum{RST}")
    print(f"  Price velocity: {pv_col}{p['price_velocity']:+.4f}$/min{RST}  "
          f"Accel: {pa_col}{p['price_accel']:+.4f}{RST}  "
          f"({'decelerating' if p['price_accel'] < 0 else 'accelerating'})")
    print(f"  Volume ratio:   {vv_col}{vv:.2f}x avg{RST}  "
          f"Accel: {p['volume_accel']:+.3f}  "
          f"({'fading' if p['volume_accel'] < 0 else 'building'})")

    if p['state'] == 'AT_SESSION_LOW':
        state_col, state_desc = DIM, "Sitting at (or making) today's low - no real move yet to assess"
        state_qualifier = ''
    else:
        state_col = {'CONTINUATION':RED2,'EXHAUSTION':GRN,'ABSORPTION':GRN,
                    'FAILED_BREAKOUT':GRN2,'DISTRIBUTION':GRN,
                    'LIQUIDITY_VACUUM':YEL,'SPIKE_INITIATION':YEL}.get(p['state'], DIM)
        state_desc = SPIKE_STATES.get(p['state'], '')
        run = p.get('state_run_length', 1)
        # Per first-appearance study (197 sessions):
        # DISTRIBUTION: confirmed (>=3 bars) is qualitatively different from blip -
        #   0% no-decline by session end vs 9% for blip, path_eff 0.68 vs 0.455.
        #   Wait for confirmation before acting.
        # FAILED_BREAKOUT: confirmed modestly better than raw; raw is already workable.
        # EXHAUSTION/ABSORPTION: raw=blip in outcome, confirmed structurally rare.
        #   Act on first appearance.
        # CONTINUATION: confirmed's no-decline rate is largely a definitional artifact.
        if p['state'] == 'DISTRIBUTION':
            if run >= 3:
                state_qualifier = f"  {GRN}(confirmed - {run} bars  - act on this){RST}"
            else:
                state_qualifier = (f"  {YEL}(forming - {run}/3 bars  "
                                  f"study says wait for bar 3 before acting){RST}")
        elif p['state'] in ('EXHAUSTION', 'ABSORPTION'):
            state_qualifier = (f"  {DIM}(run: {run} bar{'s' if run>1 else ''}  "
                              f"study: act on first appearance - confirmed is structurally rare){RST}")
        elif p['state'] == 'FAILED_BREAKOUT':
            if run >= 3:
                state_qualifier = f"  {GRN}(confirmed - {run} bars  slight edge over raw){RST}"
            else:
                state_qualifier = (f"  {DIM}(run: {run} bar{'s' if run>1 else ''}  "
                                  f"study: raw is already workable here){RST}")
        else:
            state_qualifier = f"  {DIM}(run: {run} bar{'s' if run>1 else ''}){RST}"

    print(f"\n  {BOLD}State{RST}")
    print(f"  {state_col}{BOLD}{p['state']}{RST}{state_qualifier}  {DIM}{state_desc}{RST}")

    print(f"\n  {BOLD}All conditions, right now{RST}")
    cond_col = {'CONTINUATION':RED2,'EXHAUSTION':GRN,'ABSORPTION':GRN,
               'FAILED_BREAKOUT':GRN2,'DISTRIBUTION':GRN,
               'LIQUIDITY_VACUUM':YEL,'AT_SESSION_LOW':DIM}
    for name in ('AT_SESSION_LOW','LIQUIDITY_VACUUM','DISTRIBUTION','FAILED_BREAKOUT',
                'ABSORPTION','EXHAUSTION','CONTINUATION'):
        met = p['conditions'].get(name, False)
        if met:
            tag = f"{BOLD} <- this is the displayed State{RST}" if name == p['state'] \
                 else f"  {DIM}(also true - lower priority than {p['state']}){RST}"
            print(f"    {cond_col.get(name,DIM)}{name:<18}{RST} true{tag}")
        else:
            print(f"    {DIM}{name:<18} not true right now{RST}")
    if p['state'] == 'SPIKE_INITIATION':
        print(f"  {DIM}None of the above are true right now - that's exactly why "
              f"SPIKE_INITIATION is showing as the State above.{RST}")

    first_met = p.get('first_met', {})
    print(f"\n  {BOLD}First time each condition was satisfied today{RST}")
    print(f"  {DIM}(single-bar counts, no debounce){RST}\n")
    all_names = ('AT_SESSION_LOW','LIQUIDITY_VACUUM','DISTRIBUTION',
                 'FAILED_BREAKOUT','ABSORPTION','EXHAUSTION','CONTINUATION')
    for name in all_names:
        fm = first_met.get(name)
        col = cond_col.get(name, DIM)
        if fm:
            print(f"  {col}{name:<18}{RST} first true at {_extract_hhmm(fm['time'])}  "
                 f"{DIM}(move was {fm['move_pct']:+.2f}%){RST}")
        else:
            print(f"  {DIM}{name:<18} never satisfied this session{RST}")
    print()


def assess(ticker: str, entry_price: float,
           bars: List[dict], entry_time: str,
           profiles: Dict, rows: List[dict],
           atr_override: float = 0.0,
           tick_features: Dict = None,
           quote: Dict = None,
           prev_quote: Dict = None) -> LiveSpikeResult:
    """Run all 8 layers and return complete LiveSpikeResult."""
    lm = compute_live_metrics(bars, entry_price, entry_time)
    if not lm:
        return LiveSpikeResult(ticker=ticker, entry_price=entry_price,
                               current_price=entry_price, spike_pct=0,
                               elapsed_min=0, hwm_pct=0, hwm_drawdown=0,
                               fixed_tier='NOISE', atr_tier='NOISE',
                               atr_pct=0, tiers_agree=True)

    spike     = lm['spike_pct']
    hwm       = lm['hwm_pct']
    hwm_dd    = lm['hwm_drawdown']
    rhwm      = lm.get('recent_hwm_pct', hwm)
    rhwm_dd   = lm.get('recent_hwm_drawdown', hwm_dd)
    elapsed   = lm['elapsed_min']
    current   = lm['current']

    # ATR as % of entry (use override or estimate from bars)
    if atr_override > 0:
        atr_pct = atr_override / entry_price * 100
    else:
        post = lm.get('bars_post', [])
        if len(post) >= 5:
            ranges = [abs(float(b.get('high',0)) - float(b.get('low',0))) for b in post[-14:]]
            atr_pct = (statistics.mean(ranges) / entry_price * 100) if ranges else 0
        else:
            atr_pct = 0

    # Layer 1 - Dual threshold
    fixed_t,  _ = _tier_fixed(abs(spike)) if spike > 0 else ('BELOW', '')
    atr_t,    _ = _tier_atr(abs(spike), atr_pct) if spike > 0 else ('BELOW', '')
    agree       = fixed_t == atr_t

    # Layer 2 - Terminal class
    tc = profiles['tc'].get(fixed_t)

    # Layer 3 - Velocity
    vel_p  = profiles['vel'].get(fixed_t)
    vel_bk = compute_velocity_bucket(elapsed, abs(spike))

    # Layer 4 - Derivatives
    post_bars = lm.get('bars_post', [])
    deriv = compute_derivatives(post_bars, current_price=current)

    # Layer 5 - State
    # If tick features available, refine vol_vel with signed delta
    vol_vel = deriv['vol_vel']
    if tick_features:
        abr = tick_features.get('aggressor_buy_ratio', 50)
        # High buy aggression during spike = CONTINUATION
        if abr > 60 and spike > 0: vol_vel = max(vol_vel, 1.5)

    # Use RECENT HWM (not global) for state detection - reflects the
    # current spike's own peak/pullback rather than a stale earlier spike.
    state = classify_state(spike, rhwm, rhwm_dd,
                           deriv['price_vel'], deriv['price_accel'],
                           vol_vel, deriv['vol_accel'], elapsed,
                           price_vel_pct=deriv['price_vel_pct'],
                           price_accel_pct=deriv['price_accel_pct'],
                           local_swing_pct=lm.get('local_swing_pct'))

    # Layer 5 - State run length (DISTRIBUTION only) - same trailing-bar
    # lookback technique as assess_pretrade(), mirrored here so DIST_CONFIRM
    # (>=3 bars, in _determine_action) can actually be reached in live mode
    # instead of being capped at 1 forever.
    if state == 'DISTRIBUTION':
        state_run = 1  # current bar already counts
        for lookback in range(1, min(5, len(bars))):
            window = bars[:len(bars) - lookback]
            if len(window) < 3:
                break
            sub_lm = compute_live_metrics(window, entry_price, entry_time)
            if not sub_lm:
                break
            sub_deriv = compute_derivatives(sub_lm.get('bars_post', window),
                                           current_price=sub_lm['current'])
            sub_state = classify_state(sub_lm['spike_pct'],
                                       sub_lm.get('recent_hwm_pct', sub_lm['hwm_pct']),
                                       sub_lm.get('recent_hwm_drawdown', sub_lm['hwm_drawdown']),
                                       sub_deriv['price_vel'], sub_deriv['price_accel'],
                                       sub_deriv['vol_vel'], sub_deriv['vol_accel'],
                                       sub_lm['elapsed_min'],
                                       price_vel_pct=sub_deriv['price_vel_pct'],
                                       price_accel_pct=sub_deriv['price_accel_pct'],
                                       local_swing_pct=sub_lm.get('local_swing_pct'))
            if sub_state == state:
                state_run += 1
            else:
                break
    else:
        state_run = 0

    # Layer 7 - Forward metrics
    fwd = profiles['fwd'].get(fixed_t)

    # Comparables
    comps = build_comparables(rows, abs(spike)) if spike > 0 else []

    # Layer 1C - L1 microstructure (only if a quote was successfully fetched)
    l1 = compute_l1_metrics(quote, prev_quote) if quote else {}

    return LiveSpikeResult(
        ticker=ticker, entry_price=entry_price, current_price=current,
        spike_pct=spike, elapsed_min=elapsed, hwm_pct=hwm,
        hwm_drawdown=hwm_dd, recent_hwm_pct=rhwm, recent_hwm_drawdown=rhwm_dd,
        fixed_tier=fixed_t, atr_tier=atr_t,
        atr_pct=atr_pct, tiers_agree=agree, term_class=tc,
        vel_profile=vel_p, velocity_bucket=vel_bk,
        price_velocity=deriv['price_vel'], price_accel=deriv['price_accel'],
        volume_velocity=deriv['vol_vel'], volume_accel=deriv['vol_accel'],
        state=state, state_run_length=state_run, forward=fwd, comparables=comps,
        l1_available=l1.get('l1_available', False),
        spread_bps=l1.get('spread_bps', 0.0),
        microprice=l1.get('microprice', 0.0),
        top_depth_imbalance=l1.get('top_depth_imbalance', 0.0),
        spread_widening_pct=l1.get('spread_widening_pct'),
        quote_changed=l1.get('quote_changed'),
    )


# ─────────────────────────────────────────────────────────────────────────────
# DISPLAY
# ─────────────────────────────────────────────────────────────────────────────

def _bar(v, total=100, width=20, col=GRN):
    filled = int(v / total * width) if total > 0 else 0
    return f"{col}{'#'*filled}{DIM}{'-'*(width-filled)}{RST}"

def _rc(v):  # recovery color
    return GRN2 if v >= 65 else (GRN if v >= 50 else (YEL if v >= 35 else RED))

def _sc(v):  # return color
    return GRN if v < 0 else RED

def print_header():
    print(f"\n{BOLD}{WHT}{'='*68}{RST}")
    print(f"{BOLD}{CYN}  STATUS.INQUISIT v2  -  Spike Classifier{RST}")
    print(f"{DIM}  8-layer spike analysis for Cat5ive open short positions{RST}")
    print(f"{BOLD}{WHT}{'='*68}{RST}\n")

def print_analysis(profiles: Dict, rows: List[dict]):
    """Print full backtest spike profile analysis."""
    tc_map  = profiles['tc']
    vel_map = profiles['vel']
    fwd_map = profiles['fwd']

    print(f"{BOLD}{CYN}LAYER 1-3 - SPIKE TIER PROFILES  ({len(rows)} sessions){RST}\n")
    hdr = (f"{'Tier':<10} {'n':>4}  {'Recov%':>7}  "
           f"{'A%':>5} {'B%':>5} {'C%':>5} {'D%':>5}  "
           f"{'>Next':>6}  {'>Stop':>6}  {'PeakMin':>7}")
    print(hdr)
    print('-' * 72)

    for lo, hi, tier, label in FIXED_TIERS:
        tc  = tc_map.get(tier)
        fwd = fwd_map.get(tier)
        if not tc or tc.n_total == 0: continue
        rr  = tc.recovery_rate()
        col = _rc(rr)
        next_disp = f"{fwd.prob_reach_next_tier:>5.0f}%" if hi < 999 else f"{'-':>6}"
        print(f"{col}{tier:<10}{RST} {tc.n_total:>4}  "
              f"{col}{rr:>6.0f}%{RST}  "
              f"{RED}{tc.prob('A'):>4.0f}%{RST} "
              f"{GRN}{tc.prob('B'):>4.0f}%{RST} "
              f"{GRN2}{tc.prob('C'):>4.0f}%{RST} "
              f"{DIM}{tc.prob('D'):>4.0f}%{RST}  "
              f"{DIM}{next_disp}{RST}  "
              f"{RED}{fwd.prob_stop_hit:>5.0f}%{RST}  "
              f"{DIM}{fwd.median_time_to_peak_min:>6.0f}m{RST}")

    print(f"\n{DIM}Recov% = % that still closed below entry (short worked)")
    print(f"A=reversal . B=temporary . C=clean . D=chop")
    print(f">Next = % that crossed to next tier . >Stop = % that hit 20%+ MAE{RST}\n")

    if not rows:
        print(f"{YEL}  [!] No dual_master_*.csv backtest data found - tier tables above are "
              f"empty (n=0). Layers 2/3/7 (historical recovery rates) require that dataset; "
              f"Layers 1/4/5/6 (live state engine) do not and work normally without it.{RST}\n")
        return

    print(f"{BOLD}{CYN}LAYER 1B - FIXED 5% vs ATR-RELATIVE TIER COMPARISON{RST}")
    d_total = profiles.get('dual_total', 0)
    d_agree = profiles.get('dual_agree', 0)
    if d_total > 0:
        pct = d_agree / d_total * 100
        print(f"  Agreement rate: {d_agree}/{d_total} sessions ({pct:.0f}%)")
    else:
        print(f"  {DIM}No sessions with valid ATR + MAE>=5% to compare{RST}")
    print()


def _determine_action(r: 'LiveSpikeResult', sp: float):
    """
    Single source of truth for the action recommendation - (verb, color,
    detail). Used both by the quick-read summary line near the top of the
    output and the full ACTION section at the bottom, so there's exactly
    one place this logic lives rather than two copies that could drift.
    """
    DIST_CONFIRM = 3
    if sp < 5:
        return ('HOLD', GRN, f"{sp:.1f}% is NOISE. No action.")
    elif r.state == 'DISTRIBUTION':
        if r.state_run_length >= DIST_CONFIRM:
            rr = r.term_class.recovery_rate() if r.term_class else 0
            return ('HOLD/MONITOR', GRN,
                    f"DISTRIBUTION confirmed ({r.state_run_length} bars). "
                    f"Historical recovery at this tier: {rr:.0f}%. "
                    f"Volume-confirmed top - cleanest downside signal.")
        else:
            return ('HOLD - WAIT', YEL,
                    f"DISTRIBUTION forming ({r.state_run_length}/3 bars). "
                    f"Do not act yet - wait for bar {DIST_CONFIRM}.")
    elif r.state in ('FAILED_BREAKOUT', 'EXHAUSTION', 'ABSORPTION'):
        rr = r.term_class.recovery_rate() if r.term_class else 0
        return ('HOLD/MONITOR', GRN, f"State={r.state}. Historical recovery at this tier: {rr:.0f}%.")
    elif r.state == 'CONTINUATION' and sp >= 10:
        return ('COVER PARTIAL', RED2, "spike continuing into MODERATE+ with volume.")
    elif sp >= 15:
        pa = r.term_class.prob('A') if r.term_class else 0
        return ('EXIT', RED2, f"{sp:.1f}% spike. {pa:.0f}% historical reversal rate.")
    elif sp >= 10:
        return ('CAUTION', YEL, f"{sp:.1f}% spike. Cover 25-33% optional. Watch HWM drawdown.")
    else:
        return ('MONITOR', YEL, f"{sp:.1f}% MINOR spike. Watch for EXHAUSTION state.")


def print_live(r: LiveSpikeResult):
    """Print real-time spike classification."""
    sp    = r.spike_pct
    adv   = sp > 0
    col_sp= (RED if sp > 10 else YEL if sp > 5 else GRN if sp <= 0 else YEL)

    print(f"\n{'='*68}")
    print(f"{BOLD}  {r.ticker}  Entry: ${r.entry_price:.3f}  "
          f"Current: ${r.current_price:.3f}  "
          f"{'^' if sp>0 else 'v'} {col_sp}{sp:+.2f}%{RST}")
    if r.hwm_pct > 0:
        print(f"  HWM (global):  {r.hwm_pct:+.1f}%  ->  Drawdown: {r.hwm_drawdown:+.1f}%")
        print(f"  HWM (recent):  {r.recent_hwm_pct:+.1f}%  ->  Drawdown: {r.recent_hwm_drawdown:+.1f}%")
    else:
        print(f"  {DIM}No adverse excursion - price has not traded above entry since entry "
              f"(best print so far: {r.hwm_pct:+.1f}%){RST}")
    print(f"  Elapsed: {r.elapsed_min:.0f}m")
    print('=' * 68)

    if not adv:
        z = abs(sp)
        zone = ('PROVEN' if z>=25 else 'CONFIRMED' if z>=15 else
                'BUILDING' if z>=10 else 'WORKING' if z>=5 else 'AT ENTRY')
        print(f"\n  {GRN2}{BOLD}v {zone}: {z:.1f}% below entry - thesis developing{RST}")
        s = r.state
        print(f"  State: {GRN}{s}{RST}  {DIM}- {SPIKE_STATES.get(s,'')}{RST}")
        print()
        return

    verb, vcol, detail = _determine_action(r, sp)
    state_col_qr = {'CONTINUATION':RED2,'EXHAUSTION':GRN,'ABSORPTION':GRN,
                    'FAILED_BREAKOUT':GRN2,'DISTRIBUTION':GRN,
                    'LIQUIDITY_VACUUM':YEL,'SPIKE_INITIATION':YEL,
                    'DOWNSIDE_PRESSURE':GRN2}.get(r.state, DIM)
    tier_note = '' if (r.atr_pct <= 0 or r.tiers_agree) else f" {DIM}(ATR: {r.atr_tier}){RST}"
    print(f"\n  {BOLD}> {col_sp}{r.fixed_tier}{RST}{tier_note}  ->  "
          f"{state_col_qr}{r.state}{RST}  ->  {vcol}{BOLD}{verb}{RST}")
    print('=' * 68)

    agree_str = (f"{GRN}[AGREE]{RST}" if r.tiers_agree
                 else f"{YEL}[DIFFER]{RST}")
    print(f"\n  {BOLD}Layer 1 - Thresholds{RST}")
    print(f"  Fixed 5%:  {col_sp}{r.fixed_tier:<10}{RST}  {sp:+.1f}% above entry")
    if r.atr_pct > 0:
        print(f"  ATR-based: {col_sp}{r.atr_tier:<10}{RST}  "
              f"{sp/r.atr_pct:.1f}x ATR  {agree_str}")
    else:
        print(f"  ATR-based: {DIM}pending - need 5+ bars since entry{RST}")

    state_col = {'CONTINUATION':RED2,'EXHAUSTION':GRN,'ABSORPTION':GRN,
                 'FAILED_BREAKOUT':GRN2,'DISTRIBUTION':GRN,
                 'LIQUIDITY_VACUUM':YEL,'SPIKE_INITIATION':YEL,
                 'DOWNSIDE_PRESSURE':GRN2}.get(r.state, DIM)
    print(f"\n  {BOLD}Layer 5 - State{RST}")
    if r.state == 'DISTRIBUTION' and r.state_run_length >= 3:
        state_label = f"DISTRIBUTION  {GRN}(confirmed - {r.state_run_length} bars){RST}"
    elif r.state == 'DISTRIBUTION':
        state_label = f"DISTRIBUTION  {YEL}(forming){RST}"
    else:
        state_label = f"{r.state}"
    print(f"  {state_col}{BOLD}{state_label}{RST}  {DIM}{SPIKE_STATES.get(r.state,'')}{RST}")

    pv_col = GRN if r.price_velocity < 0 else RED
    pa_col = GRN if r.price_accel < 0 else RED
    vv_col = GRN if r.volume_velocity < 1.0 else RED if r.volume_velocity > 2 else DIM
    print(f"\n  {BOLD}Layer 4 - Momentum{RST}")
    print(f"  Price velocity: {pv_col}{r.price_velocity:+.4f}$/min{RST}  "
          f"Accel: {pa_col}{r.price_accel:+.4f}{RST}")
    print(f"  Volume ratio:   {vv_col}{r.volume_velocity:.2f}x avg{RST}  "
          f"Accel: {r.volume_accel:+.3f}")
    if r.velocity_bucket:
        vc = GRN if r.velocity_bucket=='slow' else (YEL if r.velocity_bucket=='moderate' else RED)
        print(f"  Spike velocity: {vc}{r.velocity_bucket.upper()}{RST}")

    if r.term_class and r.term_class.n_total > 0:
        tc = r.term_class
        print(f"\n  {BOLD}Layer 2 - Terminal Class Distribution  (n={tc.n_total}){RST}")
        for cls, col, label in [
            ('A', RED,  'REVERSAL'), ('B', GRN, 'TEMPORARY'),
            ('C', GRN2, 'CLEAN'),    ('D', DIM, 'CHOP'),
        ]:
            p = tc.prob(cls)
            print(f"  Class {cls}: {col}{p:>5.1f}%{RST} {_bar(p,100,16,col)}  {DIM}{label}{RST}")

    if r.forward:
        f = r.forward
        if f.median_time_to_peak_min > 0 or f.prob_reach_next_tier > 0:
            print(f"\n  {BOLD}Layer 7 - Forward Probabilities{RST}")
            print(f"  Reach next tier: {f.prob_reach_next_tier:.0f}%  "
                  f"Recover below entry: {f.prob_reverse_below_entry:.0f}%  "
                  f"Hit 20% stop: {f.prob_stop_hit:.0f}%")

    if r.l1_available:
        print(f"\n  {BOLD}Layer 1C - L1 Microstructure{RST}")
        sb_col = RED if r.spread_bps > 200 else (YEL if r.spread_bps > 80 else GRN)
        print(f"  Spread: {sb_col}{r.spread_bps:.0f}bps{RST}  "
              f"Microprice: ${r.microprice:.4f}  "
              f"Top-depth imbalance: {r.top_depth_imbalance:+.2f}")

    print(f"\n  {BOLD}-- ACTION --{RST}")
    print(f"  {vcol}{BOLD}{verb} - {detail}{RST}")
    print()


# ─────────────────────────────────────────────────────────────────────────────
# DATA LOADING
# ─────────────────────────────────────────────────────────────────────────────

def load_rows(results_dir: str) -> List[dict]:
    """
    Load dual_master_*.csv backtest rows if present.

    Non-fatal by design: this app does not yet have a dual_backtest.py
    pipeline that produces dual_master_*.csv, so returning [] here (instead
    of the original script's sys.exit(1)) lets the state-engine layers
    (1/4/5/6, optionally 1C) run normally with empty term_class/forward
    profiles. build_profiles([]) already produces valid-but-zeroed
    TerminalClass/VelocityProfile/ForwardMetrics objects, and every display
    path already guards with `if r.term_class else 0`-style fallbacks.
    """
    if not os.path.isdir(results_dir):
        print(f"  [!] No backtest results dir at {results_dir} - "
              f"state-engine layers (1/4/5/6) will still work; "
              f"historical recovery-rate layers (2/3/7) will read as empty.")
        return []
    files = sorted(
        [f for f in os.listdir(results_dir)
         if f.startswith('dual_master_') and f.endswith('.csv')],
        reverse=True
    )
    if not files:
        print(f"  [!] No dual_master_*.csv in {results_dir} - "
              f"state-engine layers (1/4/5/6) will still work; "
              f"historical recovery-rate layers (2/3/7) will read as empty.")
        return []
    with open(os.path.join(results_dir, files[0]),
              encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    sys.stdout.reconfigure(line_buffering=True)

    parser = argparse.ArgumentParser(description='Status.Inquisit v2')
    parser.add_argument('--ticker',      help='Ticker (live mode)')
    parser.add_argument('--entry',       type=float, help='Entry price')
    parser.add_argument('--entry-time',  help='Entry time HH:MM')
    parser.add_argument('--date',        help='Historical date YYYY-MM-DD')
    parser.add_argument('--time',        help='Snapshot time HH:MM')
    parser.add_argument('--analyze',     action='store_true')
    parser.add_argument('--report',      action='store_true')
    parser.add_argument('--once',        action='store_true')
    parser.add_argument('--interval',    type=int, default=30)
    parser.add_argument('--config',      help='Path to config.json')
    parser.add_argument('--results-dir', default=RESULTS_DIR)
    parser.add_argument('--db-key',      help='Databento API key (Layer 8)')
    parser.add_argument('--pretrade',    action='store_true',
                        help='Pre-trade snapshot (Layer 4/5 only) - no --entry needed')
    parser.add_argument('--ref-price',   type=float,
                        help='Override reference price for --pretrade')
    parser.add_argument('--json',        action='store_true',
                        help='Emit a single JSON object instead of colored CLI text '
                             '(combine with --once for a single snapshot)')
    args = parser.parse_args()

    tradier_key = ''
    db_key = args.db_key or os.environ.get('DATABENTO_KEY','')
    if args.config and os.path.exists(args.config):
        with open(args.config) as f:
            cfg = json.load(f)
        tradier_key = cfg.get('tradier_key','')
        db_key = db_key or cfg.get('databento_key','')
    tradier_key = tradier_key or os.environ.get('TRADIER_API_KEY','')

    if not args.json:
        print_header()

    rows = load_rows(args.results_dir)
    valid = [r for r in rows
             if _flt(r.get('a_entry_price')) and _flt(r.get('a_mae_pct')) is not None
             and _flt(r.get('a_ret_rth_close')) is not None]
    if not args.json:
        print(f"  Loaded {len(valid)}/{len(rows)} sessions with valid A entry + MAE data")
    profiles = build_profiles(valid)

    if args.pretrade and not args.ticker:
        print("ERROR: --ticker required for --pretrade"); sys.exit(1)

    if (args.analyze or not args.ticker) and not args.json:
        print_analysis(profiles, valid)
        if args.report:
            out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'status_inquisit_report.html')
            print(f"  {GRN}Report generation skipped in this build "
                  f"(--report HTML export not ported - state engine only){RST}")
        if not args.ticker: return

    if not args.ticker:
        return

    if not args.entry and not args.pretrade:
        print("ERROR: --entry required for live mode (or use --pretrade)"); sys.exit(1)
    if not tradier_key:
        print("ERROR: TRADIER_API_KEY not set"); sys.exit(1)

    poll = 0
    prev_quote = None
    result = None
    if not args.json:
        print(f"\n  {DIM}Polling every {args.interval}s - press Ctrl+C to stop.{RST}")
    try:
        while True:
            poll += 1
            if not args.json:
                ts = datetime.now().strftime('%H:%M:%S')
                print(f"\n[poll {poll}] {ts} ET")
            bars = fetch_bars(args.ticker, tradier_key, args.date, args.time)

            if args.pretrade:
                if bars:
                    p = assess_pretrade(args.ticker, bars, ref_price=args.ref_price)
                    if args.json:
                        print(json.dumps(p))
                    else:
                        print_pretrade(p)
                    if p: result = p
                else:
                    if args.json:
                        print(json.dumps({}))
                    else:
                        print(f"  [!] No bars for {args.ticker}")
                if args.once or args.date:
                    break
                time.sleep(args.interval)
                continue

            tick = (fetch_tick_features(args.ticker, db_key, args.date or date.today().isoformat())
                    if db_key else None)
            quote = fetch_l1_quote(args.ticker, tradier_key) if not args.date else None
            if bars:
                result = assess(args.ticker, args.entry, bars,
                                args.entry_time or '', profiles, valid,
                                tick_features=tick, quote=quote, prev_quote=prev_quote)
                if args.json:
                    verb, _, detail = _determine_action(result, result.spike_pct)
                    payload = asdict(result)
                    payload['action_verb'] = verb
                    payload['action_detail'] = detail
                    print(json.dumps(payload))
                else:
                    print_live(result)
            else:
                if args.json:
                    print(json.dumps({}))
                else:
                    print(f"  [!] No bars for {args.ticker}")
            if quote: prev_quote = quote
            if args.once or args.date:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        if not args.json:
            if result is not None:
                cur  = result['current'] if isinstance(result, dict) else result.current_price
                move = result['move_pct'] if isinstance(result, dict) else result.spike_pct
                print(f"\n\n  {YEL}Stopped monitoring {args.ticker}.{RST}  "
                      f"Last seen: ${cur:.3f} ({move:+.2f}%) after {poll} poll(s).")
            else:
                print(f"\n\n  {YEL}Stopped monitoring {args.ticker} (no successful poll).{RST}")
        sys.exit(0)


if __name__ == '__main__':
    main()
