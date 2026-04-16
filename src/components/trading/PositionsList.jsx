import React from 'react';
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, ShieldOff, Shield, Flag, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";

export default function PositionsList({
  positions = [],
  onBlockSignals,
  onUnblockSignals,
  onMarkFlat,
  onSetTTP,
  onClearTTP,
  tickers = []
}) {
  const [cooldownTimers, setCooldownTimers] = React.useState({});
  const [ttpInputOpen, setTtpInputOpen] = React.useState({});
  const [ttpInputValue, setTtpInputValue] = React.useState({});

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
    return Math.max(0, Math.floor((endTime - Date.now()) / 1000));
  };

  const handleSetTTP = (position) => {
    const val = parseFloat(ttpInputValue[position.id]);
    if (!isNaN(val) && val > 0) {
      onSetTTP?.(position, val);
      setTtpInputOpen(prev => ({ ...prev, [position.id]: false }));
      setTtpInputValue(prev => ({ ...prev, [position.id]: '' }));
    }
  };

  const closeTtpInput = (id) => {
    setTtpInputOpen(prev => ({ ...prev, [id]: false }));
    setTtpInputValue(prev => ({ ...prev, [id]: '' }));
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
          const hasTTP = position.ttp_exit_price != null;
          const isTtpInputOpen = !!ttpInputOpen[position.id];

          return (
            <motion.div
              key={position.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -100 }}
              className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 hover:bg-slate-800/70 transition-colors"
            >
              {/* Header */}
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

              {/* Position stats */}
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

              {/* TTP Exit SL status */}
              {hasTTP && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">
                    <Target className="w-3 h-3" />
                    TTP ${Number(position.ttp_exit_price).toFixed(2)} — SL Active
                  </span>
                  <button
                    onClick={() => onClearTTP?.(position)}
                    className="text-[10px] text-slate-500 hover:text-red-400 transition-colors flex items-center gap-0.5"
                  >
                    <X className="w-3 h-3" /> Clear
                  </button>
                </div>
              )}

              {/* TTP inline price input */}
              {isTtpInputOpen && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-slate-400">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="w-24 bg-slate-800 border border-amber-500/40 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-amber-400"
                    value={ttpInputValue[position.id] || ''}
                    onChange={e => setTtpInputValue(prev => ({ ...prev, [position.id]: e.target.value }))}
                    placeholder="0.00"
                    autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') handleSetTTP(position); if (e.key === 'Escape') closeTtpInput(position.id); }}
                  />
                  <button
                    onClick={() => handleSetTTP(position)}
                    className="text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors"
                  >
                    Set
                  </button>
                  <button
                    onClick={() => closeTtpInput(position.id)}
                    className="text-xs text-slate-500 hover:text-slate-400 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Action buttons */}
              <div className="space-y-2">
                {/* Flatten */}
                <Button
                  onClick={() => handleMarkFlat(position)}
                  variant="outline"
                  size="sm"
                  disabled={cooldownRemaining > 0}
                  className={cn(
                    "w-full border-blue-500/50 text-blue-400 hover:bg-blue-500/20 transition-all",
                    cooldownRemaining > 0 && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Flag className="w-4 h-4 mr-1" />
                  {cooldownRemaining > 0 ? `Flatten (${cooldownRemaining}s)` : 'Flatten'}
                </Button>

                {/* TTP Exit SL button — only shown when TTP not already set and input not open */}
                {!hasTTP && !isTtpInputOpen && (
                  <Button
                    onClick={() => setTtpInputOpen(prev => ({ ...prev, [position.id]: true }))}
                    variant="outline"
                    size="sm"
                    className="w-full border-amber-500/40 text-amber-400 hover:bg-amber-500/15 transition-all"
                  >
                    <Target className="w-4 h-4 mr-1" />
                    Set TTP Exit SL
                  </Button>
                )}

                {/* Block / Unblock signals */}
                <Button
                  onClick={() => isBlocked ? onUnblockSignals?.(position) : onBlockSignals?.(position)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "w-full transition-all duration-300",
                    isBlocked
                      ? "border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
                      : "border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                  )}
                >
                  {isBlocked ? (
                    <>
                      <Shield className="w-4 h-4 mr-1" />
                      Unblock Signals
                    </>
                  ) : (
                    <>
                      <ShieldOff className="w-4 h-4 mr-1" />
                      Block Signals
                    </>
                  )}
                </Button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
