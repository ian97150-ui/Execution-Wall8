import React, { useState } from 'react';
import { cn } from "@/lib/utils";
import {
  TrendingUp, TrendingDown, BookMarked, BadgeCheck, FileText, ExternalLink,
  FlaskConical, CheckCircle2, XCircle, Loader2, RefreshCw, ChevronDown, ChevronUp,
  AlertTriangle, BarChart2, Activity, TrendingDown as ShortIcon, Plus, Trash2, Eye, Zap
} from "lucide-react";
import { Button } from "@/components/ui/button";
import QualityBadge from "./QualityBadge";
import BiasBadge from "./BiasBadge";
import api from '@/api/apiClient';

const SEC_SCANNER_URL = import.meta.env.VITE_SEC_SCANNER_URL || 'https://web-production-dcf57.up.railway.app';

function SecScannerTest() {
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function runTest() {
    if (!ticker.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${SEC_SCANNER_URL}/sec-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.trim().toUpperCase(), send_pushover: true })
      });
      const data = await res.json();
      setResult(data);
    } catch (e) {
      setResult({ error: 'Could not reach SEC scanner: ' + e.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden group">
      <summary className="flex items-center gap-2 px-4 py-2.5 cursor-pointer list-none select-none text-slate-500 hover:text-slate-300 transition-colors">
        <FlaskConical className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">Test SEC Scanner</span>
        <ChevronDown className="w-3 h-3 ml-auto group-open:rotate-180 transition-transform" />
      </summary>
    <div className="px-4 pb-4 space-y-3">
      <div className="flex items-center gap-2 pt-2">
        <FlaskConical className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-semibold text-slate-300">Test SEC Scanner</span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && runTest()}
          placeholder="Enter ticker..."
          maxLength={10}
          className="flex-1 bg-slate-900/50 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
        />
        <Button
          onClick={runTest}
          disabled={loading || !ticker.trim()}
          size="sm"
          className="bg-violet-600 hover:bg-violet-700 text-white"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Check'}
        </Button>
      </div>

      {result && (
        <div className={cn(
          "rounded-lg p-3 text-xs space-y-1",
          result.error ? "bg-red-500/10 border border-red-500/30" :
          result.found ? "bg-cyan-500/10 border border-cyan-500/30" :
          "bg-slate-700/50 border border-slate-600/50"
        )}>
          {result.error ? (
            <div className="flex items-center gap-1.5 text-red-400">
              <XCircle className="w-3.5 h-3.5" /> {result.error}
            </div>
          ) : result.found ? (
            <>
              <div className="flex items-center gap-1.5 text-cyan-400 font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" /> Filing found — Pushover sent
              </div>
              <p className="text-slate-300">{result.company_name}</p>
              {result.filings.map((f, i) => (
                <a key={i} href={f.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-cyan-400 hover:underline">
                  <FileText className="w-3 h-3" /> {f.form} — {f.date}
                </a>
              ))}
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-slate-400">
              <XCircle className="w-3.5 h-3.5" /> No watched filings for {result.ticker} today
            </div>
          )}
        </div>
      )}
    </div>
    </details>
  );
}

// Visual scan history tokens
function ScanHistoryTokens({ history }) {
  if (!history || history.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] text-slate-500 mr-0.5">Scans:</span>
      {history.map((entry, i) => {
        const time = new Date(entry.at).toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric', minute: '2-digit', hour12: true
        });
        const dotColor = entry.error
          ? 'bg-red-500/70 border-red-400/60'
          : entry.found ? 'bg-cyan-400 border-cyan-300' : 'bg-slate-600 border-slate-500';
        const label = entry.error
          ? `Error at ${time}: ${entry.error}`
          : entry.found ? `Found at ${time} — ${entry.filings?.length ?? 1} filing(s)`
          : `No filing at ${time}`;
        return (
          <span
            key={i}
            title={label}
            className={cn('w-2.5 h-2.5 rounded-full border cursor-help transition-transform hover:scale-125', dotColor)}
          />
        );
      })}
    </div>
  );
}

// ─── Checklist Panel ──────────────────────────────────────────────────────────

