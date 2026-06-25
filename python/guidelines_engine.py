"""
guidelines_engine.py  (v1.1 — exact ClassifierSignal field names confirmed)
----------------------------------------------------------------------------
Cat5ive Guidelines Translation Layer.

Reads a ClassifierSignal from cat5ive_classifier_v3.py and applies all
rules from cat5ive_trading_guidelines.md.

Confirmed field mapping (from ClassifierSignal dataclass L1182-1270):
    sig.hod_set_pct         — HOD timing (% session elapsed when HOD set)
    sig.quiet_dump_proxy    — Quiet Dump flag (bool)
    sig.chop                — NM chop score (0-100)
    sig.flips_rth           — S1/S2 flips before entry
    sig.velocity            — score velocity string
    sig.regime              — NM regime string
    sig.bias                — S1/S2/NO_CONVICTION dominant side
    sig.confidence_norm     — 0.0-1.0 normalised confidence (S1 proxy)
    sig.contested_day       — bool
    sig.float_shares        — float size
    sig.gap_pct             — gap %
    sig.score_trajectory    — RISING/FLAT/FALLING
    sig.s1_pct              — % RTH session in S1
    sig.section             — current section S1/S2
    sig.near_miss_count     — NM count
    sig.run_day             — day of the run (1/2/3+)
    sig.halt_count_pm       — NOT on signal; passed separately if available

Usage
-----
    from guidelines_engine import evaluate_signal
    verdict = evaluate_signal(sig)
    print(verdict.summary())

Standalone test:
    python guidelines_engine.py --hod 22 --qd 1 --chop 15 --flips 1
    python guidelines_engine.py --hod 75 --qd 0 --chop 35 --flips 8
"""

from __future__ import annotations
import json, sys, argparse
from dataclasses import dataclass, field
from typing import Optional


# ── Rule thresholds (from guidelines §1-§3) ──────────────────────────────────
HOD_EARLY_PCT   = 30.0   # < 30  = early HOD — primary edge
HOD_LATE_PCT    = 60.0   # ≥ 60  = late HOD  — AVOID 1 / hard block
CHOP_DANGER_LO  = 20.0   # 20-40 = danger zone — AVOID 2 / hard block
CHOP_DANGER_HI  = 40.0
S1_PROXY_LOW    = 0.40   # < 0.40 = low S1 conviction — AVOID 4
FLIPS_HIGH      = 6      # ≥ 6 = high flip count (used in two-factor block)
LARGE_FLOAT     = 10_000_000   # ≥ 10M = edge weakens to 66.7%


# ── Entry Quality Score weights ───────────────────────────────────────────────
# Max raw = 90 (margin_var omitted — not on live signal)
EQ_MAX_RAW = 90


