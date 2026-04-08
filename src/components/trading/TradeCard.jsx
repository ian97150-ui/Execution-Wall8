import React, { useState, useRef } from 'react';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendingUp, TrendingDown, ExternalLink, Clock,
  Power, PowerOff, Edit3, AlertTriangle, ChevronDown, X, CheckCircle2, FileText, ShieldOff,
  BookMarked, BadgeCheck, Send, Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import GateProgress from "./GateProgress";
import QualityBadge from "./QualityBadge";
import BiasBadge from "./BiasBadge";
import api from '@/api/apiClient';

export default function TradeCard({
  intent,
  hasLiveOrder = false,
  onSwipeOn,
  onSwipeOff,
  onDeny,
  onBlockAlerts,
  onUnblockAlerts,
  onSecWatch,
  onSecConfirm,
  isBlockingAlerts = false,
  isBlocked = false,
  isTopCard = false,
  style = {},
  isEnabled = false,
  dayPeakMove = null,
  tradingviewChartId
}) {
  const [expanded, setExpanded] = useState(false);
  const [showOverlay, setShowOverlay] = useState(null); // 'success' | 'rejected' | null
  const [showCustomOrder, setShowCustomOrder] = useState(false);
  const [customOrder, setCustomOrder] = useState({ action: '', quantity: '', limit_price: '' });
  const [customOrderStatus, setCustomOrderStatus] = useState(null); // null | 'sending' | 'ok' | 'error'
  const [customOrderError, setCustomOrderError] = useState('');

  const handleAction = async (action) => {
    // Show appropriate overlay based on action
    if (action === 'on') {
      setShowOverlay('success');
    } else if (action === 'off' || action === 'deny') {
      setShowOverlay('rejected');
    }

    // Block/unblock alerts doesn't use overlay animation — card stays in place
    if (action === 'blockAlerts') {
      onBlockAlerts?.(intent);
      return;
    }
    if (action === 'unblockAlerts') {
      onUnblockAlerts?.(intent);
      return;
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

  // Pre-parse expanded detail data
  let gateEntries = [];
  try { gateEntries = Object.entries(JSON.parse(intent.gates_data || '{}')); } catch {}
  let signalEntries = [];
  try {
    signalEntries = Object.entries(JSON.parse(intent.intent_data || '{}')).filter(([, v]) => typeof v === 'boolean');
  } catch {}
  const hasExpandedData = gateEntries.length > 0 || signalEntries.length > 0 || intent.strategy_id || intent.timeframe;

  // Parse score snapshot from sec_checklist
  let scoreSnapshot = null;
  try {
    const cl = intent.sec_checklist ? JSON.parse(intent.sec_checklist) : null;
    scoreSnapshot = cl?.score_snapshot ?? null;
  } catch {}

  const getSecUrl = (ticker) => {
    const forms = "10-K%2C10-K405%2C10-KT%2C10-Q%2C8-K%2CF-3%2CF-3ASR%2CF-3DPOS%2CF-3MEF%2CN-2%2CN-2%20POSASR%2CS-1%2CS-11%2CS-11MEF%2CS-1MEF%2CS-3%2CS-3ASR%2CS-3D%2CS-3DPOS%2CS-3MEF%2CSF-3%2C6-K";
    return `https://www.sec.gov/edgar/search/#/dateRange=30d&category=custom&entityName=${ticker}&forms=${forms}`;
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
        "h-full rounded-3xl flex flex-col overflow-hidden",
        "bg-gradient-to-b from-slate-800/95 to-slate-900/95",
        "border border-slate-700/50",
        "backdrop-blur-xl shadow-2xl"
      )}>
        {/* Header with side indicator — stays fixed at top */}
        <div className={cn(
          "h-1.5 shrink-0",
          isLong ? "bg-gradient-to-r from-emerald-500 to-emerald-400" : "bg-gradient-to-r from-rose-500 to-rose-400"
        )} />

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3 sm:space-y-4">
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
                {dayPeakMove !== null && (
                  <span className="px-2 py-1 rounded-md text-xs font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">
                    {Number(dayPeakMove).toFixed(1)}% mover
                  </span>
                )}
                {intent.sec_bias && <BiasBadge bias={intent.sec_bias} />}
                {intent.sec_confirmed && (
                  <span title="55% buffer invalidated" className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 cursor-help">
                    <BadgeCheck className="w-3 h-3" />
                    SEC ✓
                  </span>
                )}
                {intent.sec_watch && !intent.sec_confirmed && (
                  <span title="55% buffer invalidated" className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 cursor-help">
                    <BookMarked className="w-3 h-3" />
                    SEC WATCH
                  </span>
                )}
              </div>
              {(intent.sec_confirmed || intent.sec_watch) && (
                <p className="text-xs font-semibold text-amber-400/80 tracking-wide">
                  ⚠️ 55% buffer invalidated
                </p>
              )}
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
                <a
                  href={getSecUrl(intent.ticker)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  SEC <FileText className="w-3 h-3" />
                </a>
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

          {/* Expanded details */}
          {expanded && (
            <div className="space-y-3 pb-1">
              {!hasExpandedData && scoreSnapshot === null && (
                <p className="text-xs text-slate-500 text-center py-2">No additional signal data available</p>
              )}

              {/* Score Snapshot — Cat5ive v5 */}
              {scoreSnapshot && (
                <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-3 space-y-2">

                  {/* Override chips (display only — no execution effect) */}
                  {scoreSnapshot.overrides_fired?.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {scoreSnapshot.overrides_fired.map(o => (
                        <span key={o} className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide bg-amber-500/20 text-amber-300 border border-amber-500/40">
                          ⚡ {o.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Section badge + bias chip + score */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {scoreSnapshot.section && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide bg-slate-700/60 text-slate-300 border border-slate-600/50">
                        {scoreSnapshot.section} {scoreSnapshot.section === 'S1' ? 'D+1' : 'D+5'}
                      </span>
                    )}
                    <span className={cn(
                      "px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide",
                      scoreSnapshot.bias === 'MAX_CONVICTION'  ? "bg-red-600/30 text-red-300 border border-red-600/50" :
                      scoreSnapshot.bias === 'HIGH_CONVICTION' ? "bg-red-500/20 text-red-400 border border-red-500/40" :
                      scoreSnapshot.bias === 'CONFIRMED_SHORT' ? "bg-red-400/15 text-red-400 border border-red-400/30" :
                      scoreSnapshot.bias === 'LONG_CANDIDATE'  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" :
                      scoreSnapshot.bias === 'LONG_BIAS'       ? "bg-emerald-500/10 text-emerald-400/80 border border-emerald-500/30" :
                      "bg-slate-700/50 text-slate-400 border border-slate-600/50"
                    )}>
                      {scoreSnapshot.bias.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs font-mono text-slate-500">
                      {Math.round(scoreSnapshot.confidence * 100)}% conf
                    </span>
                    <span className={cn(
                      "text-xs font-mono font-bold ml-auto",
                      scoreSnapshot.score >= 8 ? "text-red-400" : scoreSnapshot.score <= -3 ? "text-emerald-400" : "text-slate-400"
                    )}>
                      {scoreSnapshot.score > 0 ? `+${scoreSnapshot.score}` : scoreSnapshot.score}
                    </span>
                  </div>

                  {/* S1 Clean score bar */}
                  {scoreSnapshot.section === 'S1' && scoreSnapshot.clean_score !== null && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-500">Clean score</span>
                        <span className={cn(
                          "font-bold",
                          scoreSnapshot.clean_outcome === 'DUMP'          ? "text-emerald-400" :
                          scoreSnapshot.clean_outcome === 'CLEAN_FADE'    ? "text-blue-400" :
                          scoreSnapshot.clean_outcome === 'VOLATILE_FADE' ? "text-yellow-400" :
                          "text-red-400"
                        )}>
                          {scoreSnapshot.clean_score}/10 — {scoreSnapshot.clean_outcome?.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="h-1 bg-slate-700/50 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            scoreSnapshot.clean_outcome === 'DUMP'          ? "bg-emerald-500" :
                            scoreSnapshot.clean_outcome === 'CLEAN_FADE'    ? "bg-blue-500" :
                            scoreSnapshot.clean_outcome === 'VOLATILE_FADE' ? "bg-yellow-500" :
                            "bg-red-500"
                          )}
                          style={{ width: `${scoreSnapshot.clean_score * 10}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Pressure bar (scale: |score| / 20) */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-500 w-8 text-right">LONG</span>
                    <div className="flex-1 relative h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
                      <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
                      {scoreSnapshot.score !== 0 && (
                        <div
                          className={cn(
                            "absolute inset-y-0 rounded-full",
                            scoreSnapshot.score < 0 ? "bg-emerald-500/70 right-1/2" : "bg-red-500/70 left-1/2"
                          )}
                          style={{ width: `${Math.min(Math.abs(scoreSnapshot.score) / 20 * 50, 50)}%` }}
                        />
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500 w-8">SHORT</span>
                  </div>

                  {/* Probability paths */}
                  {scoreSnapshot.probabilities?.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {scoreSnapshot.probabilities.map(p => (
                        <span key={p.path} className={cn(
                          "px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize",
                          p.path === 'dump' || p.path === 'fade' || p.path === 'failure'
                            ? "bg-red-500/15 text-red-400"
                            : p.path === 'chop'
                            ? "bg-yellow-500/15 text-yellow-400"
                            : "bg-emerald-500/15 text-emerald-400"
                        )}>
                          {p.path} {p.pct}%
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Reason */}
                  {scoreSnapshot.reason && (
                    <p className="text-[10px] text-slate-500 italic">{scoreSnapshot.reason}</p>
                  )}
                </div>
              )}

              {/* Gate breakdown */}
              {gateEntries.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-slate-500 uppercase tracking-wider">Gate Breakdown</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {gateEntries.map(([key, val]) => (
                      <div key={key} className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium",
                        val ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                      )}>
                        <span className="shrink-0">{val ? '✓' : '✗'}</span>
                        <span className="truncate">{key}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Signals breakdown */}
              {signalEntries.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-slate-500 uppercase tracking-wider">Signals</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {signalEntries.map(([key, val]) => (
                      <div key={key} className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium",
                        val ? "bg-blue-500/10 text-blue-400" : "bg-slate-500/10 text-slate-500"
                      )}>
                        <span className="shrink-0">{val ? '✓' : '—'}</span>
                        <span className="truncate">{key}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Strategy + timeframe */}
              {(intent.strategy_id || intent.timeframe) && (
                <div className="flex gap-2">
                  {intent.strategy_id && (
                    <div className="flex-1 bg-slate-700/30 rounded-lg p-2 text-center">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-0.5">Strategy</p>
                      <p className="text-xs font-mono font-bold text-slate-300">{intent.strategy_id}</p>
                    </div>
                  )}
                  {intent.timeframe && (
                    <div className="flex-1 bg-slate-700/30 rounded-lg p-2 text-center">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-0.5">Timeframe</p>
                      <p className="text-xs font-mono font-bold text-slate-300">{intent.timeframe}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Action buttons for non-swipe interaction */}
          <div className="space-y-3 pt-3">
            {/* Custom Order */}
            <Button
              variant="outline"
              className="w-full h-14 text-base font-semibold border-violet-500/50 text-violet-400 hover:bg-violet-500/20"
              onClick={(e) => {
                e.stopPropagation();
                setCustomOrder({
                  action: isLong ? 'buy' : 'sell',
                  quantity: '',
                  limit_price: intent.limit_price ? Number(intent.limit_price).toFixed(2) : ''
                });
                setCustomOrderStatus(null);
                setCustomOrderError('');
                setShowCustomOrder(v => !v);
              }}
            >
              <Send className="w-5 h-5 mr-2" />
              {showCustomOrder ? 'Cancel Custom Order' : 'Custom Order'}
            </Button>

            {showCustomOrder && (
              <div className="bg-slate-900/60 border border-violet-500/30 rounded-xl p-3 space-y-3" onClick={e => e.stopPropagation()}>
                {/* Action toggle */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setCustomOrder(o => ({ ...o, action: 'buy' }))}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-sm font-bold border transition-colors',
                      customOrder.action === 'buy'
                        ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-400'
                        : 'border-slate-600/50 text-slate-500 hover:text-slate-300'
                    )}
                  >BUY</button>
                  <button
                    onClick={() => setCustomOrder(o => ({ ...o, action: 'sell' }))}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-sm font-bold border transition-colors',
                      customOrder.action === 'sell'
                        ? 'bg-rose-500/20 border-rose-500/60 text-rose-400'
                        : 'border-slate-600/50 text-slate-500 hover:text-slate-300'
                    )}
                  >SELL</button>
                </div>

                {/* Quantity + Limit Price */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wide">Quantity</label>
                    <input
                      type="number"
                      min="1"
                      value={customOrder.quantity}
                      onChange={e => setCustomOrder(o => ({ ...o, quantity: e.target.value }))}
                      placeholder="100"
                      className="w-full mt-1 bg-slate-800/60 border border-slate-600/50 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wide">Limit Price</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={customOrder.limit_price}
                      onChange={e => setCustomOrder(o => ({ ...o, limit_price: e.target.value }))}
                      placeholder="0.00"
                      className="w-full mt-1 bg-slate-800/60 border border-slate-600/50 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                </div>

                {customOrderError && (
                  <p className="text-xs text-red-400">{customOrderError}</p>
                )}
                {customOrderStatus === 'ok' && (
                  <p className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Order sent to broker</p>
                )}

                <Button
                  disabled={customOrderStatus === 'sending' || !customOrder.action || !customOrder.quantity || !customOrder.limit_price}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setCustomOrderStatus('sending');
                    setCustomOrderError('');
                    try {
                      const { data } = await api.post('/executions/custom', {
                        ticker: intent.ticker,
                        action: customOrder.action,
                        quantity: Number(customOrder.quantity),
                        limit_price: Number(customOrder.limit_price),
                        intent_id: intent.id
                      });
                      if (data.success) {
                        setCustomOrderStatus('ok');
                        setTimeout(() => setShowCustomOrder(false), 2000);
                      } else {
                        setCustomOrderStatus('error');
                        setCustomOrderError(data.broker?.error || 'Broker rejected the order');
                      }
                    } catch (err) {
                      setCustomOrderStatus('error');
                      setCustomOrderError(err.response?.data?.error || 'Failed to send order');
                    }
                  }}
                  className="w-full bg-violet-600 hover:bg-violet-700 text-white font-semibold"
                >
                  {customOrderStatus === 'sending'
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</>
                    : <><Send className="w-4 h-4 mr-2" />Send Order</>}
                </Button>
              </div>
            )}
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
            {/* SEC actions */}
            {!intent.sec_watch && (
              <Button
                onClick={(e) => { e.stopPropagation(); onSecWatch?.(intent, 'watch'); }}
                variant="outline"
                className="w-full h-12 border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/20"
                disabled={showOverlay}
                title="55% buffer invalidated"
              >
                <BookMarked className="w-4 h-4 mr-2" />
                Add to SEC Watch
              </Button>
            )}
            {intent.sec_watch && !intent.sec_confirmed && (
              <div className="flex gap-3">
                <Button
                  onClick={(e) => { e.stopPropagation(); onSecWatch?.(intent, 'unwatch'); }}
                  variant="outline"
                  className="flex-1 h-12 border-slate-500/50 text-slate-400 hover:bg-slate-500/20"
                  disabled={showOverlay}
                  title="55% buffer invalidated"
                >
                  <BookMarked className="w-4 h-4 mr-2" />
                  Remove Watch
                </Button>
                <Button
                  onClick={(e) => { e.stopPropagation(); onSecConfirm?.(intent, 'confirm'); }}
                  variant="outline"
                  className="flex-1 h-12 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/20"
                  disabled={showOverlay}
                  title="55% buffer invalidated"
                >
                  <BadgeCheck className="w-4 h-4 mr-2" />
                  SEC Confirmed
                </Button>
              </div>
            )}
            {intent.sec_confirmed && (
              <Button
                onClick={(e) => { e.stopPropagation(); onSecConfirm?.(intent, 'unconfirm'); }}
                variant="outline"
                className="w-full h-12 border-cyan-500/30 text-cyan-500/60 hover:bg-cyan-500/10"
                disabled={showOverlay}
                title="55% buffer invalidated"
              >
                <BadgeCheck className="w-4 h-4 mr-2" />
                SEC Confirmed — Undo
              </Button>
            )}

            <Button
              onClick={(e) => { e.stopPropagation(); handleAction(isBlocked ? 'unblockAlerts' : 'blockAlerts'); }}
              variant="outline"
              className={cn(
                "w-full h-12",
                isBlocked
                  ? "border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
                  : "border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
              )}
              disabled={showOverlay || isBlockingAlerts}
              title={isBlocked ? "Unblock WALL alerts for this ticker" : "Block all WALL alerts for this ticker until next daily reset"}
            >
              <ShieldOff className={cn("w-4 h-4 mr-2", isBlockingAlerts && "animate-pulse")} />
              {isBlocked ? "Unblock Alerts" : "Block Alerts"}
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}