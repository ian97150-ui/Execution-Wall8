import React from 'react';
import { cn } from "@/lib/utils";
import { 
  TrendingUp, TrendingDown, BarChart3, Clock, 
  CheckCircle2, XCircle, AlertTriangle, Activity 
} from "lucide-react";

export default function StatsOverview({ 
  stats = {
    total_intents: 0,
    executed: 0,
    cancelled: 0,
    blocked: 0,
    pending: 0,
    avg_delay_seconds: 0,
    win_rate: null
  }
}) {
  const statCards = [
    {
      label: "Total Signals",
      value: stats.total_intents,
      icon: Activity,
      color: "text-blue-400",
      bg: "bg-blue-500/10"
    },
    {
      label: "Executed",
      value: stats.executed,
      icon: CheckCircle2,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10"
    },
    {
      label: "Blocked",
      value: stats.blocked,
      icon: XCircle,
      color: "text-red-400",
      bg: "bg-red-500/10"
    },
    {
      label: "Pending",
      value: stats.pending,
      icon: Clock,
      color: "text-amber-400",
      bg: "bg-amber-500/10"
    }
  ];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
        Session Overview
      </h3>

      <div className="grid grid-cols-2 gap-3">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className={cn(
                "p-4 rounded-xl border border-slate-700/50",
                stat.bg
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className={cn("w-4 h-4", stat.color)} />
                <span className="text-xs text-slate-400">{stat.label}</span>
              </div>
              <p className="text-2xl font-bold text-white">{stat.value}</p>
            </div>
          );
        })}
      </div>

      {/* Additional stats */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-slate-800/30 border border-slate-700/50">
        <div className="text-center flex-1">
          <p className="text-xs text-slate-500 uppercase mb-1">Avg Delay</p>
          <p className="font-mono font-bold text-white">
            {stats.avg_delay_seconds ? `${Number(stats.avg_delay_seconds).toFixed(0)}s` : "—"}
          </p>
        </div>
        <div className="w-px h-8 bg-slate-700" />
        <div className="text-center flex-1">
          <p className="text-xs text-slate-500 uppercase mb-1">Cancelled</p>
          <p className="font-mono font-bold text-slate-400">{stats.cancelled}</p>
        </div>
        {stats.win_rate !== null && (
          <>
            <div className="w-px h-8 bg-slate-700" />
            <div className="text-center flex-1">
              <p className="text-xs text-slate-500 uppercase mb-1">Win Rate</p>
              <p className={cn(
                "font-mono font-bold",
                stats.win_rate >= 50 ? "text-emerald-400" : "text-rose-400"
              )}>
                {Number(stats.win_rate).toFixed(0)}%
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}