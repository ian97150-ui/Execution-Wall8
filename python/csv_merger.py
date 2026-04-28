#!/usr/bin/env python3
"""
csv_merger.py  — Cat5ive CSV Schema Merger
============================================
Bridges the gap between your app's CSV (27 cols, W3 microstructure)
and the sim's required scoring fields (64 cols, W1 static signals).

Designed for your three-file app setup:
  cat5ive_sim.py          — sim engine (called via CLI with --csv flag)
  finra_loader.py         — VPIN + short vol enrichment
  market_conditions.csv   — your master scoring database

HOW YOUR APP CURRENTLY CALLS THE SIM:
  python cat5ive_sim.py --flips TICKER DATE --csv /tmp/sim_run_XXXXX.csv

THE PROBLEM:
  /tmp/sim_run_XXXXX.csv has 27 cols (W3 data only)
  sim needs 32 scoring fields to compute score — gets 6
  Result: score=0 SKIP all day, noisy flip output

THE FIX — two modes:

  Option A: Intercept + merge (for live app requests)
  ————————————————————————————————————————————————————
  Before your app calls the sim, run this merger on the temp CSV.
  Merges temp CSV with market_conditions.csv into a new temp file.
  Your app then passes the merged file to the sim instead.

  Option B: Permanent sync (one-time setup)
  ———————————————————————————————————————————
  Adds all 58 missing columns to your app CSV permanently.
  Backfills values from market_conditions.csv where ticker+date matches.
  After this, Option A is no longer needed — app CSV is fully compatible.

  CLI:
    python csv_merger.py --merge --app APP.csv --local LOCAL.csv --output OUT.csv
    python csv_merger.py --sync  --app APP.csv --local LOCAL.csv --output OUT.csv
    python csv_merger.py --auto  --app APP.csv --local LOCAL.csv
"""

import csv
import os
import sys
import argparse
import tempfile
from datetime import datetime

# —— Scoring fields the sim needs (referenced in compute_score + get_field_mask)
SIM_SCORING_FIELDS = {
    'run_day', 'prior_offerings_12m', 'ah_move_pct', 'market_regime',
    'tier1_filings', 'company_intent', 'dilution_status', 'liquidity_flag',
    'supply_overhang', 'insider_144_pre_spike', 'wick_ratio', 'vwap_held',
    'structure_quality', 'trap_type', 'pm_move_pct', 'pm_high', 'gap_context',
    'body_ratio', 'imbalance_w1open', 'large_print_zone', 'ah_vol_ratio',
    'ret_d1', 'ret_d3', 'ret_d5', 'ret_d10',
    'ticker', 'spike_date', 'final_type', 'reasoning',
    'outcome_profile', 'confidence_pct',
}

APP_W3_FIELDS = {
    'abnormal_short_ratio', 'baseline_short_vol_ratio',
    'kyle_lambda_norm', 'lambda_regime', 'lambda_signal',
    'mkt_cap_m', 'news_catalyst', 'sector', 'short_interest_pct',
    'short_vol_classification', 'vpin_close', 'vpin_delta',
    'vpin_full', 'vpin_open', 'vpin_regime',
    'short_vol_ratio', 'float_shares', 'gap_pct', 'intraday_move_pct',
    'open_price', 'high_price', 'close_price', 'rth_volume', 'prior_close',
}


# —— I/O helpers ———————————————————————————————————————————————————————————————

def read_csv(path):
    if not os.path.exists(path):
        sys.exit(f"ERROR: File not found: {path}")
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    cols = list(rows[0].keys()) if rows else []
    return rows, cols


def write_csv(path, rows, cols):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)


def session_key(row):
    return (
        row.get('ticker', '').strip().upper(),
        row.get('spike_date', '').strip()
    )


def build_column_order(app_cols, local_cols):
    base     = ['ticker', 'spike_date']
    local_r  = [c for c in local_cols if c not in base]
    app_only = [c for c in app_cols   if c not in local_cols and c not in base]
    return base + local_r + app_only