@dataclass
class GuidelinesVerdict:
    primary_edge_active: bool  = False
    hod_pct:             float = 0.0
    quiet_dump:          bool  = False

    eq_score:      int  = 0
    eq_tier:       str  = "UNKNOWN"
    eq_components: dict = field(default_factory=dict)

    avoid_violations: list = field(default_factory=list)
    hard_block:       bool = False

    hold_through_mae: bool = False
    mae_guidance:     str  = ""

    confirmations: list = field(default_factory=list)
    size_warnings: list = field(default_factory=list)

    verdict:       str   = "UNKNOWN"
    size_modifier: float = 0.0
    reasons:       list  = field(default_factory=list)

    def summary(self, use_color: bool = True) -> str:
        GRN  = "\033[92m" if use_color else ""
        RED  = "\033[91m" if use_color else ""
        YEL  = "\033[93m" if use_color else ""
        CYN  = "\033[96m" if use_color else ""
        BOLD = "\033[1m"  if use_color else ""
        DIM  = "\033[2m"  if use_color else ""
        RST  = "\033[0m"  if use_color else ""

        VCOL = {"GO": GRN+BOLD, "CAUTION": YEL+BOLD,
                "NO-GO": RED, "BLOCK": RED+BOLD}.get(self.verdict, DIM)
        TCOL = {"PRIME": GRN+BOLD, "GOOD": GRN, "MIXED": YEL,
                "POOR": RED, "SKIP": RED+BOLD}.get(self.eq_tier, DIM)
        W = 62

        lines = [
            f"",
            f"  {BOLD}{'─'*W}{RST}",
            f"  {BOLD}GUIDELINES ENGINE v1.1{RST}",
            f"  {'─'*W}",
            f"  HOD set at  : {CYN}{self.hod_pct:.1f}%{RST} of session"
            f"  ({'EARLY ✓' if self.hod_pct < HOD_EARLY_PCT else 'LATE ✗' if self.hod_pct >= HOD_LATE_PCT else 'MID ~'})",
            f"  Quiet Dump  : {'YES ✓' if self.quiet_dump else 'NO  ✗'}",
            f"  Primary edge: {(GRN+'ACTIVE ✓') if self.primary_edge_active else (RED+'NOT ACTIVE')}{RST}",
            f"  EQ Score    : {TCOL}{self.eq_score}/100  [{self.eq_tier}]{RST}",
        ]
        if self.confirmations:
            lines.append(f"  {GRN}Confirms: {' | '.join(self.confirmations[:3])}{RST}")
        if self.size_warnings:
            for w in self.size_warnings:
                lines.append(f"  {YEL}⚠ {w}{RST}")
        if self.avoid_violations:
            lines.append(f"  {RED}AVOID signals:{RST}")
            for av in self.avoid_violations:
                lines.append(f"    {RED}✗ {av}{RST}")
        lines += [
            f"  MAE rule    : {DIM}{self.mae_guidance[:72]}{RST}",
            f"  Size        : {self.size_modifier:.0%}",
            f"",
            f"  {VCOL}{'─'*18}  VERDICT: {self.verdict}  {'─'*18}{RST}",
        ]
        for r in self.reasons[:3]:
            lines.append(f"  {DIM}{r}{RST}")
        lines.append(f"  {'─'*W}")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "size_modifier": self.size_modifier,
            "primary_edge": self.primary_edge_active,
            "hod_pct": round(self.hod_pct, 1),
            "quiet_dump": self.quiet_dump,
            "eq_score": self.eq_score,
            "eq_tier": self.eq_tier,
            "eq_components": self.eq_components,
            "avoid_violations": self.avoid_violations,
            "hard_block": self.hard_block,
            "hold_through_mae": self.hold_through_mae,
            "mae_guidance": self.mae_guidance,
            "confirmations": self.confirmations,
            "size_warnings": self.size_warnings,
            "reasons": self.reasons,
        }


# ── Field readers ──────────────────────────────────────────────────────────────

def _g(sig, *attrs, default=None):
    """Get first non-None attr from sig object or dict."""
    if isinstance(sig, dict):
        for a in attrs:
            if a in sig and sig[a] is not None:
                return sig[a]
        return default
    for a in attrs:
        v = getattr(sig, a, None)
        if v is not None:
            return v
    return default

def _f(v, d=0.0) -> float:
    try:    return float(v)
    except: return d

def _b(v) -> bool:
    if isinstance(v, bool): return v
    if isinstance(v, (int, float)): return bool(v)
    return str(v).lower().strip() in ("true", "1", "yes")


# ── EQ score components ────────────────────────────────────────────────────────

def _eq_chop(chop: float) -> int:
    if chop < 20:  return 25
    if chop < 40:  return 20   # still scores — danger zone handled as avoid rule
    if chop < 60:  return 12
    if chop < 80:  return 5
    return 0

def _eq_regime(regime: str) -> int:
    return {"TRENDING": 20, "TRANSITIONING": 12, "DEAD_CHOP": 3,
            "CHOPPY": 8}.get(str(regime or "").upper().strip(), 10)

