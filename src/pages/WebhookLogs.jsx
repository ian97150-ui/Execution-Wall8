import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowLeft, CheckCircle2, XCircle, Clock,
  AlertTriangle, RefreshCw, Webhook, ChevronDown, ChevronUp
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import api from "@/api/apiClient";

export default function WebhookLogs() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [expandedLog, setExpandedLog] = useState(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['webhookLogs', statusFilter, sourceFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.append('status', statusFilter);
      if (sourceFilter !== "all") params.append('source', sourceFilter);
      params.append('limit', '100');

      const response = await api.get(`/webhook/logs?${params.toString()}`);
      return response.data;
    },
    refetchInterval: 5000
  });

  const logs = data?.logs || [];

  const statusOptions = [
    { value: "all", label: "All" },
    { value: "success", label: "Success" },
    { value: "error", label: "Error" },
    { value: "processing", label: "Processing" }
  ];

  const sourceOptions = [
    { value: "all", label: "All Sources" },
    { value: "tradingview", label: "TradingView" },
    { value: "zapier", label: "Zapier" }
  ];

  const getStatusBadge = (status) => {
    const config = {
      success: { icon: CheckCircle2, color: "text-emerald-400 bg-emerald-500/20", label: "Success" },
      error: { icon: XCircle, color: "text-red-400 bg-red-500/20", label: "Error" },
      processing: { icon: Clock, color: "text-amber-400 bg-amber-500/20", label: "Processing" }
    };
    return config[status] || config.processing;
  };

  const parsePayload = (payload) => {
    try {
      return typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      return payload;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800">
        <div className="flex items-center justify-between px-4 h-16">
          <div className="flex items-center gap-3">
            <Link to={createPageUrl("Dashboard")}>
              <Button variant="ghost" size="icon" className="text-slate-400">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1 className="font-bold text-white text-lg flex items-center gap-2">
                <Webhook className="w-5 h-5 text-blue-400" />
                Webhook Logs
              </h1>
              <p className="text-xs text-slate-500">{data?.total || 0} total webhooks received</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            className={cn("text-slate-400", isFetching && "animate-spin")}
          >
            <RefreshCw className="w-5 h-5" />
          </Button>
        </div>
      </header>

      {/* Filters */}
      <div className="px-4 py-4 border-b border-slate-800 space-y-3">
        {/* Status Filter */}
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

        {/* Source Filter */}
        <div className="flex gap-2 overflow-x-auto">
          {sourceOptions.map(option => (
            <button
              key={option.value}
              onClick={() => setSourceFilter(option.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all",
                sourceFilter === option.value
                  ? "bg-purple-500/20 text-purple-400 border border-purple-500/50"
                  : "bg-slate-800/50 text-slate-400 hover:text-slate-300"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Webhook List */}
      <div className="p-4 space-y-3">
        {isLoading ? (
          <div className="text-center py-12 text-slate-500">
            <Clock className="w-10 h-10 mx-auto mb-3 opacity-40 animate-spin" />
            <p>Loading webhook logs...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <Webhook className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No webhook logs found</p>
            <p className="text-xs mt-2">Webhooks will appear here when received</p>
          </div>
        ) : (
          logs.map((log, index) => {
            const statusBadge = getStatusBadge(log.status);
            const StatusIcon = statusBadge.icon;
            const payload = parsePayload(log.payload);
            const isExpanded = expandedLog === log.id;

            return (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.02 }}
                className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden"
              >
                {/* Header - clickable to expand */}
                <button
                  onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                  className="w-full p-4 flex items-center justify-between hover:bg-slate-700/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {/* Source Badge */}
                    <span className={cn(
                      "px-2 py-1 rounded text-xs font-bold uppercase",
                      log.source === 'tradingview'
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-orange-500/20 text-orange-400"
                    )}>
                      {log.source}
                    </span>

                    {/* Status Badge */}
                    <span className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium",
                      statusBadge.color
                    )}>
                      <StatusIcon className="w-3 h-3" />
                      {statusBadge.label}
                    </span>

                    {/* Ticker preview if available */}
                    {payload?.ticker && (
                      <span className="text-white font-medium">{payload.ticker}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-500">
                      {log.timestamp && format(new Date(log.timestamp), "MMM d, HH:mm:ss")}
                    </span>
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                </button>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3 border-t border-slate-700/50">
                    {/* Error message if present */}
                    {log.error && (
                      <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                        <p className="text-xs text-red-400 font-medium mb-1">Error:</p>
                        <p className="text-sm text-red-300">{log.error}</p>
                      </div>
                    )}

                    {/* Payload */}
                    <div className="mt-3">
                      <p className="text-xs text-slate-500 uppercase mb-2">Payload:</p>
                      <pre className="bg-slate-900/50 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto">
                        {JSON.stringify(payload, null, 2)}
                      </pre>
                    </div>

                    {/* ID */}
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">ID: {log.id}</span>
                    </div>
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
