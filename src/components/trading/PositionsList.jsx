import React from 'react';
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, ShieldOff, Shield, Flag, Target, X, Activity, FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { format } from "date-fns";

const API = (import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:3000/api')) + '/positions';

const STATE_COLOR = {
  CONTINUATION:      'text-rose-400 bg-rose-500/15 border-rose-500/30',
  EXHAUSTION:        'text-emerald-400 bg-emerald-500/15 border-emerald-500/30',
  ABSORPTION:        'text-emerald-400 bg-emerald-500/15 border-emerald-500/30',
  FAILED_BREAKOUT:   'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
  DISTRIBUTION:      'text-emerald-400 bg-emerald-500/15 border-emerald-500/30',
  LIQUIDITY_VACUUM:  'text-amber-400 bg-amber-500/15 border-amber-500/30',
  SPIKE_INITIATION:  'text-amber-400 bg-amber-500/15 border-amber-500/30',
  DOWNSIDE_PRESSURE: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
};

const ACTION_COLOR = {
  HOLD: 'text-emerald-400', 'HOLD/MONITOR': 'text-emerald-400',
  'HOLD - WAIT': 'text-amber-400', MONITOR: 'text-amber-400',
  CAUTION: 'text-amber-400', 'COVER PARTIAL': 'text-rose-400', EXIT: 'text-rose-400',
};

export default function PositionsList({
  positions = [],
  onBlockSignals,
  onUnblockSignals,
  onMarkFlat,
  onSetTTP,
  onClearTTP,
  tickers = [],
  onCreateDemo,
  isDemoLoading,
}) {
  const [cooldownTimers, setCooldownTimers] = React.useState({});
  const [ttpInputOpen, setTtpInputOpen] = React.useState({});
  const [ttpInputValue, setTtpInputValue] = React.useState({});
  const [ttpPercent, setTtpPercent] = React.useState({});
  const [monitoring, setMonitoring] = React.useState({});       // { [positionId]: true }
  const [liveState, setLiveState] = React.useState({});         // { [positionId]: parsed update }
  const esRefs = React.useRef({});                              // { [positionId]: EventSource }

  const stopMonitor = React.useCallback((positionId) => {
    esRefs.current[positionId]?.close();
    delete esRefs.current[positionId];
    setMonitoring(prev => ({ ...prev, [positionId]: false }));
  }, []);

  const startMonitor = React.useCallback((positionId) => {
    if (esRefs.current[positionId]) return;
    setMonitoring(prev => ({ ...prev, [positionId]: true }));
    setLiveState(prev => ({ ...prev, [positionId]: null }));

    const es = new EventSource(`${API}/${positionId}/monitor`);
    esRefs.current[positionId] = es;

    es.addEventListener('update', (e) => {
      try { setLiveState(prev => ({ ...prev, [positionId]: JSON.parse(e.data) })); } catch {}
    });
    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data || '{}');
        if (data.message) setLiveState(prev => ({ ...prev, [positionId]: { error: data.message } }));
      } catch {}
    });
    es.addEventListener('done', () => stopMonitor(positionId));
    es.onerror = () => stopMonitor(positionId);
  }, [stopMonitor]);

  React.useEffect(() => () => {
    Object.values(esRefs.current).forEach(es => es.close());
  }, []);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCooldownTimers(prev => {
        const updated = {};
        for (const [key, endTime] of Object.entries(prev)) {
          if (endTime > Date.now()) {
            updated[key] = endTime;
          }
        }
        return updated;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleMarkFlat = (position) => {
    const key = `${position.ticker}_${position.side}`;
    setCooldownTimers(prev => ({
      ...prev,
      [key]: Date.now() + 300000 // 5 minutes
    }));
    onMarkFlat?.(position);
  };

  const getCooldownRemaining = (position) => {
    const key = `${position.ticker}_${position.side}`;
    const endTime = cooldownTimers[key];
    if (!endTime) return 0;
    return Math.max(0, Math.floor((endTime - Date.now()) / 1000));
  };

  const handleSetTTP = (position) => {
    const val = parseFloat(ttpInputValue[position.id]);
    if (!isNaN(val) && val > 0) {
      onSetTTP?.(position, val);
      setTtpInputOpen(prev => ({ ...prev, [position.id]: false }));
      setTtpInputValue(prev => ({ ...prev, [position.id]: '' }));
      setTtpPercent(prev => ({ ...prev, [position.id]: 0 }));
    }
  };

  const closeTtpInput = (id) => {
    setTtpInputOpen(prev => ({ ...prev, [id]: false }));
    setTtpInputValue(prev => ({ ...prev, [id]: '' }));
    setTtpPercent(prev => ({ ...prev, [id]: 0 }));
  };

  const openTtpInput = (position) => {
    const isLong = position.side === "long";
    const defaultPercent = isLong ? -5 : 5;
    const entry = Number(position.avg_entry_price) || 0;
    setTtpInputOpen(prev => ({ ...prev, [position.id]: true }));
    setTtpPercent(prev => ({ ...prev, [position.id]: defaultPercent }));
    setTtpInputValue(prev => ({
      ...prev,
      [position.id]: entry > 0 ? (entry * (1 + defaultPercent / 100)).toFixed(2) : ''
    }));
  };

  const handleTtpPercentChange = (position, percent) => {
    const entry = Number(position.avg_entry_price) || 0;
    setTtpPercent(prev => ({ ...prev, [position.id]: percent }));
    if (entry > 0) {
      setTtpInputValue(prev => ({ ...prev, [position.id]: (entry * (1 + percent / 100)).toFixed(2) }));
    }
  };

  const calcTtpPnl = (position, price) => {
    const entry = Number(position.avg_entry_price) || 0;
    const qty = Number(position.quantity) || 0;
    const isLong = position.side === "long";
    const diff = isLong ? (price - entry) : (entry - price);
    return diff * qty;
  };

  const handleTtpPriceChange = (position, rawValue) => {
    setTtpInputValue(prev => ({ ...prev, [position.id]: rawValue }));
    const entry = Number(position.avg_entry_price) || 0;
    const price = parseFloat(rawValue);
    if (entry > 0 && !isNaN(price)) {
      setTtpPercent(prev => ({ ...prev, [position.id]: ((price - entry) / entry) * 100 }));
    }
  };

  const demoButton = onCreateDemo && (
    <Button
      onClick={onCreateDemo}
      disabled={isDemoLoading}
      size="sm"
      variant="outline"
      className="border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/20"
    >
      {isDemoLoading ? (
        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
      ) : (
        <FlaskConical className="w-4 h-4 mr-1" />
      )}
      Demo Position (status.inquisit)
    </Button>
  );

  if (positions.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">No open positions</p>
        <p className="text-xs mt-1">Executed trades will appear here</p>
        {demoButton && <div className="mt-4 flex justify-center">{demoButton}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {demoButton && (
        <div className="flex justify-end">
          {demoButton}
        </div>
      )}
      <AnimatePresence>
        {positions.map((position) => {
          const isLong = position.side === "long";
          const cooldownRemaining = getCooldownRemaining(position);
          const tickerConfig = tickers.find(t => t.ticker === position.ticker);
          const isBlocked = tickerConfig?.enabled === false;
          const hasTTP = position.ttp_exit_price != null;
          const isTtpInputOpen = !!ttpInputOpen[position.id];
          const isMonitoring = !!monitoring[position.id];
          const live = liveState[position.id];

          return (
            <motion.div
              key={position.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -100 }}
              className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 hover:bg-slate-800/70 transition-colors"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-xl font-bold text-white">{position.ticker}</span>
                  <span className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                    isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                  )}>
                    {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {position.side.toUpperCase()}
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  {format(new Date(position.created_date), "MMM d, HH:mm")}
                </span>
              </div>

              {/* Position stats */}
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <p className="text-xs text-slate-500 uppercase mb-1">Quantity</p>
                  <p className="font-mono font-bold text-white text-sm">{position.quantity}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase mb-1">Avg Entry</p>
                  <p className="font-mono font-bold text-white text-sm">
                    ${position.avg_entry_price ? Number(position.avg_entry_price).toFixed(2) : '—'}
                  </p>
                </div>
              </div>

              {position.notes && (
                <div className="mb-3 p-2 rounded-lg bg-slate-700/30">
                  <p className="text-xs text-slate-400">{position.notes}</p>
                </div>
              )}

              {/* TTP Exit SL status */}
              {hasTTP && (() => {
                const ttpPnl = calcTtpPnl(position, Number(position.ttp_exit_price));
                return (
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">
                      <Target className="w-3 h-3" />
                      TTP ${Number(position.ttp_exit_price).toFixed(2)} — SL Active
                    </span>
                    <span className={cn(
                      "text-[10px] font-mono font-bold",
                      ttpPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                    )}>
                      {ttpPnl >= 0 ? '+' : '-'}${Math.abs(ttpPnl).toFixed(2)}
                    </span>
                    <button
                      onClick={() => onClearTTP?.(position)}
                      className="text-[10px] text-slate-500 hover:text-red-400 transition-colors flex items-center gap-0.5"
                    >
                      <X className="w-3 h-3" /> Clear
                    </button>
                  </div>
                );
              })()}

              {/* Live spike-state panel */}
              {isMonitoring && (
                <div className="mb-3 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50 text-xs space-y-1.5">
                  {!live && (
                    <p className="text-slate-500 animate-pulse">Connecting to live monitor…</p>
                  )}
                  {live?.error && (
                    <p className="text-red-400">{live.error}</p>
                  )}
                  {live && !live.error && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className={cn(
                          "px-2 py-0.5 rounded text-[11px] font-bold border",
                          STATE_COLOR[live.state] || 'text-slate-400 bg-slate-700/30 border-slate-600/40'
                        )}>
                          {live.state}
                        </span>
                        <span className="font-mono text-slate-300">
                          {live.spike_pct != null ? `${live.spike_pct >= 0 ? '+' : ''}${live.spike_pct.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                      {live.fixed_tier && (
                        <p className="text-slate-500">
                          Tier: <span className="text-slate-300">{live.fixed_tier}</span>
                          {live.hwm_pct != null && (
                            <> &nbsp; HWM: <span className="text-slate-300">{live.hwm_pct.toFixed(1)}%</span>
                            &nbsp; Drawdown: <span className="text-slate-300">{live.hwm_drawdown?.toFixed(1)}%</span></>
                          )}
                        </p>
                      )}
                      {live.price_velocity != null && (
                        <p className="text-slate-500">
                          Velocity: <span className="text-slate-300">{live.price_velocity >= 0 ? '+' : ''}{live.price_velocity.toFixed(4)}$/min</span>
                          &nbsp; Vol: <span className="text-slate-300">{live.volume_velocity?.toFixed(2)}x avg</span>
                        </p>
                      )}
                      {live.term_class && live.term_class.n_total > 0 && (() => {
                        const tc = live.term_class;
                        const recov = ((tc.n_b + tc.n_c) / tc.n_total) * 100;
                        const flag = tc.n_total < 10 ? ' ⛔' : tc.n_total < 30 ? ' ⚠' : '';
                        return (
                          <p className="text-slate-500">
                            Historical @ {tc.tier} (n={tc.n_total}{flag}):
                            <span className="text-slate-300"> {recov.toFixed(0)}% recovery</span>
                            &nbsp; <span className="text-rose-400">{((tc.n_a / tc.n_total) * 100).toFixed(0)}% A</span>
                            &nbsp; <span className="text-emerald-400">{((tc.n_b / tc.n_total) * 100).toFixed(0)}% B</span>
                          </p>
                        );
                      })()}
                      {live.forward && (live.forward.prob_reach_next_tier > 0 || live.forward.prob_stop_hit > 0) && (
                        <p className="text-slate-500">
                          Reach next: <span className="text-slate-300">{live.forward.prob_reach_next_tier.toFixed(0)}%</span>
                          &nbsp; Stop hit: <span className="text-rose-400">{live.forward.prob_stop_hit.toFixed(0)}%</span>
                          &nbsp; Peak: <span className="text-slate-300">~{live.forward.median_time_to_peak_min.toFixed(0)}m</span>
                        </p>
                      )}
                      {live.action_verb && (
                        <p className={cn("font-semibold", ACTION_COLOR[live.action_verb] || 'text-slate-300')}>
                          {live.action_verb} — <span className="font-normal text-slate-400">{live.action_detail}</span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* TTP inline price input + percentage picker */}
              {isTtpInputOpen && (() => {
                const previewPrice = parseFloat(ttpInputValue[position.id]) || 0;
                const previewPnl = calcTtpPnl(position, previewPrice);
                return (
                <div className="mb-3 p-3 rounded-lg bg-slate-900/50 border border-amber-500/30 space-y-3">
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>-50%</span>
                    <span className={cn(
                      "font-mono font-bold",
                      (ttpPercent[position.id] || 0) === 0 ? "text-slate-400" :
                        (ttpPercent[position.id] || 0) > 0 ? "text-emerald-400" : "text-rose-400"
                    )}>
                      {(ttpPercent[position.id] || 0) > 0 ? '+' : ''}{Number(ttpPercent[position.id] || 0).toFixed(2)}% from entry
                    </span>
                    <span>+50%</span>
                  </div>
                  <Slider
                    value={[ttpPercent[position.id] || 0]}
                    min={-50}
                    max={50}
                    step={0.1}
                    onValueChange={(v) => handleTtpPercentChange(position, v[0])}
                  />
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {[2, 5, 10, 20].map(pct => {
                      const isLong = position.side === "long";
                      const signed = isLong ? -pct : pct;
                      return (
                        <button
                          key={pct}
                          onClick={() => handleTtpPercentChange(position, signed)}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-slate-600/50 text-slate-400 hover:border-amber-500/50 hover:text-amber-400 transition-colors"
                        >
                          {signed > 0 ? '+' : ''}{signed}%
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="w-24 bg-slate-800 border border-amber-500/40 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-amber-400"
                      value={ttpInputValue[position.id] || ''}
                      onChange={e => handleTtpPriceChange(position, e.target.value)}
                      placeholder="0.00"
                      onKeyDown={e => { if (e.key === 'Enter') handleSetTTP(position); if (e.key === 'Escape') closeTtpInput(position.id); }}
                    />
                    <button
                      onClick={() => handleSetTTP(position)}
                      className="text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors"
                    >
                      Set
                    </button>
                    <button
                      onClick={() => closeTtpInput(position.id)}
                      className="text-xs text-slate-500 hover:text-slate-400 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className={cn(
                    "text-xs font-mono font-bold text-center",
                    previewPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                  )}>
                    {previewPnl >= 0 ? 'Gain' : 'Loss'} if triggered: {previewPnl >= 0 ? '+' : '-'}${Math.abs(previewPnl).toFixed(2)}
                  </p>
                </div>
                );
              })()}

              {/* Action buttons */}
              <div className="space-y-2">
                {/* Live State toggle */}
                <Button
                  onClick={() => isMonitoring ? stopMonitor(position.id) : startMonitor(position.id)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "w-full transition-all",
                    isMonitoring
                      ? "border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/20"
                      : "border-slate-600/50 text-slate-400 hover:bg-slate-700/30"
                  )}
                >
                  <Activity className="w-4 h-4 mr-1" />
                  {isMonitoring ? 'Stop Momentum Live State' : 'Momentum Live State'}
                </Button>

                {/* Flatten */}
                <Button
                  onClick={() => handleMarkFlat(position)}
                  variant="outline"
                  size="sm"
                  disabled={cooldownRemaining > 0}
                  className={cn(
                    "w-full border-blue-500/50 text-blue-400 hover:bg-blue-500/20 transition-all",
                    cooldownRemaining > 0 && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Flag className="w-4 h-4 mr-1" />
                  {cooldownRemaining > 0 ? `Flatten (${cooldownRemaining}s)` : 'Flatten'}
                </Button>

                {/* TTP Exit SL button — only shown when TTP not already set and input not open */}
                {!hasTTP && !isTtpInputOpen && (
                  <Button
                    onClick={() => openTtpInput(position)}
                    variant="outline"
                    size="sm"
                    className="w-full border-amber-500/40 text-amber-400 hover:bg-amber-500/15 transition-all"
                  >
                    <Target className="w-4 h-4 mr-1" />
                    Set TTP Exit SL
                  </Button>
                )}

                {/* Block / Unblock signals */}
                <Button
                  onClick={() => isBlocked ? onUnblockSignals?.(position) : onBlockSignals?.(position)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "w-full transition-all duration-300",
                    isBlocked
                      ? "border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
                      : "border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                  )}
                >
                  {isBlocked ? (
                    <>
                      <Shield className="w-4 h-4 mr-1" />
                      Unblock Signals
                    </>
                  ) : (
                    <>
                      <ShieldOff className="w-4 h-4 mr-1" />
                      Block Signals
                    </>
                  )}
                </Button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
