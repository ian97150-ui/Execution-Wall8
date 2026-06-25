import React, { useState } from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { Inbox, RefreshCw, Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import TradeCard from "./TradeCard";

export default function SwipeDeck({
  intents = [],
  executions = [],
  onSwipeOn,
  onSwipeOff,
  onDeny,
  onBlockAlerts,
  onUnblockAlerts,
  onSecWatch,
  onSecConfirm,
  isBlockingAlerts = false,
  onRefresh,
  isLoading = false,
  tickers = [],
  tradingviewChartId,
  defaultWatchMinutes,
  onCreateDemo,
  isDemoLoading = false
}) {
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Keep focusedIndex in bounds if intents shrink
  const safeIndex = Math.min(focusedIndex, Math.max(0, intents.length - 1));

  // Rotate the array so the focused card is first, then show up to 3
  const rotated = [...intents.slice(safeIndex), ...intents.slice(0, safeIndex)];
  const visibleCards = rotated.slice(0, 3);

  if (intents.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8">
        <div className="w-20 h-20 rounded-2xl bg-slate-800/50 flex items-center justify-center mb-4">
          <Inbox className="w-10 h-10 text-slate-600" />
        </div>
        <h3 className="text-lg font-semibold text-slate-400 mb-2">No Trade Candidates</h3>
        <p className="text-sm text-slate-500 mb-4 max-w-xs">
          Waiting for signals from TradingView that meet your gate threshold
        </p>
        <div className="flex gap-2">
          <Button
            onClick={onRefresh}
            variant="outline"
            size="sm"
            disabled={isLoading}
            className="border-slate-700 text-slate-400"
          >
            <RefreshCw className={cn("w-4 h-4 mr-2", isLoading && "animate-spin")} />
            Refresh
          </Button>
          {onCreateDemo && (
            <Button
              onClick={onCreateDemo}
              variant="outline"
              size="sm"
              disabled={isDemoLoading}
              className="border-amber-500/50 text-amber-400 hover:bg-amber-500/20"
            >
              <Sparkles className={cn("w-4 h-4 mr-2", isDemoLoading && "animate-pulse")} />
              Demo Card
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* Counter badge with prev/next navigation */}
      <div className="flex justify-center pt-1 pb-1 shrink-0">
        <div className="flex items-center gap-1 bg-slate-800/80 backdrop-blur-sm pl-1 pr-1 py-1 rounded-full border border-slate-700/50">
          <button
            onClick={() => setFocusedIndex(i => (i - 1 + intents.length) % intents.length)}
            disabled={intents.length <= 1}
            className="w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-sm font-medium text-slate-300 px-2 select-none">
            {safeIndex + 1} / {intents.length} in queue
          </span>
          <button
            onClick={() => setFocusedIndex(i => (i + 1) % intents.length)}
            disabled={intents.length <= 1}
            className="w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Card stack */}
      <div className="relative flex-1">
        <div className="absolute inset-0 flex items-start justify-center pt-2 sm:pt-4">
          <div className="relative w-full max-w-[95vw] sm:max-w-sm h-full">
            <AnimatePresence mode="popLayout">
              {visibleCards.map((intent, index) => {
                const tickerConfig = tickers.find(t => t.ticker === intent.ticker);
                const isEnabled = tickerConfig?.enabled || false;
                const isBlocked = tickerConfig?.alerts_blocked === true;
                const dayPeakMove = tickerConfig?.day_peak_move ?? null;

                return (
                  <TradeCard
                    key={intent.id}
                    intent={intent}
                    hasLiveOrder={executions.some(e =>
                      e.ticker === intent.ticker &&
                      ['pending', 'executing'].includes(e.status)
                    )}
                    isTopCard={index === 0}
                    onSwipeOn={onSwipeOn}
                    onSwipeOff={onSwipeOff}
                    onDeny={onDeny}
                    onBlockAlerts={onBlockAlerts}
                    onUnblockAlerts={onUnblockAlerts}
                    onSecWatch={onSecWatch}
                    onSecConfirm={onSecConfirm}
                    isBlockingAlerts={isBlockingAlerts}
                    isBlocked={isBlocked}
                    isEnabled={isEnabled}
                    dayPeakMove={dayPeakMove}
                    tradingviewChartId={tradingviewChartId}
                    defaultWatchMinutes={defaultWatchMinutes}
                    style={{
                      scale: 1 - index * 0.05,
                      y: index * 10,
                      zIndex: visibleCards.length - index,
                    }}
                  />
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}