def merge_fields(app_row, local_row, cols):
    merged = {'ticker': '', 'spike_date': ''}
    for key in ('ticker', 'spike_date'):
        merged[key] = (app_row.get(key)   or '').strip() or \
                      (local_row.get(key) or '').strip()
    for col in cols:
        if col in ('ticker', 'spike_date'):
            continue
        av = (app_row.get(col)   or '').strip()
        lv = (local_row.get(col) or '').strip()
        if col in APP_W3_FIELDS:
            merged[col] = av or lv
        elif col in SIM_SCORING_FIELDS:
            merged[col] = lv or av
        else:
            merged[col] = lv or av
    return merged


# —— OPTION A: merge_for_sim() — called programmatically ———————————————————————

def merge_for_sim(app_csv, local_csv='market_conditions.csv', keep_temp=False):
    """
    Merge app temp CSV with local scoring CSV.
    Returns path to merged temp file — pass this to the sim via --csv.
    """
    app_rows,   app_cols   = read_csv(app_csv)
    local_rows, local_cols = read_csv(local_csv)

    local_map  = {session_key(r): r for r in local_rows}
    final_cols = build_column_order(app_cols, local_cols)

    merged_rows = []
    for app_row in app_rows:
        sk      = session_key(app_row)
        local_r = local_map.get(sk, {})
        merged_rows.append(merge_fields(app_row, local_r, final_cols))

    app_keys = {session_key(r) for r in app_rows}
    for local_row in local_rows:
        if session_key(local_row) not in app_keys:
            merged_rows.append(merge_fields({}, local_row, final_cols))

    fd, out_path = tempfile.mkstemp(suffix='_merged.csv', prefix='cat5_')
    os.close(fd)
    write_csv(out_path, merged_rows, final_cols)
    return out_path


# —— OPTION A: CLI version ——————————————————————————————————————————————————————

def cmd_merge(app_path, local_path, output_path, verbose=True):
    app_rows,   app_cols   = read_csv(app_path)
    local_rows, local_cols = read_csv(local_path)

    local_map  = {session_key(r): r for r in local_rows}
    app_map    = {session_key(r): r for r in app_rows}
    final_cols = build_column_order(app_cols, local_cols)

    merged_rows = []
    stats = {'both': 0, 'app_only': 0, 'local_only': 0}

    for app_row in app_rows:
        sk      = session_key(app_row)
        local_r = local_map.get(sk, {})
        row     = merge_fields(app_row, local_r, final_cols)
        row['_source'] = 'both' if local_r else 'app_only'
        merged_rows.append(row)
        stats['both' if local_r else 'app_only'] += 1

    for local_row in local_rows:
        if session_key(local_row) not in app_map:
            row = merge_fields({}, local_row, final_cols)
            row['_source'] = 'local_only'
            merged_rows.append(row)
            stats['local_only'] += 1

    final_cols_with_src = final_cols + ['_source']
    write_csv(output_path, merged_rows, final_cols_with_src)

    if verbose:
        covered = sum(1 for f in SIM_SCORING_FIELDS if f in set(final_cols))
        missing = [f for f in SIM_SCORING_FIELDS if f not in set(final_cols)]
        print(f"\n  Option A — Runtime Merge")
        print(f"  {'—'*40}")
        print(f"  Output:          {output_path}")
        print(f"  Total sessions:  {len(merged_rows)}")
        print(f"  In both:         {stats['both']} (W1 + W3 fields)")
        print(f"  App only:        {stats['app_only']} (W3 only — score=0)")
        print(f"  Local only:      {stats['local_only']} (W1 only)")
        print(f"  Columns:         {len(final_cols)}")
        print(f"  Scoring fields:  {covered}/{len(SIM_SCORING_FIELDS)}")
        if missing:
            print(f"  Still missing:   {', '.join(sorted(missing))}")
        else:
            print(f"  All scoring fields covered ✓")


# —— OPTION B: Permanent schema sync ————————————————————————————————————————————

