import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowLeft, RefreshCw, ScrollText, Clock, Search,
  TrendingUp, TrendingDown, ShieldOff, ChevronDown, ChevronUp,
  Download
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import api from "@/api/apiClient";

const EVENT_TYPES = [
  { value: "all", label: "All Events" },
  { value: "intent_created,intent_updated", label: "WALL Alerts" },
  { value: "execution_created", label: "ORDER Signals" },
  { value: "stop_loss_hit,exit_immediate,exit_created,position_closed", label: "Position Exits" },
  { value: "swiped_approve,swiped_off,swiped_deny,swiped_revive", label: "Swipe Actions" },
];

const PAGE_SIZE = 50;

export default function AuditLog() {
  const [eventFilter, setEventFilter] = useState("all");
  const [tickerFilter, setTickerFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [expandedLog, setExpandedLog] = useState(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['auditLogs', eventFilter, tickerFilter, offset],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (eventFilter !== "all") params.append('event_type', eventFilter);
      if (tickerFilter.trim()) params.append('ticker', tickerFilter.trim().toUpperCase());
      params.append('limit', String(PAGE_SIZE));
      params.append('offset', String(offset));

      const response = await api.get(`/audit-logs?${params.toString()}`);
      return response.data;
    },
    keepPreviousData: true,
  });

  const logs = data?.logs || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const getEventBadge = (eventType) => {
    if (eventType === 'intent_created') return { label: "WALL NEW", color: "bg-blue-500/20 text-blue-400" };
    if (eventType === 'intent_updated') return { label: "WALL UPDATE", color: "bg-cyan-500/20 text-cyan-400" };
    if (eventType === 'execution_created') return { label: "ORDER", color: "bg-amber-500/20 text-amber-400" };
    if (eventType === 'execution_immediate') return { label: "ORDER AUTO", color: "bg-orange-500/20 text-orange-400" };
    if (eventType === 'exit_created') return { label: "EXIT", color: "bg-purple-500/20 text-purple-400" };
    if (eventType === 'exit_immediate') return { label: "EXIT AUTO", color: "bg-pink-500/20 text-pink-400" };
    if (eventType === 'swiped_approve') return { label: "SWIPED ON", color: "bg-emerald-500/20 text-emerald-400" };
    if (eventType === 'swiped_off') return { label: "SWIPED OFF", color: "bg-red-500/20 text-red-400" };
    if (eventType === 'swiped_deny') return { label: "DENIED", color: "bg-rose-500/20 text-rose-400" };
    if (eventType === 'swiped_revive') return { label: "REVIVED", color: "bg-teal-500/20 text-teal-400" };
    return { label: eventType, color: "bg-slate-500/20 text-slate-400" };
  };

  const parseDetails = (details) => {
    try {
      return typeof details === 'string' ? JSON.parse(details) : details;
    } catch {
      return {};
    }
  };

  const handleExportCSV = () => {
    if (logs.length === 0) return;

    const csvLines = ['Type,Timestamp (UTC),Ticker,Strategy,Timeframe,Price,Gates Hit,Gates Total,Quality Tier,Quality Score,Order Action,Quantity,Limit Price,Gate Vector'];

    for (const log of logs) {
      const d = parseDetails(log.details);
      const gateVector = d.gate_vector ? Object.entries(d.gate_vector).map(([k,v]) => `${k}=${v}`).join('; ') : '';
      csvLines.push([
        log.event_type,
        log.timestamp,
        log.ticker || '',
        d.strategy_id || '',
        d.timeframe || '',
        d.price || '',
        d.gates_hit ?? '',
        d.gates_total ?? '',
        d.quality_tier || '',
        d.quality_score ?? '',
        d.order_action || '',
        d.quantity || '',
        d.limit_price || '',
        `"${gateVector}"`
      ].join(','));
    }

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${tickerFilter || 'all'}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
                <ScrollText className="w-5 h-5 text-purple-400" />
                Audit Log
              </h1>
              <p className="text-xs text-slate-500">{total.toLocaleString()} events (60-day retention)</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleExportCSV}
              className="text-slate-400"
              title="Export current view as CSV"
              disabled={logs.length === 0}
            >
              <Download className="w-5 h-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => refetch()}
              className={cn("text-slate-400", isFetching && "animate-spin")}
            >
              <RefreshCw className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="px-4 py-4 border-b border-slate-800 space-y-3">
        {/* Ticker Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            placeholder="Filter by ticker (e.g. UOKA)"
            value={tickerFilter}
            onChange={(e) => { setTickerFilter(e.target.value); setOffset(0); }}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-800/50 border border-slate-700/50 rounded-xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
          />
        </div>

        {/* Event Type Filter */}
        <div className="flex gap-2 overflow-x-auto">
          {EVENT_TYPES.map(option => (
            <button
              key={option.value}
              onClick={() => { setEventFilter(option.value); setOffset(0); }}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all",
                eventFilter === option.value
                  ? "bg-purple-500/20 text-purple-400 border border-purple-500/50"
                  : "bg-slate-800/50 text-slate-400 hover:text-slate-300"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Log List */}
      <div className="p-4 space-y-2">
        {isLoading ? (
          <div className="text-center py-12 text-slate-500">
            <Clock className="w-10 h-10 mx-auto mb-3 opacity-40 animate-spin" />
            <p>Loading audit logs...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <ScrollText className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No audit logs found</p>
            <p className="text-xs mt-2">Try adjusting your filters</p>
          </div>
        ) : (
          <>
            {logs.map((log, index) => {
              const eventBadge = getEventBadge(log.event_type);
              const details = parseDetails(log.details);
              const isExpanded = expandedLog === log.id;
              const isWall = log.event_type.startsWith('intent_');
              const isOrder = log.event_type.startsWith('execution_');

              return (
                <motion.div
                  key={log.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: index * 0.01 }}
                  className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                    className="w-full p-3 flex items-center justify-between hover:bg-slate-700/30 transition-colors"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Event Type Badge */}
                      <span className={cn("px-2 py-0.5 rounded text-xs font-bold", eventBadge.color)}>
                        {eventBadge.label}
                      </span>

                      {/* Ticker */}
                      {log.ticker && (
                        <span className="font-bold text-white">{log.ticker}</span>
                      )}

                      {/* Direction for WALL */}
                      {isWall && details.strategy_id && (
                        <span className="text-xs text-slate-500">{details.strategy_id}</span>
                      )}

                      {/* Quality for WALL */}
                      {isWall && details.quality_tier && (
                        <span className={cn(
                          "px-1.5 py-0.5 rounded text-xs font-bold",
                          details.quality_tier === 'A+' ? "bg-emerald-500/20 text-emerald-400" :
                          details.quality_tier === 'A' ? "bg-green-500/20 text-green-400" :
                          details.quality_tier === 'B' ? "bg-blue-500/20 text-blue-400" :
                          details.quality_tier === 'C' ? "bg-amber-500/20 text-amber-400" :
                          "bg-slate-500/20 text-slate-400"
                        )}>
                          {details.quality_tier} ({details.quality_score})
                        </span>
                      )}

                      {/* Gates for WALL */}
                      {isWall && details.gates_hit != null && (
                        <span className="text-xs text-slate-500">
                          {details.gates_hit}/{details.gates_total} gates
                        </span>
                      )}

                      {/* Price for WALL */}
                      {isWall && details.price && (
                        <span className="text-xs text-slate-400">${details.price}</span>
                      )}

                      {/* Order details */}
                      {isOrder && (
                        <>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-xs font-bold uppercase",
                            details.order_action === 'sell' ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400"
                          )}>
                            {details.order_action}
                          </span>
                          <span className="text-xs text-slate-300">
                            {details.quantity} @ ${details.limit_price}
                          </span>
                          {details.auto_linked && (
                            <span className="text-xs text-blue-400">auto-linked</span>
                          )}
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-xs text-slate-500">
                        {format(new Date(log.timestamp), "MMM d, HH:mm:ss")}
                      </span>
                      {isExpanded ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
                    </div>
                  </button>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="px-3 pb-3 border-t border-slate-700/50 space-y-2">
                      {/* Gate Vector */}
                      {details.gate_vector && (
                        <div className="mt-2">
                          <p className="text-xs text-slate-500 uppercase mb-1">Gate Vector</p>
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(details.gate_vector).map(([gate, passed]) => (
                              <span key={gate} className={cn(
                                "px-2 py-0.5 rounded text-xs font-medium",
                                passed ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                              )}>
                                {gate}: {passed ? "PASS" : "FAIL"}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Full Details */}
                      <div className="mt-2">
                        <p className="text-xs text-slate-500 uppercase mb-1">Raw Details</p>
                        <pre className="bg-slate-900/50 rounded-lg p-2 text-xs text-slate-300 overflow-x-auto">
                          {JSON.stringify(details, null, 2)}
                        </pre>
                      </div>

                      <div className="text-xs text-slate-600">ID: {log.id}</div>
                    </div>
                  )}
                </motion.div>
              );
            })}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="text-slate-400 border-slate-700"
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-500">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= total}
                  className="text-slate-400 border-slate-700"
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