def _eq_flips(flips: float) -> int:
    f = int(_f(flips))
    if f == 0: return 15
    if f <= 2: return 12
    if f <= 5: return 8
    if f <= 8: return 4
    return 0

def _eq_velocity(vel) -> int:
    return {"FLAT": 15, "FALLING": 12, "FALLING_FAST": 8,
            "RISING": 6,  "RISING_FAST": 3}.get(
            str(vel or "").upper().strip(), 10)

def _eq_contested(contested) -> int:
    return 2 if _b(contested) else 10

def _eq_s1(confidence_norm: float, section: str) -> int:
    """Proxy for s1_probability using confidence_norm + section."""
    if str(section or "").upper() == "S1":
        if confidence_norm >= 0.85: return 5
        return 4
    return 0


def compute_eq(sig) -> tuple[int, str, dict]:
    chop      = _f(_g(sig, "chop"), 50.0)
    regime    = _g(sig, "regime", default="UNKNOWN")
    flips     = _f(_g(sig, "flips_rth"), 3.0)
    velocity  = _g(sig, "velocity", "score_trajectory", default="FLAT")
    contested = _g(sig, "contested_day", default=False)
    conf_norm = _f(_g(sig, "confidence_norm"), 0.5)
    section   = _g(sig, "section", default="S1")

    comps = {
        "chop":      _eq_chop(chop),
        "nm_regime": _eq_regime(str(regime)),
        "flips":     _eq_flips(flips),
        "velocity":  _eq_velocity(velocity),
        "contested": _eq_contested(contested),
        "s1_proxy":  _eq_s1(conf_norm, str(section)),
    }
    raw   = sum(comps.values())
    score = min(100, round(raw / EQ_MAX_RAW * 100))
    tier  = ("PRIME" if score >= 80 else "GOOD"  if score >= 60 else
             "MIXED" if score >= 40 else "POOR"  if score >= 20 else "SKIP")
    return score, tier, comps


# ── Main evaluation ────────────────────────────────────────────────────────────

