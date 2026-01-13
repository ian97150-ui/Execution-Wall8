import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { 
  ArrowLeft, TrendingUp, TrendingDown, 
  CheckCircle2, XCircle, Clock, AlertTriangle 
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";

export default function ExecutionHistory() {
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: executions = [], isLoading } = useQuery({
    queryKey: ['executionHistory', statusFilter],
    queryFn: async () => {
      const query = statusFilter === "all" 
        ? {} 
        : { status: statusFilter };
      return await base44.entities.TradeIntent.filter(query, '-created_date', 200);
    },
    refetchInterval: 10000
  });

  const statusOptions = [
    { value: "all", label: "All" },
    { value: "executed", label: "Executed" },
    { value: "failed", label: "Failed" },
    { value: "cancelled", label: "Cancelled" },
    { value: "pending", label: "Pending" }
  ];

  const getStatusBadge = (status) => {
    const config = {
      executed: { icon: CheckCircle2, color: "text-emerald-400 bg-emerald-500/20" },
      failed: { icon: AlertTriangle, color: "text-red-400 bg-red-500/20" },
      cancelled: { icon: XCircle, color: "text-slate-400 bg-slate-500/20" },
      pending: { icon: Clock, color: "text-amber-400 bg-amber-500/20" }
    };
    return config[status] || config.pending;
  };

  const formatPrice = (price) => {
    if (!price) return "—";
    return `$${Number(price).toFixed(2)}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800">
        <div className="flex items-center gap-3 px-4 h-16">
          <Link to={createPageUrl("Dashboard")}>
            <Button variant="ghost" size="icon" className="text-slate-400">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div>
            <h1 className="font-bold text-white text-lg">Execution History</h1>
            <p className="text-xs text-slate-500">{executions.length} total records</p>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="px-4 py-4 border-b border-slate-800">
        <div className="flex gap-2 overflow-x-auto">
          {statusOptions.map(option => (
            <button
              key={option.value}
              onClick={() => setStatusFilter(option.value)}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all",
                statusFilter === option.value
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/50"
                  : "bg-slate-800/50 text-slate-400 hover:text-slate-300"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Execution List */}
      <div className="p-4 space-y-3">
        {isLoading ? (
          <div className="text-center py-12 text-slate-500">
            <Clock className="w-10 h-10 mx-auto mb-3 opacity-40 animate-spin" />
            <p>Loading history...</p>
          </div>
        ) : executions.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No executions found</p>
          </div>
        ) : (
          executions.map((exec, index) => {
            const statusBadge = getStatusBadge(exec.status);
            const StatusIcon = statusBadge.icon;
            const isLong = exec.dir === "Long";

            return (
              <motion.div
                key={exec.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.02 }}
                className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-white">{exec.ticker}</span>
                    <span className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                    )}>
                      {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {exec.dir?.toUpperCase()}
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
                      <StatusIcon className="w-3 h-3" />
                      {exec.status}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">
                    {exec.created_date && format(new Date(exec.created_date), "MMM d, HH:mm")}
                  </span>
                </div>

                {/* Details */}
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Action</p>
                    <p className="font-medium text-white text-sm">{exec.order_action?.toUpperCase()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Qty</p>
                    <p className="font-medium text-white text-sm">{exec.quantity || 1}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Limit</p>
                    <p className="font-medium text-white text-sm">{formatPrice(exec.limit_price)}</p>
                  </div>
                </div>

                {/* Failure reason if failed */}
                {exec.status === 'failed' && exec.failure_reason && (
                  <div className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/30">
                    <p className="text-xs text-red-400">{exec.failure_reason}</p>
                  </div>
                )}
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}