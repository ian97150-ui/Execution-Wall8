import React from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { Switch } from "@/components/ui/switch";
import { TrendingUp, TrendingDown, Clock, BarChart3, ArrowUpDown } from "lucide-react";

export default function TickerList({ 
  tickers = [], 
  onToggle,
  sortBy = "last_intent",
  onSortChange
}) {
  const sortOptions = [
    { value: "last_intent", label: "Recent" },
    { value: "ticker", label: "A-Z" },
    { value: "executions", label: "Executions" }
  ];

  return (
    <div className="space-y-4">
      {/* Header with sort */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
          Ticker Controls
        </h3>
        <div className="flex items-center gap-2">
          <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" />
          <select 
            value={sortBy}
            onChange={(e) => onSortChange?.(e.target.value)}
            className="bg-slate-800 border-none text-xs text-slate-400 rounded-lg px-2 py-1 focus:ring-1 focus:ring-blue-500"
          >
            {sortOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Ticker list */}
      <div className="space-y-2">
        <AnimatePresence>
          {tickers.map((ticker, index) => (
            <motion.div
              key={ticker.ticker}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -100 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                "flex items-center justify-between p-4 rounded-xl",
                "bg-slate-800/50 border border-slate-700/50",
                !ticker.enabled && "opacity-60"
              )}
            >
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm",
                  ticker.enabled 
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-slate-700/50 text-slate-500"
                )}>
                  {ticker.ticker?.slice(0, 2)}
                </div>
                <div>
                  <p className="font-semibold text-white">{ticker.ticker}</p>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <BarChart3 className="w-3 h-3" />
                      {ticker.total_executions || 0} exec
                    </span>
                    {ticker.last_intent_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(ticker.last_intent_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {/* Limit override indicator */}
                {ticker.limit_price_override && (
                  <div className="px-2 py-1 rounded bg-amber-500/20 text-amber-400 text-xs font-medium">
                    Override Active
                  </div>
                )}
                
                <Switch
                  checked={ticker.enabled}
                  onCheckedChange={(checked) => onToggle?.(ticker.ticker, checked)}
                  className="data-[state=checked]:bg-emerald-500"
                />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {tickers.length === 0 && (
        <div className="text-center py-8 text-slate-500">
          <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No tickers configured yet</p>
        </div>
      )}
    </div>
  );
}