def cmd_sync(app_path, local_path, output_path, verbose=True):
    app_rows,   app_cols   = read_csv(app_path)
    local_rows, local_cols = read_csv(local_path)
    local_map = {session_key(r): r for r in local_rows}

    missing_cols = [c for c in local_cols
                    if c not in app_cols and c not in ('ticker', 'spike_date')]
    new_cols = app_cols + missing_cols

    synced_rows    = []
    backfill_count = 0
    matched_count  = 0

    for app_row in app_rows:
        new_row = dict(app_row)
        sk      = session_key(app_row)
        local_r = local_map.get(sk)
        if local_r:
            matched_count += 1
        for col in missing_cols:
            val = (local_r.get(col, '') if local_r else '').strip()
            new_row[col] = val
            if val:
                backfill_count += 1
        synced_rows.append(new_row)

    write_csv(output_path, synced_rows, new_cols)

    if verbose:
        covered   = sum(1 for f in SIM_SCORING_FIELDS if f in set(new_cols))
        unmatched = [session_key(r) for r in app_rows
                     if session_key(r) not in local_map]
        print(f"\n  Option B — Permanent Schema Sync")
        print(f"  {'—'*40}")
        print(f"  Output:            {output_path}")
        print(f"  Rows processed:    {len(app_rows)}")
        print(f"  Matched to local:  {matched_count}")
        print(f"  No local match:    {len(unmatched)}")
        print(f"  Columns added:     {len(missing_cols)}")
        print(f"  Values backfilled: {backfill_count}")
        print(f"  New schema:        {len(new_cols)} columns")
        print(f"  Scoring fields:    {covered}/{len(SIM_SCORING_FIELDS)}")
        missing_sf = [f for f in SIM_SCORING_FIELDS if f not in set(new_cols)]
        if missing_sf:
            print(f"  Still missing:     {', '.join(sorted(missing_sf))}")
        else:
            print(f"  All scoring fields covered ✓")


# —— AUTO: run both and compare —————————————————————————————————————————————————

def cmd_auto(app_path, local_path, out_dir):
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    merged_path = os.path.join(out_dir, f'cat5_merged_{ts}.csv')
    synced_path = os.path.join(out_dir, f'cat5_synced_{ts}.csv')

    print(f"\nCAT5IVE CSV MERGER — running both options")
    cmd_merge(app_path, local_path, merged_path)
    cmd_sync(app_path,  local_path, synced_path)

    def coverage(path):
        _, cols = read_csv(path)
        return sum(1 for f in SIM_SCORING_FIELDS if f in set(cols))

    a     = coverage(merged_path)
    b     = coverage(synced_path)
    total = len(SIM_SCORING_FIELDS)

    print(f"\n{'='*55}")
    print(f"SUMMARY")
    print(f"{'='*55}")
    print(f"  Option A (merge):  {a}/{total} scoring fields — {merged_path}")
    print(f"  Option B (sync):   {b}/{total} scoring fields — {synced_path}")
    print(f"\nRECOMMENDATION:")
    print(f"  Use Option A now — immediate fix for all sim commands.")
    print(f"  Use Option B once — permanently upgrade your app CSV schema.")
    print(f"\nTest immediately:")
    print(f"  python cat5ive_sim.py --flips ALLO 2026-04-10 --csv {merged_path}")


# —— CLI ————————————————————————————————————————————————————————————————————————

def main():
    parser = argparse.ArgumentParser(
        description="Cat5ive CSV Merger — fix schema mismatch between app and sim",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--merge', action='store_true',
                       help='Option A: merge for one sim run')
    group.add_argument('--sync',  action='store_true',
                       help='Option B: permanently add missing columns to app CSV')
    group.add_argument('--auto',  action='store_true',
                       help='Run both options and compare results')

    parser.add_argument('--app',     required=True)
    parser.add_argument('--local',   required=True)
    parser.add_argument('--output',  default=None)
    parser.add_argument('--out-dir', default='.')

    args = parser.parse_args()

    if args.auto:
        os.makedirs(args.out_dir, exist_ok=True)
        cmd_auto(args.app, args.local, args.out_dir)
    elif args.merge:
        cmd_merge(args.app, args.local, args.output or 'cat5_merged.csv')
    elif args.sync:
        cmd_sync(args.app, args.local, args.output or 'cat5_synced.csv')


if __name__ == '__main__':
    main()
