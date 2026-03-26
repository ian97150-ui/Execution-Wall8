import React, { useState } from 'react';
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, BookMarked, BadgeCheck, FileText, ExternalLink, FlaskConical, CheckCircle2, XCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import QualityBadge from "./QualityBadge";
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
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
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
  );
}

// Visual scan history tokens — one dot per scan attempt
function ScanHistoryTokens({ history }) {
  if (!history || history.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] text-slate-500 mr-0.5">Scans:</span>
      {history.map((entry, i) => {
        const time = new Date(entry.at).toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        const dotColor = entry.error
          ? 'bg-red-500/70 border-red-400/60'
          : entry.found
            ? 'bg-cyan-400 border-cyan-300'
            : 'bg-slate-600 border-slate-500';
        const label = entry.error
          ? `Error at ${time}: ${entry.error}`
          : entry.found
            ? `Found at ${time} — ${entry.filings?.length ?? 1} filing(s)`
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

const getSecUrl = (ticker) => {
  const forms = "10-K%2C10-K405%2C10-KT%2C10-Q%2C8-K%2CF-3%2CF-3ASR%2CF-3DPOS%2CF-3MEF%2CN-2%2CN-2%20POSASR%2CS-1%2CS-11%2CS-11MEF%2CS-1MEF%2CS-3%2CS-3ASR%2CS-3D%2CS-3DPOS%2CS-3MEF%2CSF-3%2C6-K";
  return `https://www.sec.gov/edgar/search/#/dateRange=30d&category=custom&entityName=${ticker}&forms=${forms}`;
};

export default function SecWatchList({
  intents = [],
  onSecConfirm,
  onSecWatch,
  onApprove,
  onReject,
  onScanSec,
  onScanAll,
  tradingviewChartId
}) {
  if (intents.length === 0) {
    return (
      <div className="space-y-4">
        <SecScannerTest />
        <div className="text-center py-12 text-slate-500 space-y-2">
          <BookMarked className="w-10 h-10 mx-auto opacity-30" />
          <p className="font-medium">No cards in SEC watch list</p>
          <p className="text-xs text-slate-600">Add cards from the Swipe or Review All view using the "Add to SEC Watch" button.</p>
        </div>
      </div>
    );
  }

  const confirmed = intents.filter(i => i.sec_confirmed);
  const waiting = intents.filter(i => !i.sec_confirmed);

  return (
    <div className="space-y-6">
      {/* Test panel + Scan All always visible */}
      <div className="space-y-2">
        <SecScannerTest />
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
      </div>

      {/* Waiting section */}
      {waiting.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <BookMarked className="w-4 h-4 text-yellow-400" />
            <span title="55% buffer invalidated" className="text-sm font-semibold text-yellow-400 cursor-help">Waiting for SEC Filing ({waiting.length})</span>
          </div>
          {waiting.map(intent => (
            <SecWatchRow
              key={intent.id}
              intent={intent}
              onSecConfirm={onSecConfirm}
              onSecWatch={onSecWatch}
              onApprove={onApprove}
              onReject={onReject}
              onScanSec={onScanSec}
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
              tradingviewChartId={tradingviewChartId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SecWatchRow({ intent, onSecConfirm, onSecWatch, onApprove, onReject, onScanSec, tradingviewChartId }) {
  const isLong = intent.dir === "Long";
  const [scanning, setScanning] = useState(false);

  const scanHistory = React.useMemo(() => {
    try { return intent.sec_scan_history ? JSON.parse(intent.sec_scan_history) : []; }
    catch { return []; }
  }, [intent.sec_scan_history]);

  // Parse confirmed filings for display
  const filings = React.useMemo(() => {
    try { return intent.sec_filings ? JSON.parse(intent.sec_filings) : []; }
    catch { return []; }
  }, [intent.sec_filings]);

  async function handleScanNow() {
    setScanning(true);
    try { await onScanSec?.(intent); }
    finally { setScanning(false); }
  }

  return (
    <div className={cn(
      "relative border rounded-xl p-4 transition-colors",
      intent.sec_confirmed
        ? "bg-cyan-950/30 border-cyan-500/40 hover:bg-cyan-950/40"
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
          <span className={cn(
            "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
            isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
          )}>
            {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {intent.dir?.toUpperCase()}
          </span>
          {intent.sec_confirmed ? (
            <span title="55% buffer invalidated" className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 cursor-help">
              <BadgeCheck className="w-3 h-3" />
              SEC CONFIRMED
            </span>
          ) : (
            <span title="55% buffer invalidated" className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 cursor-help">
              <BookMarked className="w-3 h-3" />
              WATCHING
            </span>
          )}
          {intent.quality_tier && (
            <QualityBadge tier={intent.quality_tier} score={intent.quality_score} size="sm" />
          )}
        </div>
        <div className="flex items-center gap-2">
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

      {/* Price */}
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

      {/* Scan history tokens */}
      {scanHistory.length > 0 && (
        <div className="mb-3">
          <ScanHistoryTokens history={scanHistory} />
        </div>
      )}

      {/* Actions */}
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
    </div>
  );
}