def evaluate_signal(sig,
                    halt_count: Optional[int] = None) -> GuidelinesVerdict:
    """
    Apply all Cat5ive guidelines rules to a ClassifierSignal (or dict).

    sig        : ClassifierSignal from v3/v4, or dict (from --json output)
    halt_count : PM halt count if not on signal object

    Returns GuidelinesVerdict.
    """
    v = GuidelinesVerdict()

    # ── Read exact ClassifierSignal fields ──────────────────────────────────
    hod_pct    = _f(_g(sig, "hod_set_pct", "hod_set_pct_session"), 50.0)
    quiet_dump = _b(_g(sig, "quiet_dump_proxy", "quiet_dump_flag", default=False))
    chop       = _f(_g(sig, "chop", "nm_chop_pre"), 30.0)
    flips      = _f(_g(sig, "flips_rth", "flips_before_entry"), 3.0)
    contested  = _b(_g(sig, "contested_day", default=False))
    bias       = str(_g(sig, "bias", default="NO_CONVICTION") or "NO_CONVICTION").upper()
    conf_norm  = _f(_g(sig, "confidence_norm"), 0.5)
    section    = str(_g(sig, "section", default="S1") or "S1").upper()
    regime     = str(_g(sig, "regime", default="UNKNOWN") or "UNKNOWN").upper()
    velocity   = str(_g(sig, "velocity", default="FLAT") or "FLAT").upper()
    fs         = _f(_g(sig, "float_shares"), 0)
    gap        = _f(_g(sig, "gap_pct"), 0)
    halts      = int(_f(_g(sig, "halt_count_pm", default=halt_count or 0)))
    run_day    = int(_f(_g(sig, "run_day"), 0))
    nm_count   = int(_f(_g(sig, "near_miss_count"), 0))

    # NM dominant from bias field
    nm_dominant = (bias if bias in ("S1", "S2", "CONTESTED")
                   else ("S2" if section == "S2" else "S1"))

    # S1 probability proxy
    s1_proxy = conf_norm if section == "S1" else (1.0 - conf_norm)

    v.hod_pct    = hod_pct
    v.quiet_dump = quiet_dump

    # ── §1 PRIMARY EDGE ───────────────────────────────────────────────────────
    hod_early = hod_pct < HOD_EARLY_PCT
    v.primary_edge_active = hod_early and quiet_dump

    # ── §2 CONFIRMATION FILTERS (INDICATIVE) ─────────────────────────────────
    if 30 <= gap < 75:
        v.confirmations.append(f"Gap {gap:.0f}% in 30-75% sweet spot")
    if 1 <= halts <= 2:
        v.confirmations.append(f"{halts} PM halt(s) — 90% win sub-condition")
    if 0 < fs < 2_000_000:
        v.confirmations.append(f"Float {fs/1e6:.2f}M (micro/small <2M)")
    if chop < 20:
        v.confirmations.append(f"Chop {chop:.0f}% — cleanest entry (<20%)")
    if flips <= 2:
        v.confirmations.append(f"{int(flips)} flips — clean pre-entry direction")
    if run_day == 1:
        v.confirmations.append("Day 1 run — freshest setup")

    # Size caveats within the edge
    if fs >= LARGE_FLOAT:
        v.size_warnings.append(
            f"Large float {fs/1e6:.1f}M (≥10M) — edge weakens to 66.7%. Reduce size.")
    if gap < 30:
        v.size_warnings.append(
            f"Gap {gap:.0f}% below 30% — lower quality session")
    if 100_000 <= fs < 2_000_000 and gap > 0:
        pass  # fine, already in confirmation

    # ── §3 HARD AVOID RULES ───────────────────────────────────────────────────
    av = v.avoid_violations

    # AVOID 1 — HOD late (hard block)
    if hod_pct >= HOD_LATE_PCT:
        av.append(f"AVOID 1 [HARD BLOCK]: HOD {hod_pct:.0f}% ≥60% (late) — 23.1% win")
        v.hard_block = True

    # AVOID 2 — Chop 20-40% danger zone (hard block)
    if CHOP_DANGER_LO <= chop < CHOP_DANGER_HI:
        av.append(f"AVOID 2 [HARD BLOCK]: Chop {chop:.0f}% in 20-40% danger zone — 25.0% win")
        v.hard_block = True

    # AVOID 3 — NM Dominant S2
    if nm_dominant == "S2":
        av.append(f"AVOID 3: NM Dominant = S2 (bullish lean) — 32.3% win")

    # AVOID 4 — Low S1 probability proxy
    if s1_proxy < S1_PROXY_LOW:
        av.append(f"AVOID 4: S1 confidence proxy {s1_proxy:.0%} < 40% — 35.1% win")

    # AVOID 5 — Contested day
    if contested:
        av.append(f"AVOID 5: Contested day (flips>8) — 40.0% win")

    # AVOID 6 — No Quiet Dump
    if not quiet_dump:
        av.append(f"AVOID 6: QD=no — 40.2% win")

    # TWO-FACTOR hard blocks
    if hod_pct >= HOD_LATE_PCT and flips >= FLIPS_HIGH:
        av.append(
            f"AVOID 8 [TWO-FACTOR BLOCK]: HOD late + {int(flips)} flips — 12.5% win")
        v.hard_block = True
    if hod_pct >= HOD_LATE_PCT and contested:
        av.append(
            f"AVOID 10 [TWO-FACTOR BLOCK]: HOD late + Contested — 23.8% win")
        v.hard_block = True
    if not quiet_dump and nm_dominant == "S2":
        av.append(f"AVOID 9: QD=no + NM S2 — 25.9% win")

    # ── §4 TRADE MANAGEMENT ───────────────────────────────────────────────────
    if v.primary_edge_active:
        v.hold_through_mae = True
        v.mae_guidance = (
            "HOLD through MAE — HOD+QD sessions: 81%+ win even at 25% MAE. "
            "Do not cut early.")
    else:
        v.hold_through_mae = False
        v.mae_guidance = "Standard stop discipline (hold-through applies to HOD+QD only)."

    # ── §5 ENTRY QUALITY SCORE ─────────────────────────────────────────────────
    v.eq_score, v.eq_tier, v.eq_components = compute_eq(sig)

    # ── VERDICT ────────────────────────────────────────────────────────────────
    n_soft   = sum(1 for a in av if "[HARD BLOCK]" not in a
                                 and "[TWO-FACTOR BLOCK]" not in a)

    if v.hard_block:
        v.verdict       = "BLOCK"
        v.size_modifier = 0.0
        v.reasons.append("Hard block — do not trade.")

    elif v.primary_edge_active and len(av) == 0:
        v.verdict       = "GO"
        v.size_modifier = 1.0 if v.eq_tier in ("PRIME", "GOOD") else 0.75
        v.reasons.append(
            f"Primary edge active. EQ {v.eq_score} [{v.eq_tier}]. "
            f"Size: {v.size_modifier:.0%}.")
        if v.size_warnings:
            v.size_modifier = min(v.size_modifier, 0.75)
            v.reasons.append("Size reduced to 75% — see warnings above.")

    elif v.primary_edge_active and n_soft <= 2:
        v.verdict       = "CAUTION"
        v.size_modifier = 0.5
        v.reasons.append(
            f"Primary edge present but {n_soft} soft avoid(s) firing. "
            f"Half size only.")

    elif not v.primary_edge_active and len(av) == 0:
        v.verdict       = "NO-GO"
        v.size_modifier = 0.0
        v.reasons.append(
            "Primary edge not active (HOD not early, or QD not present). Pass.")

    else:
        v.verdict       = "NO-GO"
        v.size_modifier = 0.0
        v.reasons.append(
            f"Edge absent + {len(av)} avoid signal(s). Pass.")

    return v


