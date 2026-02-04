import React from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { Inbox, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import TradeCard from "./TradeCard";

export default function SwipeDeck({
  intents = [],
  executions = [],
  onSwipeOn,
  onSwipeOff,
  onDeny,
  onRefresh,
  isLoading = false,
  tickers = [],
  tradingviewChartId,
  onCreateDemo,
  isDemoLoading = false
}) {
  // Show up to 3 cards stacked
  const visibleCards = intents.slice(0, 3);

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
    <div className="relative h-full w-full">
      {/* Card stack */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative w-full max-w-[95vw] sm:max-w-sm h-[calc(100vh-280px)] sm:h-[600px] md:h-[680px]">
          <AnimatePresence mode="popLayout">
            {visibleCards.map((intent, index) => {
              const tickerConfig = tickers.find(t => t.ticker === intent.ticker);
              const isEnabled = tickerConfig?.enabled || false;
              
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
                  isEnabled={isEnabled}
                  tradingviewChartId={tradingviewChartId}
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

      {/* Counter badge */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
        <div className="bg-slate-800/80 backdrop-blur-sm px-4 py-2 rounded-full border border-slate-700/50">
          <span className="text-sm font-medium text-slate-300">
            {intents.length} candidate{intents.length !== 1 ? 's' : ''} in queue
          </span>
        </div>
      </div>
    </div>
  );
}