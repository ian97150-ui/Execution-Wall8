import React from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendingUp, TrendingDown, RefreshCw, Ban, Clock, ShieldOff, ShieldCheck
} from "lucide-react";
import { Button } from "@/components/ui/button";

import QualityBadge from "./QualityBadge";

export default function BlockedTickersList({
  blockedIntents = [],
  onRevive,
  onBlockWallAlerts,
  onUnblockAlerts,
  onResetAll,
  isLoading = false,
  isBlockingAlerts = false,
  isResetting = false,
  tickers = []
}) {
  // Deduplicate by ticker - keep only the most recent intent per ticker
  const uniqueBlockedIntents = React.useMemo(() => {
    const tickerMap = new Map();

    // Sort by created_date descending so we process newest first
    const sorted = [...blockedIntents].sort((a, b) =>
      new Date(b.created_date || b.created_at) - new Date(a.created_date || a.created_at)
    );

    for (const intent of sorted) {
      if (!tickerMap.has(intent.ticker)) {
        tickerMap.set(intent.ticker, intent);
      }
    }

    return Array.from(tickerMap.values());
  }, [blockedIntents]);

  if (uniqueBlockedIntents.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <Ban className="w-4 h-4 text-red-400" />
          <h3 className="text-sm font-semibold text-slate-400">
            Blocked Tickers ({uniqueBlockedIntents.length})
          </h3>
        </div>
        <Button
          onClick={() => onResetAll?.()}
          size="sm"
          variant="outline"
          className="border-red-500/50 text-red-400 hover:bg-red-500/20"
          disabled={isResetting}
          title="Reset all blocked tickers — re-enables all tickers and clears blocked list"
        >
          <RefreshCw className={cn("w-4 h-4 mr-1", isResetting && "animate-spin")} />
          Reset All
        </Button>
      </div>

      <div className="space-y-2">
        <AnimatePresence mode="popLayout">
          {uniqueBlockedIntents.map((intent) => {
            const isLong = intent.dir === "Long";
            const SideIcon = isLong ? TrendingUp : TrendingDown;
            const tickerConfig = tickers.find(t => t.ticker === intent.ticker);
            const isAlertsBlocked = tickerConfig?.alerts_blocked === true;

            return (
              <motion.div
                key={intent.id}
                layout
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className={cn(
                  "flex items-center justify-between p-3 rounded-xl",
                  "bg-slate-800/50 border border-red-500/20",
                  "hover:border-red-500/40 transition-colors"
                )}
              >
                <div className="flex items-center gap-3">
                  {/* Ticker and Side */}
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-lg">
                      {intent.ticker}
                    </span>
                    <div className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold",
                      isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                    )}>
                      <SideIcon className="w-3 h-3" />
                      {intent.dir}
                    </div>
                  </div>

                  {/* Quality Badge */}
                  <QualityBadge
                    tier={intent.quality_tier || "B"}
                    score={intent.quality_score}
                    size="small"
                  />

                  {/* Alerts blocked badge */}
                  {isAlertsBlocked && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-orange-500/20 text-orange-400">
                      <ShieldOff className="w-3 h-3" />
                      ALERTS BLOCKED
                    </span>
                  )}

                  {/* Block status */}
                  <div className="flex items-center gap-1 text-xs text-slate-500">
                    <Clock className="w-3 h-3" />
                    <span>Blocked until reset</span>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => isAlertsBlocked ? onUnblockAlerts?.(intent.ticker) : onBlockWallAlerts?.(intent.ticker)}
                    size="sm"
                    variant={isAlertsBlocked ? "default" : "outline"}
                    className={cn(
                      isAlertsBlocked
                        ? "bg-orange-500/80 text-white hover:bg-orange-500 border-orange-500"
                        : "border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                    )}
                    disabled={isBlockingAlerts}
                    title={isAlertsBlocked ? "Unblock WALL alerts for this ticker" : "Block all WALL alerts for this ticker until next daily reset"}
                  >
                    {isAlertsBlocked
                      ? <ShieldCheck className={cn("w-4 h-4 mr-1", isBlockingAlerts && "animate-pulse")} />
                      : <ShieldOff className={cn("w-4 h-4 mr-1", isBlockingAlerts && "animate-pulse")} />
                    }
                    {isAlertsBlocked ? "Unblock Alerts" : "Block Alerts"}
                  </Button>
                  <Button
                    onClick={() => onRevive?.(intent)}
                    size="sm"
                    variant="outline"
                    className="border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
                    disabled={isLoading}
                  >
                    <RefreshCw className={cn("w-4 h-4 mr-1", isLoading && "animate-spin")} />
                    Revive
                  </Button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