function ChecklistRow({ label, value, signal = false, neutral = false }) {
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-[11px] text-slate-500 shrink-0">{label}</span>
      <span className={cn(
        "text-[11px] font-medium text-right",
        signal ? "text-red-400" : neutral ? "text-slate-400" : "text-slate-300"
      )}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function ManualToggle({ label, value, onChange }) {
  // Cycles: null → true → false → null
  const display = value === true ? '✓ YES' : value === false ? '✗ NO' : 'tap to set';
  const colorClass = value === true ? 'text-red-400 border-red-500/50' :
                     value === false ? 'text-slate-500 border-slate-600/50' :
                     'text-slate-500 border-slate-600/50';
  function cycle() {
    if (value === null || value === undefined) onChange(true);
    else if (value === true) onChange(false);
    else onChange(null);
  }
  return (
    <button
      onClick={cycle}
      className={cn(
        "flex items-center justify-between w-full px-2 py-1 rounded border text-[11px] transition-colors hover:bg-slate-700/50",
        colorClass
      )}
    >
      <span className="text-slate-400">{label}</span>
      <span className="font-semibold">{display}</span>
    </button>
  );
}

function ChecklistPanel({ checklist, onRunChecklist, onToggleManual, intent, runningChecklist }) {
  if (!checklist) return null;
  const { phase1, phase1b, phase2, phase3, phase4, overrides, bias, score, completion_pct, run_at, score_snapshot: scoreSnapshot } = checklist;

  const runAt = run_at ? new Date(run_at).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' ET' : null;

  const CONFIRMATION_CORRELATION = {
    OFFERING_LIVE: 'EDGAR independently confirmed same-day 424B \u2713',
    ATM_LIVE:      'ATM/underwriting 8-K + external scanner confirmed',
    PRIME_SHORT:   'Serial diluter confirmed by external scanner',
  };
  const correlationMsg = intent?.sec_confirmed ? CONFIRMATION_CORRELATION[bias] : null;

  // Active overrides for display
  const activeOverrides = overrides ? [
    overrides.override_ah_reversal && { key: 'AH_REVERSED', label: `AH Reversed (${phase1b?.ah_reversal_pct?.toFixed(0)}% fade)` },
    overrides.override_blowoff && { key: 'BLOW_OFF_TOP', label: `Blow-Off Top (wick ${phase3?.wick_ratio?.toFixed(2)}, VWAP failed)` },
    overrides.override_overextended && { key: 'OVEREXTENDED', label: `Overextended (+${phase1b?.gap_pct?.toFixed(0)}% gap)` },
    overrides.override_low_float_parabolic && { key: 'PARABOLIC', label: `Parabolic Day ${phase3?.day_of_run} — no new catalyst` },
    overrides.override_offering_spike && { key: 'OFFERING_SPIKE', label: 'Offering spike — price near PM high with 424B' },
    overrides.override_weak_hold && { key: 'WEAK_HOLD', label: `Weak hold — ${phase4?.short_float_pct?.toFixed(0)}% short float` },
  ].filter(Boolean) : [];

  return (
    <div className="mt-3 border border-slate-700/50 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/80 border-b border-slate-700/50">
        <BiasBadge bias={bias} size="sm" />
        {/* Numeric score chip */}
        {score !== undefined && (
          <span className={cn(
            "text-xs font-mono font-bold px-1.5 py-0.5 rounded shrink-0",
            score > 5 ? 'bg-red-500/20 text-red-400' :
            score < -5 ? 'bg-emerald-500/20 text-emerald-400' :
            'bg-slate-700/50 text-slate-400'
          )}>
            {score > 0 ? `+${score}` : score}
          </span>
        )}
        <div className="flex-1 flex items-center gap-2">
          <div className="flex-1 bg-slate-700/50 rounded-full h-1.5">
            <div
              className="bg-violet-500/70 h-1.5 rounded-full transition-all"
              style={{ width: `${completion_pct}%` }}
            />
          </div>
          <span className="text-[10px] text-slate-500 shrink-0">{completion_pct}%</span>
        </div>
        <button
          onClick={() => onRunChecklist?.(intent)}
          disabled={runningChecklist}
          className="text-slate-400 hover:text-violet-400 transition-colors ml-1"
          title="Refresh checklist"
        >
          <RefreshCw className={cn("w-3 h-3", runningChecklist && "animate-spin")} />
        </button>
      </div>

      {/* Correlation banner */}
      {correlationMsg && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/10 border-b border-cyan-500/20">
          <BadgeCheck className="w-3 h-3 text-cyan-400 shrink-0" />
          <span className="text-[11px] text-cyan-300">{correlationMsg}</span>
        </div>
      )}

      <div className="px-3 py-2 space-y-3 bg-slate-900/50">

        {/* Cat5ive Score Snapshot */}
        {scoreSnapshot && (
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-3 space-y-2">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
              <TrendingDown className="w-3 h-3" /> Cat5ive Score
            </p>

            {/* Override chips */}
            {scoreSnapshot.overrides_fired?.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {scoreSnapshot.overrides_fired.map(o => (
                  <span key={o} className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    ⚡ {o.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}

            {/* Section badge + bias chip + confidence + score */}
            <div className="flex items-center gap-2 flex-wrap">
              {scoreSnapshot.section && (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide bg-slate-700/60 text-slate-300 border border-slate-600/50">
                  {scoreSnapshot.section} {scoreSnapshot.section === 'S1' ? 'D+1' : 'D+5'}
                </span>
              )}
              <span className={cn(
                "px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide",
                scoreSnapshot.bias === 'MAX_CONVICTION'  ? "bg-red-600/30 text-red-300 border border-red-600/50" :
                scoreSnapshot.bias === 'HIGH_CONVICTION' ? "bg-red-500/20 text-red-400 border border-red-500/40" :
                scoreSnapshot.bias === 'CONFIRMED_SHORT' ? "bg-red-400/15 text-red-400 border border-red-400/30" :
                scoreSnapshot.bias === 'LONG_CANDIDATE'  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" :
                scoreSnapshot.bias === 'LONG_BIAS'       ? "bg-emerald-500/10 text-emerald-400/80 border border-emerald-500/30" :
                "bg-slate-700/50 text-slate-400 border border-slate-600/50"
              )}>
                {scoreSnapshot.bias.replace(/_/g, ' ')}
              </span>
              <span className="text-xs font-mono text-slate-500">
                {Math.round(scoreSnapshot.confidence * 100)}% conf
              </span>
              <span className={cn(
                "text-xs font-mono font-bold ml-auto",
                scoreSnapshot.score >= 8 ? "text-red-400" : scoreSnapshot.score <= -3 ? "text-emerald-400" : "text-slate-400"
              )}>
                {scoreSnapshot.score > 0 ? `+${scoreSnapshot.score}` : scoreSnapshot.score}
              </span>
            </div>

            {/* Regime chip */}
            {scoreSnapshot.regime && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide bg-violet-500/20 text-violet-300 border border-violet-500/40">
                  {scoreSnapshot.regime.regime.replace(/_/g, ' ')}
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  n={scoreSnapshot.regime.n} · {scoreSnapshot.regime.dump_pct}% dump · D+5 {scoreSnapshot.regime.d5_avg}%
                </span>
              </div>
            )}

            {/* Pattern stats for fired overrides */}
            {scoreSnapshot.pattern_stats?.length > 0 && (
              <div className="space-y-1">
                {scoreSnapshot.pattern_stats.map(p => (
                  <div key={p.pattern} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <span className="text-[10px] font-bold text-amber-300 shrink-0">{p.pattern.replace(/_/g, ' ')}</span>
                    <span className="text-[10px] text-slate-400 font-mono ml-auto">
                      n={p.n} · {p.dump_pct}% dump · D+5 {p.d5_avg}%{p.max_dd ? ` · MaxDD ${p.max_dd}%` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* S1/S2 empirical probability */}
            {scoreSnapshot.section_prob && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-slate-500 shrink-0">S1/S2 odds</span>
                <div className="flex-1 flex items-center gap-1">
                  <div className="flex-1 h-1 bg-slate-700/50 rounded-full overflow-hidden">
                    <div className="h-full bg-red-500/60 rounded-full" style={{ width: `${scoreSnapshot.section_prob.s1_pct}%` }} />
                  </div>
                  <span className="font-mono text-red-400 w-8 text-right">{scoreSnapshot.section_prob.s1_pct}%</span>
                  <span className="text-slate-600">/</span>
                  <span className="font-mono text-blue-400 w-8">{scoreSnapshot.section_prob.s2_pct}%</span>
                </div>
                <span className="text-slate-600 italic">{scoreSnapshot.section_prob.basis}</span>
              </div>
            )}

            {/* S1 Clean score bar + D+1/D+5 expected */}
            {scoreSnapshot.section === 'S1' && scoreSnapshot.clean_score !== null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-slate-500">Clean score</span>
                  <span className={cn(
                    "font-bold",
                    scoreSnapshot.clean_outcome === 'DUMP'          ? "text-emerald-400" :
                    scoreSnapshot.clean_outcome === 'CLEAN_FADE'    ? "text-blue-400" :
                    scoreSnapshot.clean_outcome === 'VOLATILE_FADE' ? "text-yellow-400" :
                    "text-red-400"
                  )}>
                    {scoreSnapshot.clean_score}/10 — {scoreSnapshot.clean_outcome?.replace('_', ' ')}
                  </span>
                </div>
                <div className="h-1 bg-slate-700/50 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      scoreSnapshot.clean_outcome === 'DUMP'          ? "bg-emerald-500" :
                      scoreSnapshot.clean_outcome === 'CLEAN_FADE'    ? "bg-blue-500" :
                      scoreSnapshot.clean_outcome === 'VOLATILE_FADE' ? "bg-yellow-500" :
                      "bg-red-500"
                    )}
                    style={{ width: `${scoreSnapshot.clean_score * 10}%` }}
                  />
                </div>
                {scoreSnapshot.outcome_profile && (
                  <div className="flex gap-3 pt-0.5">
                    <span className="text-[10px] font-mono text-slate-500">
                      D+1 avg <span className="text-red-400 font-bold">{scoreSnapshot.outcome_profile.d1_avg}%</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      D+5 avg <span className="text-red-400 font-bold">{scoreSnapshot.outcome_profile.d5_avg}%</span>
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Pressure bar */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500 w-8 text-right">LONG</span>
              <div className="flex-1 relative h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
                <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
                {scoreSnapshot.score !== 0 && (
                  <div
                    className={cn(
                      "absolute inset-y-0 rounded-full",
                      scoreSnapshot.score < 0 ? "bg-emerald-500/70 right-1/2" : "bg-red-500/70 left-1/2"
                    )}
                    style={{ width: `${Math.min(Math.abs(scoreSnapshot.score) / 20 * 50, 50)}%` }}
                  />
                )}
              </div>
              <span className="text-[10px] text-slate-500 w-8">SHORT</span>
            </div>

            {/* Probability paths */}
            {scoreSnapshot.probabilities?.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {scoreSnapshot.probabilities.map(p => (
                  <span key={p.path} className={cn(
                    "px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize",
                    p.path === 'dump' || p.path === 'fade' || p.path === 'failure'
                      ? "bg-red-500/15 text-red-400"
                      : p.path === 'chop'
                      ? "bg-yellow-500/15 text-yellow-400"
                      : "bg-emerald-500/15 text-emerald-400"
                  )}>
                    {p.path} {p.pct}%
                  </span>
                ))}
              </div>
            )}

            {/* Reason */}
            {scoreSnapshot.reason && (
              <p className="text-[10px] text-slate-500 italic">{scoreSnapshot.reason}</p>
            )}
          </div>
        )}

        {/* Phase 1 — EDGAR + Analyst */}
        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1">
            <FileText className="w-3 h-3" /> Phase 1 — EDGAR + Analyst
          </p>
          {phase1?.error && (
            <p className="text-[11px] text-red-400/80 mb-1">{phase1.error}</p>
          )}
          <ChecklistRow
            label="Shelf filing"
            value={phase1?.shelf_type
              ? `${phase1.shelf_type} · ${phase1.shelf_age_days}d ago`
              : 'None'}
            signal={!!phase1?.shelf_type}
          />
          <ChecklistRow
            label="424Bs (12m)"
            value={`${phase1?.prior_424b_count_12m ?? 0} filing${phase1?.prior_424b_count_12m !== 1 ? 's' : ''}${(phase1?.prior_424b_count_12m ?? 0) >= 2 ? ' ← SERIAL' : ''}`}
            signal={(phase1?.prior_424b_count_12m ?? 0) >= 2}
            neutral={(phase1?.prior_424b_count_12m ?? 0) === 0}
          />
          {phase1?.same_day_424b?.length > 0 && (
            <div className="flex flex-wrap gap-1 my-0.5">
              {phase1.same_day_424b.map((f, i) => (
                <a key={i} href={f.filing_url} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-red-400 border border-red-500/40 rounded px-1.5 py-0.5 hover:bg-red-500/10">
                  {f.form} TODAY ↗
                </a>
              ))}
            </div>
          )}
          <ChecklistRow
            label="8-K (48h)"
            value={phase1?.eightk?.found
              ? (phase1.eightk.signals?.length > 0
                  ? phase1.eightk.signals.join(', ')
                  : `Found ${phase1.eightk.filing_date}`)
              : 'No 8-K found'}
            signal={phase1?.eightk?.signals?.length > 0}
            neutral={!phase1?.eightk?.found}
          />
          {phase1?.eightk?.found && phase1?.eightk?.filing_url && (
            <a href={phase1.eightk.filing_url} target="_blank" rel="noopener noreferrer"
              className="text-[10px] text-cyan-500 hover:underline flex items-center gap-0.5">
              View 8-K ↗
            </a>
          )}
          {phase1?.analyst && !phase1.analyst.error && (
            <ChecklistRow
              label="Analyst"
              value={phase1.analyst.analyst_bias
                ? `${(phase1.analyst.buy ?? 0) + (phase1.analyst.strong_buy ?? 0)}B / ${phase1.analyst.hold ?? 0}H / ${(phase1.analyst.sell ?? 0) + (phase1.analyst.strong_sell ?? 0)}S → ${phase1.analyst.analyst_bias}`
                : 'No data'}
              signal={phase1.analyst.analyst_bias === 'BEARISH'}
              neutral={phase1.analyst.analyst_bias !== 'BEARISH'}
            />
          )}
        </div>

        {/* Phase 1b — After Hours */}
        {phase1b && (
          <div>
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1">
              <Activity className="w-3 h-3" /> Phase 1b — After Hours
            </p>
            {phase1b.ah_move_pct !== null ? (
              <>
                <ChecklistRow
                  label="AH move"
                  value={`${phase1b.ah_move_pct > 0 ? '+' : ''}${phase1b.ah_move_pct?.toFixed(1)}%`}
                  signal={phase1b.ah_move_pct > 50}
                  neutral={phase1b.ah_move_pct <= 50}
                />
                <ChecklistRow
                  label="AH type"
                  value={phase1b.ah_classification === 'THIN_AH_SPIKE'
                    ? `THIN SPIKE (vol ${phase1b.ah_vol_ratio?.toFixed(2)}x) ← manufactured`
                    : phase1b.ah_classification === 'HEALTHY_AH_BUILD'
                    ? `HEALTHY BUILD (vol ${phase1b.ah_vol_ratio?.toFixed(2)}x)`
                    : '—'}
                  signal={phase1b.ah_classification === 'THIN_AH_SPIKE'}
                  neutral={phase1b.ah_classification !== 'THIN_AH_SPIKE'}
                />
                {phase1b.ah_reversal_pct !== null && (
                  <ChecklistRow
                    label="AH reversal"
                    value={`${phase1b.ah_reversal_pct > 0 ? '+' : ''}${phase1b.ah_reversal_pct?.toFixed(1)}%${phase1b.ah_reversal_pct < -30 ? ' — STRONG DUMP SIGNAL' : phase1b.ah_reversal_pct < 0 ? ' — fading' : ' — holding'}`}
                    signal={phase1b.ah_reversal_pct < -30}
                    neutral={phase1b.ah_reversal_pct >= -30}
                  />
                )}
                {phase1b.prior_close !== null && (
                  <ChecklistRow
                    label="Prior close"
                    value={`$${phase1b.prior_close?.toFixed(2)}`}
                    neutral
                  />
                )}
                {phase1b.gap_pct !== null && (
                  <ChecklistRow
                    label="Gap at open"
                    value={`+${phase1b.gap_pct?.toFixed(1)}% (PM high vs prior close)${(phase1b.gap_pct ?? 0) > 80 ? ' ⚠️ OVEREXTENDED' : (phase1b.gap_pct ?? 0) > 40 ? ' — elevated' : ''}`}
                    signal={(phase1b.gap_pct ?? 0) > 80}
                    neutral={(phase1b.gap_pct ?? 0) <= 80}
                  />
                )}
              </>
            ) : (
              <p className="text-[11px] text-slate-600 italic">No AH data — alert may have fired during RTH</p>
            )}
          </div>
        )}

        {/* Phase 2 — Catalyst */}
        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Phase 2 — Catalyst
          </p>
          <ChecklistRow
            label="Catalyst tier"
            value={phase2?.catalyst_tier !== null
              ? `Tier ${phase2.catalyst_tier}${phase2.catalyst_tier >= 3 ? ' — vague PR' : phase2.catalyst_tier === 1 ? ' — FDA/trial' : ''}`
              : 'No 8-K'}
            signal={phase2?.catalyst_tier !== null && phase2.catalyst_tier >= 3}
            neutral={phase2?.catalyst_tier === null}
          />
          <ChecklistRow
            label="Proceeds"
            value={phase2?.proceeds_type ?? 'Unknown'}
            signal={phase2?.proceeds_type === 'LOSSES'}
            neutral={phase2?.proceeds_type !== 'LOSSES'}
          />
          {phase2?.news_fallback?.length > 0 && (
            <div className="mt-1 space-y-0.5">
              <p className="text-[10px] text-slate-600">News (no 8-K found):</p>
              {phase2.news_fallback.map((n, i) => (
                <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
                  className="block text-[10px] text-slate-400 hover:text-cyan-400 truncate">
                  · {n.headline}
                </a>
              ))}
            </div>
          )}
          <div className="mt-1.5">
            <ManualToggle
              label="Sympathy trade (manual)"
              value={phase2?.sympathy_trade}
              onChange={(v) => onToggleManual?.(intent, 'phase2', 'sympathy_trade', v)}
            />
          </div>
        </div>

        {/* Phase 3 — Price Action */}
        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1">
            <BarChart2 className="w-3 h-3" /> Phase 3 — Price Action
          </p>
          {!phase3?.market_open && (
            <p className="text-[11px] text-slate-600 italic mb-1">Market not open yet — RTH data pending</p>
          )}
          {phase3?.pm_high !== null && (
            <ChecklistRow
              label="PM High / RTH Open"
              value={`$${phase3.pm_high?.toFixed(2)} / $${phase3.rth_open?.toFixed(2) ?? '—'} ${phase3.pm_high_reclaimed === false ? '✗ not reclaimed' : phase3.pm_high_reclaimed ? '✓ reclaimed' : ''}`}
              signal={phase3.pm_high_reclaimed === false}
              neutral={phase3.pm_high_reclaimed !== false}
            />
          )}
          {phase1b?.gap_pct !== null && phase3?.pm_high !== null && (
            <ChecklistRow
              label="Gap at RTH"
              value={`+${phase1b?.gap_pct?.toFixed(1)}% (PM vs prior close)`}
              signal={(phase1b?.gap_pct ?? 0) > 80}
              neutral={(phase1b?.gap_pct ?? 0) <= 80}
            />
          )}
          {phase3?.vwap !== null && (
            <ChecklistRow
              label="VWAP"
              value={`$${phase3.vwap?.toFixed(2)}${phase3.current_price ? ` · curr $${phase3.current_price?.toFixed(2)}` : ''} ${phase3.vwap_failed ? '✗ failed' : '✓ holding'}`}
              signal={phase3.vwap_failed === true}
              neutral={!phase3.vwap_failed}
            />
          )}
          {phase3?.wick_ratio !== null && (
            <ChecklistRow
              label="Wick ratio"
              value={`${phase3.wick_ratio?.toFixed(2)}${phase3.wick_ratio > 0.80 ? ' — BLOW-OFF' : phase3.wick_ratio > 0.65 ? ' — distribution' : ' — normal'}`}
              signal={phase3.wick_ratio > 0.65}
              neutral={phase3.wick_ratio <= 0.65}
            />
          )}
          {phase3?.volume_ratio !== null && (
            <ChecklistRow
              label="Volume"
              value={`${phase3.volume_ratio?.toFixed(1)}x avg`}
              signal={phase3.volume_ratio >= 5}
              neutral={phase3.volume_ratio < 5}
            />
          )}
          {phase3?.day_of_run !== null && (
            <ChecklistRow
              label="Day of run"
              value={`Day ${phase3.day_of_run}${phase3.day_of_run >= 3 ? ' ← no exception' : ''}`}
              signal={phase3.day_of_run >= 3}
              neutral={phase3.day_of_run < 3}
            />
          )}

          {/* Manual phase3 inputs — scored by Cat5ive engine */}
          <div className="mt-1.5 space-y-1.5">
            <p className="text-[10px] text-slate-600 uppercase tracking-wide">Manual inputs</p>

            {/* Structure */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400 shrink-0">Structure</span>
              <select
                value={phase3?.structure ?? ''}
                onChange={e => onToggleManual?.(intent, 'phase3', 'structure', e.target.value || null)}
                className="flex-1 max-w-[160px] bg-slate-800/60 border border-slate-600/50 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-violet-500"
              >
                <option value="">— not set —</option>
                <option value="BLOW_OFF_TOP">BLOW OFF TOP</option>
                <option value="WEAK_HOLD">WEAK HOLD</option>
                <option value="STRONG_HOLD">STRONG HOLD</option>
                <option value="RANGE">RANGE</option>
              </select>
            </div>

            {/* Large print zone */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400 shrink-0">Large print zone</span>
              <select
                value={phase3?.large_print_zone ?? ''}
                onChange={e => onToggleManual?.(intent, 'phase3', 'large_print_zone', e.target.value || null)}
                className="flex-1 max-w-[160px] bg-slate-800/60 border border-slate-600/50 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-violet-500"
              >
                <option value="">— not set —</option>
                <option value="BELOW_VWAP">BELOW VWAP (+2)</option>
                <option value="ABOVE_VWAP">ABOVE VWAP</option>
              </select>
            </div>

            {/* Borrow */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400 shrink-0">Borrow (IBKR)</span>
              <select
                value={phase3?.borrow ?? ''}
                onChange={e => onToggleManual?.(intent, 'phase3', 'borrow', e.target.value || null)}
                className="flex-1 max-w-[160px] bg-slate-800/60 border border-slate-600/50 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-violet-500"
              >
                <option value="">— not set —</option>
                <option value="EASY">EASY</option>
                <option value="HARD">HARD</option>
                <option value="HTB">HTB</option>
                <option value="NO_LOCATE">NO LOCATE</option>
              </select>
            </div>

            {/* W1 open imbalance */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400 shrink-0">W1 imbalance</span>
              <input
                type="number"
                min="-1"
                max="1"
                step="0.01"
                value={phase3?.w1_imbalance ?? ''}
                onChange={e => {
                  const val = e.target.value === '' ? null : parseFloat(e.target.value);
                  onToggleManual?.(intent, 'phase3', 'w1_imbalance', val);
                }}
                placeholder="e.g. 0.65"
                className="w-24 bg-slate-800/60 border border-slate-600/50 rounded px-2 py-1 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-violet-500"
              />
            </div>
          </div>
        </div>

        {/* Phase 4 — Float & Short Interest */}
        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1">
            <ShortIcon className="w-3 h-3" /> Phase 4 — Float &amp; Short Interest
          </p>
          {phase4?.error === 'NO_API_KEY' ? (
            <p className="text-[11px] text-slate-600 italic">Not configured — add FINNHUB_API_KEY</p>
          ) : phase4?.error ? (
            <p className="text-[11px] text-slate-600 italic">{phase4.error}</p>
          ) : (
            <>
              <ChecklistRow
                label="Shares outstanding"
                value={phase4?.shares_outstanding ? `${phase4.shares_outstanding.toFixed(1)}M` : '—'}
                neutral
              />
              <ChecklistRow
                label="Short interest"
                value={phase4?.short_float_pct !== null
                  ? `${phase4.short_float_pct?.toFixed(1)}% of float${phase4.short_date ? ` · ${phase4.short_date}` : ''}`
                  : phase4?.short_interest ? `${(phase4.short_interest / 1e6).toFixed(2)}M shares` : '—'}
                signal={(phase4?.short_float_pct ?? 0) >= 20}
                neutral={(phase4?.short_float_pct ?? 0) < 20}
              />
            </>
          )}
        </div>

        {/* Overrides — computed (shown always, active ones highlighted) */}
        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Overrides (computed)
          </p>
          {activeOverrides.length > 0 ? (
            <div className="space-y-0.5">
              {activeOverrides.map((o) => (
                <div key={o.key} className="flex items-center gap-1.5 text-[11px] text-red-400">
                  <XCircle className="w-3 h-3 shrink-0" />
                  {o.label}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-slate-600 italic">No overrides triggered</p>
          )}
        </div>

        {runAt && (
          <p className="text-[10px] text-slate-700 text-right">Last run: {runAt}</p>
        )}
      </div>
    </div>
  );
}

const getSecUrl = (ticker) => {
  const forms = "10-K%2C10-K405%2C10-KT%2C10-Q%2C8-K%2CF-3%2CF-3ASR%2CF-3DPOS%2CF-3MEF%2CN-2%2CN-2%20POSASR%2CS-1%2CS-11%2CS-11MEF%2CS-1MEF%2CS-3%2CS-3ASR%2CS-3D%2CS-3DPOS%2CS-3MEF%2CSF-3%2C6-K";
  return `https://www.sec.gov/edgar/search/#/dateRange=30d&category=custom&entityName=${ticker}&forms=${forms}`;
};

function AddTickerInput({ onAdd, isAdding }) {
  const [ticker, setTicker] = useState('');

  const handleAdd = () => {
    const t = ticker.trim().toUpperCase();
    if (!t || isAdding) return;
    onAdd(t);
    setTicker('');
  };

  return (
    <div className="bg-violet-950/40 border-2 border-violet-500/50 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Eye className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-bold text-violet-300">Watch a ticker</span>
        <span className="text-xs text-violet-500">run full scorecard without a WALL card</span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="Ticker symbol e.g. MULN"
          maxLength={6}
          className="flex-1 bg-slate-900/80 border border-violet-500/40 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-400 font-mono tracking-widest"
        />
        <Button
          onClick={handleAdd}
          disabled={!ticker.trim() || isAdding}
          size="sm"
          className="bg-violet-600 hover:bg-violet-700 text-white gap-1.5 px-4 font-bold"
        >
          {isAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {isAdding ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
  );
}

export default function SecWatchList({
  intents = [],
  onSecConfirm,
  onSecWatch,
  onApprove,
  onReject,
  onScanSec,
  onScanAll,
  onRunChecklist,
  onToggleManual,
  onAddManualWatch,
  onRemoveManualWatch,
  isAddingManualWatch = false,
  onScanSpikes,
  isScanningSpikes = false,
  tradingviewChartId
}) {
  const confirmed = intents.filter(i => i.sec_confirmed);
  const waiting = intents.filter(i => !i.sec_confirmed);
  const manualOnly = intents.filter(i => i.is_manual);

  if (intents.length === 0) {
    return (
      <div className="space-y-4">
        <AddTickerInput onAdd={onAddManualWatch} isAdding={isAddingManualWatch} />
        <SecScannerTest />
        <Button
          onClick={onScanSpikes}
          disabled={isScanningSpikes}
          size="sm"
          variant="outline"
          className="w-full border-amber-600/40 text-amber-400 hover:bg-amber-600/10 gap-2"
          title="Scan market for 40%+ movers with vol >50× and auto-add to watch panel"
        >
          {isScanningSpikes
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Zap className="w-3.5 h-3.5" />}
          Scan for Spikes
        </Button>
        <div className="text-center py-8 text-slate-500 space-y-2">
          <BookMarked className="w-10 h-10 mx-auto opacity-30" />
          <p className="font-medium">No cards in SEC watch list</p>
          <p className="text-xs text-slate-600">Add a ticker above, or use "Add to SEC Watch" on any WALL card.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Add ticker + Test panel + Scan All */}
      <div className="space-y-2">
        <AddTickerInput onAdd={onAddManualWatch} isAdding={isAddingManualWatch} />
        <SecScannerTest />
        <Button
          onClick={onScanSpikes}
          disabled={isScanningSpikes}
          size="sm"
          variant="outline"
          className="w-full border-amber-600/40 text-amber-400 hover:bg-amber-600/10 gap-2"
          title="Scan market for 40%+ movers with vol >50× and auto-add to watch panel"
        >
          {isScanningSpikes
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Zap className="w-3.5 h-3.5" />}
          Scan for Spikes
        </Button>
        {waiting.length > 0 && (
          <Button
            onClick={onScanAll}
            size="sm"
            variant="outline"
            className="w-full border-slate-600/50 text-slate-300 hover:bg-slate-700/50 gap-2"
            title="Run SEC scanner against all waiting tickers now"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Scan All Waiting ({waiting.length})
          </Button>
        )}
      </div>

      {/* Manual watchlist section — tickers added without a WALL card */}
      {manualOnly.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Eye className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-semibold text-violet-400">Watchlist Only ({manualOnly.length})</span>
          </div>
          {manualOnly.map(intent => (
            <SecWatchRow
              key={intent.id}
              intent={intent}
              onSecConfirm={onSecConfirm}
              onSecWatch={onSecWatch}
              onApprove={onApprove}
              onReject={onReject}
              onScanSec={onScanSec}
              onRunChecklist={onRunChecklist}
              onToggleManual={onToggleManual}
              onRemoveManualWatch={onRemoveManualWatch}
              tradingviewChartId={tradingviewChartId}
            />
          ))}
        </div>
      )}

      {/* Waiting section — WALL cards pending SEC filing */}
      {waiting.filter(i => !i.is_manual).length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <BookMarked className="w-4 h-4 text-yellow-400" />
            <span title="55% buffer invalidated" className="text-sm font-semibold text-yellow-400 cursor-help">Waiting for SEC Filing ({waiting.filter(i => !i.is_manual).length})</span>
          </div>
          {waiting.filter(i => !i.is_manual).map(intent => (
            <SecWatchRow
              key={intent.id}
              intent={intent}
              onSecConfirm={onSecConfirm}
              onSecWatch={onSecWatch}
              onApprove={onApprove}
              onReject={onReject}
              onScanSec={onScanSec}
              onRunChecklist={onRunChecklist}
              onToggleManual={onToggleManual}
              tradingviewChartId={tradingviewChartId}
            />
          ))}
        </div>
      )}

      {/* Confirmed section */}
      {confirmed.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <BadgeCheck className="w-4 h-4 text-cyan-400" />
            <span title="55% buffer invalidated" className="text-sm font-semibold text-cyan-400 cursor-help">SEC Filing Confirmed ({confirmed.length})</span>
          </div>
          {confirmed.map(intent => (
            <SecWatchRow
              key={intent.id}
              intent={intent}
              onSecConfirm={onSecConfirm}
              onSecWatch={onSecWatch}
              onApprove={onApprove}
              onReject={onReject}
              onScanSec={onScanSec}
              onRunChecklist={onRunChecklist}
              onToggleManual={onToggleManual}
              tradingviewChartId={tradingviewChartId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SecWatchRow({
  intent,
  onSecConfirm,
  onSecWatch,
  onApprove,
  onReject,
  onScanSec,
  onRunChecklist,
  onToggleManual,
  onRemoveManualWatch,
  tradingviewChartId
}) {
  const isManual = intent.is_manual === true;
  const isLong = intent.dir === "Long";
  const [scanning, setScanning] = useState(false);
  const [runningChecklist, setRunningChecklist] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(true);

  const scanHistory = React.useMemo(() => {
    try { return intent.sec_scan_history ? JSON.parse(intent.sec_scan_history) : []; }
    catch { return []; }
  }, [intent.sec_scan_history]);

  const checklist = React.useMemo(() => {
    try { return intent.sec_checklist ? JSON.parse(intent.sec_checklist) : null; }
    catch { return null; }
  }, [intent.sec_checklist]);

  const filings = React.useMemo(() => {
    try { return intent.sec_filings ? JSON.parse(intent.sec_filings) : []; }
    catch { return []; }
  }, [intent.sec_filings]);

  async function handleScanNow() {
    setScanning(true);
    try { await onScanSec?.(intent); }
    finally { setScanning(false); }
  }

  async function handleRunChecklist() {
    setRunningChecklist(true);
    try { await onRunChecklist?.(intent); }
    finally { setRunningChecklist(false); }
  }

  return (
    <div className={cn(
      "relative border rounded-xl p-4 transition-colors",
      intent.sec_confirmed
        ? "bg-cyan-950/30 border-cyan-500/40 hover:bg-cyan-950/40"
        : isManual
        ? "bg-violet-950/20 border-violet-500/30 hover:bg-violet-950/30"
        : "bg-slate-800/50 border-yellow-500/30 hover:bg-slate-800/70"
    )}>
      {/* Confirmed banner */}
      {intent.sec_confirmed && (
        <div className="flex items-center gap-1.5 bg-cyan-500/15 border border-cyan-500/30 rounded-lg px-3 py-1.5 mb-3">
          <BadgeCheck className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-bold text-cyan-300 uppercase tracking-wide">SEC Confirmed</span>
          {filings.length > 0 && (
            <span className="ml-auto text-[10px] text-cyan-500">{filings.length} filing{filings.length > 1 ? 's' : ''} found</span>
          )}
        </div>
      )}

      {/* Top row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xl font-bold text-white">{intent.ticker}</span>
          {isManual ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-violet-500/20 text-violet-400 border border-violet-500/40">
              <Eye className="w-3 h-3" />
              WATCH ONLY
            </span>
          ) : (
            <span className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
              isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
            )}>
              {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {intent.dir?.toUpperCase()}
            </span>
          )}
          {intent.sec_confirmed ? (
            <span title="55% buffer invalidated" className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 cursor-help">
              <BadgeCheck className="w-3 h-3" />
              SEC CONFIRMED
            </span>
          ) : !isManual && (
            <span title="55% buffer invalidated" className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 cursor-help">
              <BookMarked className="w-3 h-3" />
              WATCHING
            </span>
          )}
          {intent.sec_bias && <BiasBadge bias={intent.sec_bias} size="sm" />}
        </div>
        <div className="flex items-center gap-2">
          {isManual && (
            <button
              onClick={() => onRemoveManualWatch?.(intent)}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-400 transition-colors"
              title="Remove from watchlist"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <a
            href={getSecUrl(intent.ticker)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <FileText className="w-3 h-3" />
            EDGAR
          </a>
          <button
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-blue-400 transition-colors"
            onClick={() => {
              const chartPath = tradingviewChartId ? `chart/${tradingviewChartId}/` : 'chart/';
              window.open(`https://www.tradingview.com/${chartPath}?symbol=${intent.ticker}`, '_blank', 'noopener,noreferrer');
            }}
          >
            Chart <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Filing links (confirmed only) */}
      {intent.sec_confirmed && filings.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {filings.map((f, i) => (
            <a
              key={i}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1 bg-cyan-500/10 border border-cyan-500/30 rounded text-[11px] text-cyan-400 hover:bg-cyan-500/20 transition-colors"
            >
              <FileText className="w-3 h-3" />
              {f.form} — {f.date}
            </a>
          ))}
        </div>
      )}

      {/* Price — only for WALL cards with real prices */}
      {!isManual && (
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          <div>
            <p className="text-slate-500 uppercase mb-0.5">Limit</p>
            <p className="font-mono font-bold text-white">${intent.limit_price ? Number(intent.limit_price).toFixed(2) : '—'}</p>
          </div>
          <div>
            <p className="text-slate-500 uppercase mb-0.5">Market</p>
            <p className="font-mono font-bold text-slate-400">${intent.price ? Number(intent.price).toFixed(2) : '—'}</p>
          </div>
        </div>
      )}

      {/* Scan history tokens */}
      {scanHistory.length > 0 && (
        <div className="mb-3">
          <ScanHistoryTokens history={scanHistory} />
        </div>
      )}

      {/* Checklist section */}
      <div className="mb-3">
        <button
          onClick={() => setChecklistOpen(o => !o)}
          className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 transition-colors w-full"
        >
          {checklistOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {checklist ? `SEC Checklist · ${checklist.completion_pct}% complete` : 'SEC Checklist — not run yet'}
          {!checklist && (
            <button
              onClick={(e) => { e.stopPropagation(); handleRunChecklist(); }}
              disabled={runningChecklist}
              className="ml-auto text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              {runningChecklist ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Run now
            </button>
          )}
        </button>

        {checklistOpen && checklist && (
          <ChecklistPanel
            checklist={checklist}
            intent={intent}
            onRunChecklist={handleRunChecklist}
            onToggleManual={onToggleManual}
            runningChecklist={runningChecklist}
          />
        )}
      </div>

      {/* Actions — manual entries only get a refresh checklist button */}
      {isManual ? (
        <div className="flex gap-2 mt-1">
          <Button
            onClick={handleRunChecklist}
            disabled={runningChecklist}
            variant="outline"
            size="sm"
            className="border-violet-500/40 text-violet-400 hover:bg-violet-500/15 gap-1.5"
          >
            {runningChecklist ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh scorecard
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {!intent.sec_confirmed && (
            <div className="flex gap-2">
              <Button
                onClick={handleScanNow}
                disabled={scanning}
                variant="outline"
                size="sm"
                className="border-slate-600/50 text-slate-400 hover:bg-slate-700/50 px-2"
                title="Run SEC scanner now for this ticker"
              >
                {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </Button>
              <Button
                onClick={() => onSecWatch?.(intent, 'unwatch')}
                variant="outline"
                size="sm"
                className="flex-1 border-slate-500/50 text-slate-400 hover:bg-slate-500/20"
              >
                Remove Watch
              </Button>
              <Button
                onClick={() => onSecConfirm?.(intent, 'confirm')}
                size="sm"
                className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white"
              >
                <BadgeCheck className="w-3 h-3 mr-1" />
                SEC Confirm
              </Button>
            </div>
          )}
          {intent.sec_confirmed && (
            <div className="flex gap-2">
              <Button
                onClick={() => onSecConfirm?.(intent, 'unconfirm')}
                variant="outline"
                size="sm"
                className="border-slate-500/50 text-slate-400 hover:bg-slate-500/20 px-3"
              >
                Undo
              </Button>
              <Button
                onClick={() => onReject?.(intent)}
                variant="outline"
                size="sm"
                className="border-red-500/50 text-red-400 hover:bg-red-500/20 px-3"
              >
                OFF
              </Button>
              <Button
                onClick={() => onApprove?.(intent)}
                size="sm"
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold"
              >
                Approve Trade
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
