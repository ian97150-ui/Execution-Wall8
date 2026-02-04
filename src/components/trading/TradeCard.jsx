import React, { useState, useRef } from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendingUp, TrendingDown, ExternalLink, Clock,
  Power, PowerOff, Edit3, AlertTriangle, ChevronDown, X, CheckCircle2, FileText
} from "lucide-react";
import { Button } from "@/components/ui/button";
import GateProgress from "./GateProgress";
import QualityBadge from "./QualityBadge";

export default function TradeCard({
  intent,
  hasLiveOrder = false,
  onSwipeOn,
  onSwipeOff,
  onDeny,
  isTopCard = false,
  style = {},
  isEnabled = false,
  tradingviewChartId
}) {
  const [expanded, setExpanded] = useState(false);
  const [showOverlay, setShowOverlay] = useState(null); // 'success' | 'rejected' | null

  const handleAction = async (action) => {
    // Show appropriate overlay based on action
    if (action === 'on') {
      setShowOverlay('success');
    } else if (action === 'off' || action === 'deny') {
      setShowOverlay('rejected');
    }

    // Wait a bit then trigger the action
    setTimeout(() => {
      if (action === 'on') onSwipeOn?.(intent);
      else if (action === 'off') onSwipeOff?.(intent);
      else if (action === 'deny') onDeny?.(intent);
    }, 400);
  };

  const isLong = intent.dir === "Long";
  const sideColor = isLong ? "emerald" : "rose";
  const SideIcon = isLong ? TrendingUp : TrendingDown;
  const sideLabel = intent.dir?.toUpperCase();

  const getSecUrl = (ticker) => {
    const forms = "10-K%2C10-K405%2C10-KT%2C10-Q%2C8-K%2C8-K12B%2C8-K12G3%2C8-K15D5%2CF-3%2CF-3ASR%2CF-3D%2CF-3DPOS%2CF-3MEF%2CN-2%2CN-2%20POSASR%2CS-1%2CS-11%2CS-11MEF%2CS-3%2CS-3D%2CS-3DPOS%2CS-3MEF%2CSF-3AFIN";
    return `https://www.sec.gov/edgar/search/#/dateRange=30d&category=custom&q=${ticker}&forms=${forms}`;
  };

  const formatPrice = (price) => {
    if (!price || price === undefined || price === null) return "—";
    return Number(price).toLocaleString('en-US', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    });
  };

  const formatPercent = (pct) => {
    if (!pct || pct === undefined || pct === null) return "—";
    return `${pct > 0 ? '+' : ''}${Number(pct).toFixed(2)}%`;
  };

  return (
    <motion.div
        style={style}
        className="absolute inset-0 z-10"
      >
      {/* Action overlay - green checkmark for ON, red X for OFF/Deny */}
      <AnimatePresence>
        {showOverlay && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className={cn(
              "absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm rounded-3xl",
              showOverlay === 'success' ? "bg-emerald-500/20" : "bg-red-500/20"
            )}
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
            >
              {showOverlay === 'success' ? (
                <CheckCircle2 className="w-32 h-32 text-emerald-400" strokeWidth={3} />
              ) : (
                <X className="w-32 h-32 text-red-400" strokeWidth={3} />
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card content */}
      <div className={cn(
        "h-full rounded-3xl overflow-hidden",
        "bg-gradient-to-b from-slate-800/95 to-slate-900/95",
        "border border-slate-700/50",
        "backdrop-blur-xl shadow-2xl"
      )}>
        {/* Header with side indicator */}
        <div className={cn(
          "h-1.5",
          isLong ? "bg-gradient-to-r from-emerald-500 to-emerald-400" : "bg-gradient-to-r from-rose-500 to-rose-400"
        )} />

        <div className="p-4 sm:p-6 space-y-3 sm:space-y-4">
          {/* Top row: Ticker, Side, Quality, Order Live */}
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                  {intent.ticker}
                </h2>
                <div className={cn(
                  "flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm font-bold",
                  isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                )}>
                  <SideIcon className="w-4 h-4" />
                  {sideLabel}
                </div>
                {isEnabled && (
                  <span className="px-2 py-1 rounded-md text-xs font-bold bg-emerald-500 text-emerald-950">
                    ON
                  </span>
                )}
                {hasLiveOrder && (
                  <span className="relative px-2 py-1 rounded-md text-xs font-bold bg-blue-500 text-blue-950">
                    <span className="absolute inset-0 rounded-md bg-blue-400 animate-ping opacity-50"></span>
                    <span className="relative flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-blue-900 animate-pulse"></span>
                      LIVE ORDER
                    </span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-blue-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    const chartPath = tradingviewChartId ? `chart/${tradingviewChartId}/` : 'chart/';
                    window.open(`https://www.tradingview.com/${chartPath}?symbol=${intent.ticker}`, '_blank', 'noopener,noreferrer');
                  }}
                >
                  View Chart <ExternalLink className="w-3 h-3" />
                </button>
                <button
                  className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(getSecUrl(intent.ticker), '_blank', 'noopener,noreferrer');
                  }}
                >
                  SEC <FileText className="w-3 h-3" />
                </button>
              </div>
            </div>
            <QualityBadge tier={intent.quality_tier || "B"} score={intent.quality_score} size="large" />
          </div>

          {/* Quality Metrics */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-400">Quality Score</span>
              <span className="text-lg font-mono font-bold text-white">{intent.quality_score || 0}/100</span>
            </div>
            {intent.card_state && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">State</span>
                <span className={cn(
                  "px-2 py-1 rounded text-xs font-bold uppercase tracking-wide",
                  intent.card_state === 'ELIGIBLE' ? "bg-emerald-500/20 text-emerald-400" :
                  intent.card_state === 'ARMED' ? "bg-amber-500/20 text-amber-400" :
                  intent.card_state === 'WAITING_DIP' ? "bg-blue-500/20 text-blue-400" :
                  "bg-slate-500/20 text-slate-400"
                )}>
                  {intent.card_state}
                </span>
              </div>
            )}
          </div>

          {/* Primary Blocker */}
          {intent.primary_blocker && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-200">{intent.primary_blocker}</p>
            </div>
          )}

          {/* Stats Grid */}
          <div className="bg-slate-700/30 rounded-xl p-3 text-center">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Price</p>
            <p className="text-lg font-bold text-white font-mono">${formatPrice(intent.price)}</p>
          </div>

          {/* Expand toggle */}
          <button 
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors py-1"
          >
            {expanded ? "Less details" : "More details"}
            <ChevronDown className={cn("w-4 h-4 transition-transform", expanded && "rotate-180")} />
          </button>



          {/* Action buttons for non-swipe interaction */}
          <div className="space-y-3 pt-3">
            <Button
              variant="outline"
              className="w-full h-14 text-base font-semibold border-blue-500/50 text-blue-400 hover:bg-blue-500/20"
              onClick={(e) => {
                e.stopPropagation();
                const chartPath = tradingviewChartId ? `chart/${tradingviewChartId}/` : 'chart/';
                window.open(`https://www.tradingview.com/${chartPath}?symbol=${intent.ticker}`, '_blank', 'noopener,noreferrer');
              }}
            >
              Open Chart
            </Button>
            <div className="flex gap-3">
              <Button 
                onClick={(e) => { e.stopPropagation(); handleAction('off'); }}
                variant="outline"
                className="flex-1 h-14 border-red-500/50 text-red-400 hover:bg-red-500/20"
                disabled={showOverlay}
              >
                <PowerOff className="w-5 h-5 mr-2" />
                OFF
              </Button>
              <Button 
                onClick={(e) => { e.stopPropagation(); handleAction('on'); }}
                className="flex-1 h-14 bg-emerald-500 hover:bg-emerald-600 text-emerald-950 font-bold"
                disabled={showOverlay}
              >
                <Power className="w-5 h-5 mr-2" />
                ON
              </Button>
            </div>
            <Button 
              onClick={(e) => { e.stopPropagation(); handleAction('deny'); }}
              variant="outline"
              className="w-full h-12 border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
              disabled={showOverlay}
            >
              <X className="w-4 h-4 mr-2" />
              Deny Order
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}