import React from 'react';
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import QualityBadge from "./QualityBadge";
import GateProgress from "./GateProgress";

export default function CandidatesList({
  candidates = [],
  onApprove,
  onReject,
  onDeny,
  tickers = [],
  tradingviewChartId
}) {
  if (candidates.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <p className="font-medium">No candidates available</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {candidates.map((intent) => {
        const isLong = intent.dir === "Long";
        const sideLabel = intent.dir?.toUpperCase();
        const tickerConfig = tickers.find(t => t.ticker === intent.ticker);
        const isEnabled = tickerConfig?.enabled || false;

        return (
          <div key={intent.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 hover:bg-slate-800/70 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="text-xl font-bold text-white">{intent.ticker}</span>
                <span className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                  isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                )}>
                  {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {sideLabel}
                </span>
                {isEnabled && (
                  <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-500 text-emerald-950">
                    ON
                  </span>
                )}
                {intent.quality_tier && (
                  <QualityBadge tier={intent.quality_tier} score={intent.quality_score} size="sm" />
                )}
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <p className="text-xs text-slate-500 uppercase mb-1">Limit</p>
                <p className="font-mono font-bold text-white text-sm">
                  ${intent.limit_price ? Number(intent.limit_price).toFixed(2) : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase mb-1">Market</p>
                <p className="font-mono font-bold text-slate-400 text-sm">
                  ${intent.price ? Number(intent.price).toFixed(2) : '—'}
                </p>
              </div>
            </div>

            <div className="mb-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Quality Score</span>
                <span className="font-mono font-bold text-white">{intent.quality_score || 0}/100</span>
              </div>
              {intent.card_state && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">State</span>
                  <span className={cn(
                    "px-2 py-0.5 rounded font-medium",
                    intent.card_state === 'ELIGIBLE' ? "bg-emerald-500/20 text-emerald-400" :
                    intent.card_state === 'ARMED' ? "bg-amber-500/20 text-amber-400" :
                    "bg-slate-500/20 text-slate-400"
                  )}>
                    {intent.card_state}
                  </span>
                </div>
              )}
            </div>

            {intent.primary_blocker && (
              <div className="mb-3 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <p className="text-xs text-amber-400">{intent.primary_blocker}</p>
              </div>
            )}

            <div className="space-y-2">
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
              <div className="flex gap-2">
                <Button
                  onClick={() => onDeny?.(intent)}
                  variant="outline"
                  size="sm"
                  className="flex-1 border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                >
                  Deny Order
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 border-blue-500/50 text-blue-400 hover:bg-blue-500/20"
                  onClick={() => {
                    const chartPath = tradingviewChartId ? `chart/${tradingviewChartId}/` : 'chart/';
                    const symbol = encodeURIComponent(`AMEX:${intent.ticker}`);
                    const webUrl = `https://www.tradingview.com/${chartPath}?symbol=${symbol}`;
                    window.open(webUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  Chart
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}