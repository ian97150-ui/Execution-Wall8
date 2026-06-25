import React from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  Clock, TrendingUp, TrendingDown, Send, X,
  AlertTriangle, CheckCircle2, Loader2, Edit3, RefreshCw, ThumbsUp, Snowflake, Eye, EyeOff
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import DelayProgress from "./DelayProgress";

export default function ExecutionQueue({
  executions = [],
  onCancel,
  onForceExecute,
  onApprove,
  onEditLimit,
  onRetry,
  onFreeze,
  onStartWatch,
  onStopWatch,
  onCreateDemo,
  isDemoLoading,
  executionMode = "safe"
}) {
  const getStatusBadge = (status) => {
    const config = {
      pending: { label: "Pending", icon: Clock, color: "text-slate-400 bg-slate-500/20" },
      executing: { label: "Executing", icon: Loader2, color: "text-blue-400 bg-blue-500/20", spin: true },
      executed: { label: "Executed", icon: CheckCircle2, color: "text-emerald-400 bg-emerald-500/20" },
      cancelled: { label: "Cancelled", icon: X, color: "text-red-400 bg-red-500/20" },
      invalidated: { label: "Invalidated", icon: AlertTriangle, color: "text-orange-400 bg-orange-500/20" },
      failed: { label: "Failed", icon: AlertTriangle, color: "text-red-400 bg-red-500/20" }
    };
    return config[status] || config.pending;
  };

  const formatPrice = (price) => {
    if (!price || price === undefined || price === null) return "—";
    return Number(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
          Execution Queue
        </h3>
        <span className={cn(
          "px-2 py-1 rounded-lg text-xs font-medium",
          executionMode === "off" ? "bg-red-500/20 text-red-400" :
          executionMode === "safe" ? "bg-amber-500/20 text-amber-400" :
          "bg-emerald-500/20 text-emerald-400"
        )}>
          Mode: {executionMode.toUpperCase()}
        </span>
      </div>

      <AnimatePresence>
        {executions.map((exec, index) => {
          const statusBadge = getStatusBadge(exec.status);
          const StatusIcon = statusBadge.icon;
          const isLong = exec.dir === "Long";
          const sideLabel = exec.dir?.toUpperCase();
          const isActive = ["pending", "executing"].includes(exec.status);
          const isFailed = exec.status === "failed";
          const isFrozen = !!exec.frozen;
          // Freezing only pauses the safe-mode delay timer (executionScheduler.ts
          // only checks `frozen` for status==='pending' rows with a real
          // delay_expires_at). "executing" orders have already been forwarded
          // to the broker immediately (full mode / immediate-exit) with no
          // delay to pause, so showing Freeze there is a no-op that looks broken.
          const isFreezable = exec.status === "pending";
          // Watch Threshold reuses the WALL card's TradeIntent-keyed watch
          // mechanism via exec.intent_id - only possible for executions that
          // trace back to a scored WALL signal (custom/manual orders with no
          // intent_id have no TradeIntent row to attach watch state to).
          const watchUntil  = exec.intent_wait_watch_until ? new Date(exec.intent_wait_watch_until) : null;
          const isWatching  = !!exec.intent_manual_watch && !!watchUntil && new Date() <= watchUntil;
          const watchMinutesLeft = isWatching ? Math.max(0, Math.round((watchUntil - new Date()) / 60000)) : 0;

          // Derive strategy label from grade_snapshot or raw_payload
          let strategyLabel = null;
          try {
            const gs = exec.grade_snapshot ? JSON.parse(exec.grade_snapshot) : null;
            const rp = exec.raw_payload ? JSON.parse(exec.raw_payload) : null;
            const strat = gs?.strategy || rp?.strategy_id?.replace('Strat ', '') || null;
            if (strat) strategyLabel = `Strategy ${strat}`;
          } catch (_) {}


          return (
            <motion.div
              key={exec.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -100 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                "rounded-xl border overflow-hidden",
                isFrozen ? "bg-slate-800/80 border-cyan-500/50" :
                isActive ? "bg-slate-800/80 border-slate-600" : "bg-slate-800/40 border-slate-700/50"
              )}
            >
              {/* Header */}
              <div className="p-4 border-b border-slate-700/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl font-bold text-white">{exec.ticker}</span>
                    {strategyLabel && (
                      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30">
                        {strategyLabel}
                      </span>
                    )}
                    <span className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                    )}>
                      {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {sideLabel}
                    </span>
                    {exec.order_type === 'exit' && (
                      <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-500 text-orange-950">
                        EXIT
                      </span>
                    )}
                    <span className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      statusBadge.color
                    )}>
                      <StatusIcon className={cn("w-3 h-3", statusBadge.spin && "animate-spin")} />
                      {statusBadge.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {(exec.created_at || exec.created_date) && format(new Date(exec.created_at || exec.created_date), "HH:mm:ss")}
                    </span>
                    {isFreezable && (
                      <button
                        onClick={() => onFreeze?.(exec)}
                        title={isFrozen ? "Unfreeze order" : "Freeze order (pause timer)"}
                        className={cn(
                          "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                          isFrozen
                            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 hover:bg-cyan-500/30"
                            : "bg-slate-700/50 text-slate-400 border border-slate-600/40 hover:bg-slate-600/50 hover:text-slate-200"
                        )}
                      >
                        <Snowflake className="w-3 h-3" />
                        {isFrozen ? "Frozen" : "Freeze"}
                      </button>
                    )}
                    {exec.intent_id && isActive && (
                      <button
                        onClick={() => isWatching ? onStopWatch?.(exec) : onStartWatch?.({ exec, minutes: 60 })}
                        title={isWatching ? "Stop watching for entry threshold" : "Watch until entry threshold (60min)"}
                        className={cn(
                          "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                          isWatching
                            ? "bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30"
                            : "bg-slate-700/50 text-slate-400 border border-slate-600/40 hover:bg-slate-600/50 hover:text-slate-200"
                        )}
                      >
                        {isWatching ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        {isWatching ? `Watching · ${watchMinutesLeft}m left` : "Watch Threshold"}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Frozen banner */}
              {isFrozen && (
                <div className="px-4 py-1.5 bg-cyan-500/10 border-b border-cyan-500/20 flex items-center gap-2">
                  <Snowflake className="w-3 h-3 text-cyan-400" />
                  <span className="text-xs text-cyan-400 font-medium">Timer paused — order held until you act</span>
                </div>
              )}

              {/* Details */}
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Quantity</p>
                    <p className="font-mono font-bold text-white">{exec.quantity || 1}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Limit</p>
                    <p className="font-mono font-bold text-white">${formatPrice(exec.limit_price)}</p>
                  </div>
                </div>

                {/* Delay progress for safe mode only */}
                {isActive && executionMode === "safe" && (
                  <DelayProgress
                    intent={exec}
                    status={exec.status === "pending" ? "waiting" : "confirmed"}
                  />
                )}

                {/* Full mode - just shows entry was sent */}
                {isActive && executionMode === "full" && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-center">
                    <p className="text-sm text-emerald-400 font-medium">Order sent immediately to broker</p>
                  </div>
                )}

                {/* Failed state - show retry option */}
                {isFailed && (
                  <div className="space-y-3">
                    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                      <p className="text-xs text-red-400 font-medium mb-1">Execution Failed</p>
                      <p className="text-xs text-red-300">{exec.failure_reason || 'Unable to forward order to broker'}</p>
                      {exec.retry_count > 0 && (
                        <p className="text-xs text-red-300 mt-1">Attempts: {exec.retry_count}/{exec.max_retries || 3}</p>
                      )}
                    </div>
                    <Button
                      onClick={() => onRetry?.(exec)}
                      size="sm"
                      className="w-full bg-amber-500 hover:bg-amber-600 text-white"
                    >
                      <RefreshCw className="w-4 h-4 mr-1" />
                      Retry Execution
                    </Button>
                  </div>
                )}

                {/* Actions - only show in safe mode */}
                {isActive && executionMode === "safe" && (
                  <div className="space-y-2 pt-2">
                    {exec.intent_id && (
                      <Button
                        onClick={() => onApprove?.(exec)}
                        size="sm"
                        className="w-full bg-emerald-500 hover:bg-emerald-600 text-white"
                      >
                        <ThumbsUp className="w-4 h-4 mr-1" />
                        Approve Order
                      </Button>
                    )}
                    {exec.limit_price && (
                      <Button
                        onClick={() => onEditLimit?.(exec)}
                        variant="outline"
                        size="sm"
                        className="w-full border-amber-500/50 text-amber-400 hover:bg-amber-500/20"
                      >
                        <Edit3 className="w-4 h-4 mr-1" />
                        {exec.order_type === 'exit' ? 'Edit Exit Order' : 'Change Limit Price'}
                      </Button>
                    )}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => { onCancel?.(exec); }}
                        variant="outline"
                        size="sm"
                        className="flex-1 border-red-500/50 text-red-400 hover:bg-red-500/20"
                      >
                        <X className="w-4 h-4 mr-1" />
                        Cancel
                      </Button>
                      <Button
                        onClick={() => { onForceExecute?.(exec); }}
                        size="sm"
                        className="flex-1 bg-blue-500 hover:bg-blue-600 text-white"
                      >
                        <Send className="w-4 h-4 mr-1" />
                        Execute Now
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {executions.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          <Send className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No pending executions</p>
          <p className="text-xs mt-1">Execution requests will appear here</p>
          {onCreateDemo && (
            <Button
              onClick={onCreateDemo}
              disabled={isDemoLoading}
              size="sm"
              variant="outline"
              className="mt-4 border-blue-500/50 text-blue-400 hover:bg-blue-500/20"
            >
              {isDemoLoading ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-1" />
              )}
              Create Demo Order
            </Button>
          )}
        </div>
      )}
    </div>
  );
}