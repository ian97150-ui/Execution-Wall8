import React from 'react';
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, ShieldOff, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";

export default function PositionsList({ 
  positions = [], 
  onBlockSignals,
  onMarkFlat,
  tickers = []
}) {
  const [cooldownTimers, setCooldownTimers] = React.useState({});

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCooldownTimers(prev => {
        const updated = {};
        for (const [key, endTime] of Object.entries(prev)) {
          if (endTime > Date.now()) {
            updated[key] = endTime;
          }
        }
        return updated;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleMarkFlat = (position) => {
    const key = `${position.ticker}_${position.side}`;
    setCooldownTimers(prev => ({
      ...prev,
      [key]: Date.now() + 300000 // 5 minutes
    }));
    onMarkFlat?.(position);
  };

  const getCooldownRemaining = (position) => {
    const key = `${position.ticker}_${position.side}`;
    const endTime = cooldownTimers[key];
    if (!endTime) return 0;
    const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
    return remaining;
  };
  if (positions.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">No open positions</p>
        <p className="text-xs mt-1">Executed trades will appear here</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AnimatePresence>
        {positions.map((position) => {
          const isLong = position.side === "long";
          const cooldownRemaining = getCooldownRemaining(position);
          const tickerConfig = tickers.find(t => t.ticker === position.ticker);
          const isBlocked = tickerConfig?.enabled === false;

          return (
            <motion.div
              key={position.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -100 }}
              className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 hover:bg-slate-800/70 transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-xl font-bold text-white">{position.ticker}</span>
                  <span className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                    isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                  )}>
                    {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {position.side.toUpperCase()}
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  {format(new Date(position.created_date), "MMM d, HH:mm")}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <p className="text-xs text-slate-500 uppercase mb-1">Quantity</p>
                  <p className="font-mono font-bold text-white text-sm">{position.quantity}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase mb-1">Avg Entry</p>
                  <p className="font-mono font-bold text-white text-sm">
                    ${position.avg_entry_price ? Number(position.avg_entry_price).toFixed(2) : '—'}
                  </p>
                </div>
              </div>

              {position.notes && (
                <div className="mb-3 p-2 rounded-lg bg-slate-700/30">
                  <p className="text-xs text-slate-400">{position.notes}</p>
                </div>
              )}

              <div className="space-y-2">
                <Button
                  onClick={() => handleMarkFlat(position)}
                  variant="outline"
                  size="sm"
                  disabled={cooldownRemaining > 0}
                  className={cn(
                    "w-full border-blue-500/50 text-blue-400 hover:bg-blue-500/20 transition-all",
                    cooldownRemaining > 0 && "opacity-50 cursor-not-allowed animate-pulse"
                  )}
                >
                  <Flag className="w-4 h-4 mr-1" />
                  {cooldownRemaining > 0 ? `${cooldownRemaining}s` : 'Mark Flat (5min cooldown)'}
                </Button>
                <Button
                  onClick={() => onBlockSignals?.(position)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "w-full transition-all duration-300",
                    isBlocked 
                      ? "border-slate-600 bg-slate-700/50 text-slate-400 opacity-60" 
                      : "border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                  )}
                >
                  <ShieldOff className="w-4 h-4 mr-1" />
                  Block Signals (until 1am)
                </Button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}