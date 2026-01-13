import React from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Bell, Power, PowerOff, Edit3, Clock, Check, X, 
  Send, AlertTriangle, Settings, TrendingUp, TrendingDown,
  ShieldOff, ShieldCheck, Zap
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

const eventConfig = {
  intent_received: { icon: Bell, color: "text-blue-400", bg: "bg-blue-500/20" },
  execution_received: { icon: Send, color: "text-purple-400", bg: "bg-purple-500/20" },
  swipe_on: { icon: Power, color: "text-emerald-400", bg: "bg-emerald-500/20" },
  swipe_off: { icon: PowerOff, color: "text-red-400", bg: "bg-red-500/20" },
  limit_edit: { icon: Edit3, color: "text-amber-400", bg: "bg-amber-500/20" },
  delay_started: { icon: Clock, color: "text-slate-400", bg: "bg-slate-500/20" },
  delay_completed: { icon: Check, color: "text-emerald-400", bg: "bg-emerald-500/20" },
  invalidated: { icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/20" },
  executed: { icon: Check, color: "text-emerald-400", bg: "bg-emerald-500/20" },
  cancelled: { icon: X, color: "text-red-400", bg: "bg-red-500/20" },
  forwarded: { icon: Send, color: "text-blue-400", bg: "bg-blue-500/20" },
  mode_change: { icon: Settings, color: "text-purple-400", bg: "bg-purple-500/20" },
  ticker_toggle: { icon: Power, color: "text-slate-400", bg: "bg-slate-500/20" }
};

export default function AuditTimeline({ logs = [], showFilters = true }) {
  const [filter, setFilter] = React.useState("all");

  const filters = [
    { value: "all", label: "All" },
    { value: "execution", label: "Executions" },
    { value: "swipe", label: "Swipes" },
    { value: "edit", label: "Edits" },
  ];

  const filteredLogs = logs.filter(log => {
    if (filter === "all") return true;
    if (filter === "execution") return ["executed", "cancelled", "forwarded", "invalidated"].includes(log.event_type);
    if (filter === "swipe") return ["swipe_on", "swipe_off"].includes(log.event_type);
    if (filter === "edit") return log.event_type === "limit_edit";
    return true;
  });

  const formatEventTitle = (log) => {
    const titles = {
      intent_received: `Intent: ${log.ticker}`,
      execution_received: `Execution request: ${log.ticker}`,
      swipe_on: `Enabled ${log.ticker}`,
      swipe_off: `Disabled ${log.ticker}`,
      limit_edit: `Limit adjusted: ${log.ticker}`,
      delay_started: `Delay started: ${log.ticker}`,
      delay_completed: `Delay complete: ${log.ticker}`,
      invalidated: `Invalidated: ${log.ticker}`,
      executed: `Executed: ${log.ticker}`,
      cancelled: `Cancelled: ${log.ticker}`,
      forwarded: `Forwarded: ${log.ticker}`,
      mode_change: `Mode changed`,
      ticker_toggle: `Ticker toggled: ${log.ticker}`
    };
    return titles[log.event_type] || log.event_type;
  };

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      {showFilters && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all",
                filter === f.value 
                  ? "bg-blue-500/20 text-blue-400"
                  : "bg-slate-800/50 text-slate-500 hover:text-slate-300"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-5 top-0 bottom-0 w-px bg-slate-700/50" />

        <AnimatePresence>
          {filteredLogs.map((log, index) => {
            const config = eventConfig[log.event_type] || { icon: Bell, color: "text-slate-400", bg: "bg-slate-500/20" };
            const Icon = config.icon;
            const isLong = log.side === "long" || log.side === "exit_short";
            const isExit = log.side?.startsWith("exit_");

            return (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ delay: index * 0.03 }}
                className="relative pl-12 pb-6"
              >
                {/* Icon circle */}
                <div className={cn(
                  "absolute left-2 w-6 h-6 rounded-full flex items-center justify-center",
                  config.bg
                )}>
                  <Icon className={cn("w-3.5 h-3.5", config.color)} />
                </div>

                {/* Content */}
                <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/30">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <p className="font-medium text-white truncate">
                          {formatEventTitle(log)}
                        </p>
                        {log.side && (
                          <span className={cn(
                            "shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium",
                            isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400",
                            isExit && "border border-current"
                          )}>
                            {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {isExit ? log.side.replace("exit_", "EXIT ").toUpperCase() : log.side}
                          </span>
                        )}
                        {log.execution_mode && ["executed", "forwarded", "execution_received", "delay_started", "delay_completed"].includes(log.event_type) && (
                          <span className={cn(
                            "shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-bold uppercase",
                            log.execution_mode === "off" && "bg-red-500/20 text-red-400",
                            log.execution_mode === "safe" && "bg-amber-500/20 text-amber-400",
                            log.execution_mode === "full" && "bg-emerald-500/20 text-emerald-400"
                          )}>
                            {log.execution_mode === "off" && <ShieldOff className="w-3 h-3" />}
                            {log.execution_mode === "safe" && <ShieldCheck className="w-3 h-3" />}
                            {log.execution_mode === "full" && <Zap className="w-3 h-3" />}
                            {log.execution_mode}
                          </span>
                        )}
                      </div>

                      {/* Details */}
                      {log.details && (
                        <div className="text-xs text-slate-500 space-y-1">
                          {log.event_type === "limit_edit" && log.details.original_price && (
                            <p>
                              ${log.details.original_price} → ${log.details.new_price}
                              <span className="text-amber-400 ml-2">
                                ({log.details.change_percent > 0 ? '+' : ''}{log.details.change_percent?.toFixed(2)}%)
                              </span>
                            </p>
                          )}
                          {log.event_type === "mode_change" && (
                            <p>
                              {log.previous_value} → <span className="text-white">{log.new_value}</span>
                            </p>
                          )}
                          {log.details.reason && (
                            <p className="text-slate-400">{log.details.reason}</p>
                          )}
                        </div>
                      )}
                    </div>

                    <span className="text-xs text-slate-500 whitespace-nowrap">
                      {formatDistanceToNow(new Date(log.created_date), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {filteredLogs.length === 0 && (
          <div className="text-center py-8 text-slate-500">
            <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No audit events yet</p>
          </div>
        )}
      </div>
    </div>
  );
}