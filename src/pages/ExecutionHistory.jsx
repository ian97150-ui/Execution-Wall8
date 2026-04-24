import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowLeft, TrendingUp, TrendingDown,
  CheckCircle2, XCircle, Clock, AlertTriangle, Download, FileText
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { format, differenceInDays } from "date-fns";
import api from "@/api/apiClient";

const PRE_FALL_COLORS = {
  HIGH: "text-red-400",
  MEDIUM: "text-orange-400",
  LOW: "text-yellow-400",
  SKIP: "text-slate-500",
};

const BIAS_COLORS = {
  MAX_CONVICTION: "bg-red-600/20 text-red-300 border-red-600/40",
  HIGH_CONVICTION: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  CONFIRMED_SHORT: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  NEUTRAL: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  LONG_BIAS: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  LONG_CANDIDATE: "bg-teal-500/20 text-teal-300 border-teal-500/40",
};

export default function ExecutionHistory() {
  const [statusFilter, setStatusFilter] = useState("all");

  const apiUrl = import.meta.env.VITE_API_URL || '/api';

  const handleExport = () => {
    const link = document.createElement('a');
    link.href = `${apiUrl}/executions/export`;
    const date = new Date().toISOString().slice(0, 10);
    link.setAttribute('download', `execution-wall-${date}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleExportGrades = () => {
    const link = document.createElement('a');
    link.href = `${apiUrl}/executions/export-grades`;
    const date = new Date().toISOString().slice(0, 10);
    link.setAttribute('download', `execution-grades-${date}.txt`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const { data: executions = [], isLoading } = useQuery({
    queryKey: ['executionHistory', statusFilter],
    queryFn: async () => {
      const params = {};
      if (statusFilter !== "all") params.status = statusFilter;
      const response = await api.get('/executions', { params });
      return response.data || [];
    },
    refetchInterval: 10000
  });

  const { data: dbStats } = useQuery({
    queryKey: ['db-stats'],
    queryFn: () => api.get('/database/stats').then(r => r.data),
    refetchInterval: 5 * 60 * 1000,
  });

  // Show cleanup warning if DB is ≥65% full OR oldest execution is ≥23 days old
  const showCleanupWarning = (() => {
    if (dbStats?.size?.usagePercent >= 65) return true;
    if (executions.length > 0) {
      const oldest = executions[executions.length - 1];
      if (oldest?.created_at && differenceInDays(new Date(), new Date(oldest.created_at)) >= 23) return true;
    }
    return false;
  })();

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
          <div className="flex-1">
            <h1 className="font-bold text-white text-lg">Execution History</h1>
            <p className="text-xs text-slate-500">{executions.length} total records</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={handleExportGrades}
              variant="outline"
              size="sm"
              className="flex items-center gap-2 border-slate-700 text-slate-300 hover:text-white hover:border-slate-500"
            >
              <FileText className="w-4 h-4" />
              Download TXT
            </Button>
            <Button
              onClick={handleExport}
              variant="outline"
              size="sm"
              className="flex items-center gap-2 border-slate-700 text-slate-300 hover:text-white hover:border-slate-500"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
          </div>
        </div>
      </header>

      {/* Cleanup Warning Banner */}
      {showCleanupWarning && (
        <div className="px-4 pt-4">
          <Alert className="border-red-500/50 bg-red-500/10">
            <AlertTriangle className="h-4 w-4 text-red-400" />
            <AlertTitle className="text-red-300">History approaching cleanup limit</AlertTitle>
            <AlertDescription className="text-red-400/80">
              {dbStats?.size?.usagePercent >= 65
                ? `Database is at ${dbStats.size.usagePercent.toFixed(0)}% capacity.`
                : "Oldest execution records are nearing the 30-day retention window."}{" "}
              Order scoring data may be deleted soon.{" "}
              <button
                onClick={handleExportGrades}
                className="underline font-medium text-red-300 hover:text-red-200"
              >
                Download TXT backup now
              </button>
            </AlertDescription>
          </Alert>
        </div>
      )}

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
            let isExit = false;
            try { isExit = exec.raw_payload && JSON.parse(exec.raw_payload).event === 'EXIT'; } catch {}

            let grade = null;
            try { if (exec.grade_snapshot) grade = JSON.parse(exec.grade_snapshot); } catch {}

            const biasCls = grade?.bias ? (BIAS_COLORS[grade.bias] || BIAS_COLORS.NEUTRAL) : null;
            const preFallCls = grade?.pre_fall_tier ? (PRE_FALL_COLORS[grade.pre_fall_tier] || PRE_FALL_COLORS.SKIP) : null;

            return (
              <motion.div
                key={exec.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.02 }}
                className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4"
              >
                {/* Header row */}
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
                    {isExit && (
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
                    {exec.created_at && format(new Date(exec.created_at), "MMM d, HH:mm")}
                  </span>
                </div>

                {/* Order details */}
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Action</p>
                    <p className="font-medium text-white text-sm">{exec.order_action?.toUpperCase()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Quantity</p>
                    <p className="font-medium text-white text-sm">{exec.quantity ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase mb-1">Price</p>
                    <p className="font-medium text-white text-sm">{formatPrice(exec.limit_price)}</p>
                  </div>
                </div>

                {/* Grade row — only shown when snapshot exists */}
                {grade && (
                  <div className="mt-3 pt-3 border-t border-slate-700/50 grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-xs text-slate-500 uppercase mb-1">Score</p>
                      <p className="font-medium text-white text-sm">
                        {grade.score != null ? grade.score.toFixed(1) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 uppercase mb-1">Bias</p>
                      {biasCls ? (
                        <span className={cn("px-2 py-0.5 rounded border text-xs font-medium", biasCls)}>
                          {grade.bias?.replace(/_/g, " ")}
                        </span>
                      ) : <p className="text-slate-500 text-sm">—</p>}
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 uppercase mb-1">Pre-Fall</p>
                      {grade.pre_fall_tier ? (
                        <p className={cn("font-medium text-sm", preFallCls)}>
                          {grade.pre_fall_tier}
                          {grade.pre_fall_score != null && (
                            <span className="text-xs text-slate-500 ml-1">({grade.pre_fall_score})</span>
                          )}
                        </p>
                      ) : <p className="text-slate-500 text-sm">—</p>}
                    </div>
                  </div>
                )}

                {/* Error message */}
                {(exec.status === 'failed' || exec.status === 'cancelled') && exec.error_message && (
                  <div className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/30">
                    <p className="text-xs text-red-400">{exec.error_message}</p>
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
