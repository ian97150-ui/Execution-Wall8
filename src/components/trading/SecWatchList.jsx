import React from 'react';
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, BookMarked, BadgeCheck, FileText, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import QualityBadge from "./QualityBadge";

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
  tradingviewChartId
}) {
  if (intents.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500 space-y-2">
        <BookMarked className="w-10 h-10 mx-auto opacity-30" />
        <p className="font-medium">No cards in SEC watch list</p>
        <p className="text-xs text-slate-600">Add cards from the Swipe or Review All view using the "Add to SEC Watch" button.</p>
      </div>
    );
  }

  const confirmed = intents.filter(i => i.sec_confirmed);
  const waiting = intents.filter(i => !i.sec_confirmed);

  return (
    <div className="space-y-6">
      {/* Waiting section */}
      {waiting.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <BookMarked className="w-4 h-4 text-yellow-400" />
            <span className="text-sm font-semibold text-yellow-400">Waiting for SEC Filing ({waiting.length})</span>
          </div>
          {waiting.map(intent => (
            <SecWatchRow
              key={intent.id}
              intent={intent}
              onSecConfirm={onSecConfirm}
              onSecWatch={onSecWatch}
              onApprove={onApprove}
              onReject={onReject}
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
            <span className="text-sm font-semibold text-cyan-400">SEC Filing Confirmed ({confirmed.length})</span>
          </div>
          {confirmed.map(intent => (
            <SecWatchRow
              key={intent.id}
              intent={intent}
              onSecConfirm={onSecConfirm}
              onSecWatch={onSecWatch}
              onApprove={onApprove}
              onReject={onReject}
              tradingviewChartId={tradingviewChartId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SecWatchRow({ intent, onSecConfirm, onSecWatch, onApprove, onReject, tradingviewChartId }) {
  const isLong = intent.dir === "Long";

  return (
    <div className={cn(
      "relative bg-slate-800/50 border rounded-xl p-4 transition-colors hover:bg-slate-800/70",
      intent.sec_confirmed ? "border-cyan-500/30" : "border-yellow-500/30"
    )}>
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
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/40">
              <BadgeCheck className="w-3 h-3" />
              SEC ✓
            </span>
          ) : (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">
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

      {/* Actions */}
      <div className="space-y-2">
        {!intent.sec_confirmed && (
          <div className="flex gap-2">
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
              Mark SEC Confirmed
            </Button>
          </div>
        )}
        {intent.sec_confirmed && (
          <div className="flex gap-2">
            <Button
              onClick={() => onSecConfirm?.(intent, 'unconfirm')}
              variant="outline"
              size="sm"
              className="flex-1 border-slate-500/50 text-slate-400 hover:bg-slate-500/20"
            >
              Undo Confirm
            </Button>
            <Button
              onClick={() => onApprove?.(intent)}
              size="sm"
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white"
            >
              Approve Trade
            </Button>
          </div>
        )}
        {intent.sec_watch && !intent.sec_confirmed && (
          <div className="flex gap-2">
            <Button
              onClick={() => onReject?.(intent)}
              variant="outline"
              size="sm"
              className="flex-1 border-red-500/50 text-red-400 hover:bg-red-500/20"
            >
              OFF
            </Button>
            <Button
              onClick={() => onApprove?.(intent)}
              size="sm"
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white"
            >
              ON
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