# ── Standalone CLI ──────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Cat5ive Guidelines Engine v1.1")
    ap.add_argument("--json",   help="Path to ClassifierSignal JSON")
    ap.add_argument("--hod",    type=float, help="hod_set_pct override")
    ap.add_argument("--qd",     type=int,   help="quiet_dump_proxy (1/0)")
    ap.add_argument("--chop",   type=float, help="chop (0-100)")
    ap.add_argument("--flips",  type=int,   help="flips_rth")
    ap.add_argument("--float",  type=float, help="float_shares")
    ap.add_argument("--gap",    type=float, help="gap_pct")
    ap.add_argument("--halts",  type=int,   help="halt_count_pm")
    ap.add_argument("--bias",   default="S1", help="bias (S1/S2/CONTESTED)")
    ap.add_argument("--conf",   type=float, default=0.85,
                    help="confidence_norm (0-1)")
    ap.add_argument("--out-json", action="store_true")
    args = ap.parse_args()

    if args.json:
        with open(args.json, encoding="utf-8") as f:
            sig = json.load(f)
    else:
        sig = {
            "hod_set_pct":      args.hod   if args.hod   is not None else 50.0,
            "quiet_dump_proxy": args.qd    if args.qd    is not None else 0,
            "chop":             args.chop  if args.chop  is not None else 30.0,
            "flips_rth":        args.flips if args.flips is not None else 3,
            "float_shares":     args.float if args.float is not None else 0,
            "gap_pct":          args.gap   if args.gap   is not None else 0,
            "halt_count_pm":    args.halts if args.halts is not None else 0,
            "bias":             args.bias,
            "confidence_norm":  args.conf,
        }

    verdict = evaluate_signal(sig)

    if args.out_json:
        print(json.dumps(verdict.to_dict(), indent=2))
    else:
        print(verdict.summary())


if __name__ == "__main__":
    main()
