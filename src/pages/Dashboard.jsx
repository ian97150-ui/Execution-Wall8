import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Layers, Send, History, Settings, X, 
  RefreshCw, Bell, Shield, TrendingUp
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

import SwipeDeck from "../components/trading/SwipeDeck";
import ExecutionQueue from "../components/trading/ExecutionQueue";
import AuditTimeline from "../components/trading/AuditTimeline";
import ExecutionModeToggle from "../components/trading/ExecutionModeToggle";
import StatsOverview from "../components/trading/StatsOverview";
import TickerList from "../components/trading/TickerList";
import LimitPriceEditor from "../components/trading/LimitPriceEditor";
import CandidatesList from "../components/trading/CandidatesList";
import PositionsList from "../components/trading/PositionsList";
import ErrorBoundary from "../components/ErrorBoundary";

const TradeIntent = base44.entities.TradeIntent;
const TickerConfig = base44.entities.TickerConfig;
const ExecutionSettings = base44.entities.ExecutionSettings;
const AuditLog = base44.entities.AuditLog;
const Position = base44.entities.Position;

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("candidates");
  const [editingIntent, setEditingIntent] = useState(null);
  const [limitEditorOpen, setLimitEditorOpen] = useState(false);
  const [viewMode, setViewMode] = useState("deck"); // "deck" or "list"
  
  const queryClient = useQueryClient();

  // Fetch settings
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const list = await ExecutionSettings.list();
      if (list.length === 0) {
        // Create default settings
        return await ExecutionSettings.create({
          setting_key: 'global',
          execution_mode: 'safe',
          default_delay_bars: 2,
          gate_threshold_default: 5,
          gates_total_default: 7,
          limit_edit_window_seconds: 120,
          limit_adjustment_max_percent: 2.0
        });
      }
      return list[0];
    }
  });

  // Fetch candidates (intents that are armed/eligible)
  const { data: candidates = [], isLoading: candidatesLoading, refetch: refetchCandidates } = useQuery({
    queryKey: ['candidates'],
    queryFn: async () => {
      const now = new Date().toISOString();
      const intents = await TradeIntent.filter({ 
        card_state: { $in: ['ARMED', 'ELIGIBLE', 'WAITING_DIP'] },
        status: { $in: ['pending', 'swiped_on', 'cancelled'] },
        expires_at: { $gt: now }
      }, '-created_date', 50);
      
      return intents;
    },
    enabled: !!settings,
    refetchInterval: 5000
  });

  // Fetch executions (both entry and exit intents)
  const { data: executions = [], refetch: refetchExecutions } = useQuery({
    queryKey: ['executions'],
    queryFn: () => {
      const now = new Date().toISOString();
      return TradeIntent.filter({ 
        card_state: 'EXECUTED',
        status: { $in: ['pending', 'executing', 'executed', 'cancelled', 'failed'] },
        expires_at: { $gt: now }
      }, '-created_date', 50);
    },
    refetchInterval: 3000
  });

  // Auto-execute when delay completes
  const forceExecuteMutation = useMutation({
    mutationFn: async (exec) => {
      const response = await base44.functions.invoke('inboundWebhook', {
        symbol: exec.ticker,
        action: exec.order_action,
        quantity: exec.quantity,
        limit_price: exec.limit_price
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Order executed');
    }
  });

  // Watch for completed delays and auto-execute
  useEffect(() => {
    if (settings?.execution_mode !== 'safe') return;
    
    const pendingExecs = executions.filter(e => e.status === 'pending' && e.delay_expires_at);
    const now = new Date();
    
    pendingExecs.forEach(exec => {
      const expiryTime = new Date(exec.delay_expires_at);
      
      if (now >= expiryTime) {
        // Delay complete - auto execute
        forceExecuteMutation.mutate(exec);
      }
    });
  }, [executions, settings?.execution_mode]);

  // Fetch ticker configs
  const { data: tickers = [], refetch: refetchTickers } = useQuery({
    queryKey: ['tickers'],
    queryFn: () => TickerConfig.list('-last_intent_at', 100)
  });

  // Fetch audit logs
  const { data: auditLogs = [] } = useQuery({
    queryKey: ['auditLogs'],
    queryFn: () => AuditLog.list('-created_date', 100),
    refetchInterval: 10000
  });

  // Fetch open positions
  const { data: positions = [], refetch: refetchPositions } = useQuery({
    queryKey: ['positions'],
    queryFn: () => Position.filter({ status: 'open' }, '-created_date', 100),
    refetchInterval: 5000
  });

  // Calculate stats
  const stats = React.useMemo(() => {
    const allIntents = [...candidates, ...executions];
    return {
      total_intents: allIntents.length,
      executed: executions.filter(e => e.status === 'executed').length,
      cancelled: executions.filter(e => e.status === 'cancelled').length,
      blocked: executions.filter(e => e.status === 'invalidated').length,
      pending: executions.filter(e => ['pending', 'executing'].includes(e.status)).length,
      avg_delay_seconds: 0
    };
  }, [candidates, executions]);

  // Mutations
  const updateSettingsMutation = useMutation({
    mutationFn: async (data) => {
      if (settings?.id) {
        await ExecutionSettings.update(settings.id, data);
        // Log mode change
        if (data.execution_mode) {
          await AuditLog.create({
            event_type: 'mode_change',
            previous_value: settings.execution_mode,
            new_value: data.execution_mode,
            execution_mode: data.execution_mode
          });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings updated');
    }
  });

  const swipeOnMutation = useMutation({
    mutationFn: async (intent) => {
      await TradeIntent.update(intent.id, { status: 'swiped_on' });
      
      // Ensure ticker config exists and is enabled
      const existing = tickers.find(t => t.ticker === intent.ticker);
      if (!existing) {
        await TickerConfig.create({ 
          ticker: intent.ticker, 
          enabled: true,
          last_intent_at: new Date().toISOString()
        });
      } else {
        await TickerConfig.update(existing.id, { 
          enabled: true,
          last_intent_at: new Date().toISOString()
        });
      }
      
      await AuditLog.create({
        event_type: 'swipe_on',
        ticker: intent.ticker,
        side: intent.side,
        intent_id: intent.id
      });

      // Send email notification
      if (settings?.email_notifications_enabled && settings?.notification_email) {
        try {
          await base44.integrations.Core.SendEmail({
            to: settings.notification_email,
            subject: `✅ Approved: ${intent.ticker} ${intent.dir}`,
            body: `
              <h2>Signal Approved</h2>
              <p><strong>Ticker:</strong> ${intent.ticker}</p>
              <p><strong>Direction:</strong> ${intent.dir}</p>
              <p><strong>Quality:</strong> ${intent.quality_tier} (${intent.quality_score}/100)</p>
              <p><strong>Limit Price:</strong> $${intent.limit_price || 'N/A'}</p>
              <p><em>Awaiting execution in ${settings.execution_mode} mode</em></p>
            `
          });
        } catch (error) {
          console.error('Email failed:', error);
        }
      }
      
      return intent.id;
    },
    onSuccess: (intentId) => {
      // Move the actioned card to the back of the deck
      queryClient.setQueryData(['candidates'], (old = []) => {
        const filtered = old.filter(i => i.id !== intentId);
        const actioned = old.find(i => i.id === intentId);
        return actioned ? [...filtered, actioned] : filtered;
      });
      
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Approved - awaiting execution');
    }
  });

  const swipeOffMutation = useMutation({
    mutationFn: async (intent) => {
      await TradeIntent.update(intent.id, { status: 'swiped_off' });
      
      // Disable ticker
      const existing = tickers.find(t => t.ticker === intent.ticker);
      if (existing) {
        await TickerConfig.update(existing.id, { 
          enabled: false,
          total_blocked: (existing.total_blocked || 0) + 1
        });
      } else {
        await TickerConfig.create({ 
          ticker: intent.ticker, 
          enabled: false,
          total_blocked: 1
        });
      }
      
      await AuditLog.create({
        event_type: 'swipe_off',
        ticker: intent.ticker,
        side: intent.dir,
        intent_id: intent.id
      });

      // Send email notification
            if (settings?.email_notifications_enabled && settings?.notification_email && settings?.notify_on_signal_rejected) {
              try {
                await base44.integrations.Core.SendEmail({
                  to: settings.notification_email,
                  subject: `🚫 Rejected: ${intent.ticker} ${intent.dir}`,
                  body: `
                    <h2>Signal Rejected</h2>
                    <p><strong>Ticker:</strong> ${intent.ticker}</p>
                    <p><strong>Direction:</strong> ${intent.dir}</p>
                    <p><strong>Quality:</strong> ${intent.quality_tier} (${intent.quality_score}/100)</p>
                    <p><em>Ticker disabled - no future signals will execute</em></p>
                  `
                });
              } catch (error) {
                console.error('Email failed:', error);
              }
            }
      
      return intent.id;
    },
    onSuccess: (intentId) => {
      // Move the actioned card to the back of the deck
      queryClient.setQueryData(['candidates'], (old = []) => {
        const filtered = old.filter(i => i.id !== intentId);
        const actioned = old.find(i => i.id === intentId);
        return actioned ? [...filtered, actioned] : filtered;
      });
      
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Ticker disabled');
    }
  });

  const denyOrderMutation = useMutation({
    mutationFn: async (intent) => {
      await TradeIntent.update(intent.id, { status: 'cancelled' });
      
      await AuditLog.create({
        event_type: 'cancelled',
        ticker: intent.ticker,
        side: intent.dir,
        intent_id: intent.id,
        details: { reason: 'Manually denied by user' }
      });
      
      return intent.id;
    },
    onSuccess: (intentId) => {
      // Remove denied card from deck
      queryClient.setQueryData(['candidates'], (old = []) => {
        return old.filter(i => i.id !== intentId);
      });
      
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Order denied');
    }
  });

  const toggleTickerMutation = useMutation({
    mutationFn: async ({ ticker, enabled }) => {
      const existing = tickers.find(t => t.ticker === ticker);
      if (existing) {
        await TickerConfig.update(existing.id, { enabled });
      }
      await AuditLog.create({
        event_type: 'ticker_toggle',
        ticker,
        new_value: enabled ? 'enabled' : 'disabled'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
    }
  });

  const saveLimitOverrideMutation = useMutation({
    mutationFn: async ({ intent, newPrice }) => {
      const existing = tickers.find(t => t.ticker === intent.ticker);
      const originalPrice = intent.limit_price;
      
      if (existing) {
        await TickerConfig.update(existing.id, {
          limit_price_override: newPrice,
          limit_override_expires: new Date(Date.now() + (settings?.limit_edit_window_seconds || 120) * 1000).toISOString(),
          limit_override_applied: false
        });
      }
      
      await AuditLog.create({
        event_type: 'limit_edit',
        ticker: intent.ticker,
        side: intent.dir,
        intent_id: intent.id,
        previous_value: String(originalPrice),
        new_value: String(newPrice),
        details: {
          original_price: originalPrice,
          new_price: newPrice,
          change_percent: ((newPrice - originalPrice) / originalPrice) * 100
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Limit price override applied');
    }
  });

  const cancelExecutionMutation = useMutation({
    mutationFn: async (exec) => {
      await TradeIntent.update(exec.id, { status: 'cancelled' });
      await AuditLog.create({
        event_type: 'cancelled',
        ticker: exec.ticker,
        side: exec.dir,
        intent_id: exec.id
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Execution cancelled');
    }
  });

  const retryExecutionMutation = useMutation({
    mutationFn: async (exec) => {
      // Reset retry count and status, then retry execution
      await TradeIntent.update(exec.id, { 
        status: 'pending',
        retry_count: 0,
        failure_reason: null
      });
      
      const response = await base44.functions.invoke('inboundWebhook', {
        symbol: exec.ticker,
        action: exec.order_action,
        quantity: exec.quantity,
        limit_price: exec.limit_price
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Retry initiated');
    },
    onError: () => {
      toast.error('Retry failed');
    }
  });

  const blockSignalsMutation = useMutation({
    mutationFn: async (position) => {
      const existing = tickers.find(t => t.ticker === position.ticker);
      
      // Calculate 1am next day
      const now = new Date();
      const nextDay1am = new Date();
      nextDay1am.setDate(now.getDate() + 1);
      nextDay1am.setHours(1, 0, 0, 0);
      
      if (existing) {
        await TickerConfig.update(existing.id, { 
          enabled: false,
          signals_blocked_until: nextDay1am.toISOString()
        });
      } else {
        await TickerConfig.create({ 
          ticker: position.ticker, 
          enabled: false,
          signals_blocked_until: nextDay1am.toISOString()
        });
      }

      // Close the position so it disappears from the list
      await Position.update(position.id, { status: 'closed' });

      await AuditLog.create({
        event_type: 'ticker_toggle',
        ticker: position.ticker,
        new_value: 'disabled',
        details: { 
          reason: 'Blocked from position management',
          blocked_until: nextDay1am.toISOString()
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Signals blocked until 1am tomorrow');
    }
  });

  const markFlatMutation = useMutation({
    mutationFn: async (position) => {
      const response = await base44.functions.invoke('markFlat', {
        ticker: position.ticker,
        dir: position.side === 'long' ? 'Long' : 'Short',
        tf: '2m',
        cooldown_minutes: 5
      });
      
      // Close the position in UI
      await Position.update(position.id, { status: 'closed' });

      // Send email notification
            if (settings?.email_notifications_enabled && settings?.notification_email && settings?.notify_on_position_closed) {
              try {
                await base44.integrations.Core.SendEmail({
                  to: settings.notification_email,
                  subject: `📍 Position Marked Flat: ${position.ticker}`,
                  body: `
                    <h2>Position Marked Flat</h2>
                    <p><strong>Ticker:</strong> ${position.ticker}</p>
                    <p><strong>Side:</strong> ${position.side}</p>
                    <p><strong>Quantity:</strong> ${position.quantity}</p>
                    <p><strong>Entry Price:</strong> $${position.avg_entry_price || 'N/A'}</p>
                    <p><strong>Cooldown:</strong> 5 minutes</p>
                    <p><em>Position manually closed - cooldown active</em></p>
                  `
                });
              } catch (error) {
                console.error('Email failed:', error);
              }
            }
      
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Position marked flat - 5 min cooldown active');
    }
  });



  // Check if limit edit is available for an intent
  const canEditLimit = useCallback((intent) => {
    if (!intent.limit_price) return false;
    const windowSeconds = settings?.limit_edit_window_seconds || 120;
    const createdAt = new Date(intent.created_date).getTime();
    const now = Date.now();
    return (now - createdAt) < (windowSeconds * 1000);
  }, [settings]);

  // Get remaining time for limit edit
  const getLimitEditTimeRemaining = useCallback((intent) => {
    if (!intent.limit_price) return 0;
    const windowSeconds = settings?.limit_edit_window_seconds || 120;
    const createdAt = new Date(intent.created_date).getTime();
    const expiresAt = createdAt + (windowSeconds * 1000);
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return remaining;
  }, [settings]);

  const handleEditLimit = (intent) => {
    setEditingIntent(intent);
    setLimitEditorOpen(true);
  };

  const handleSaveLimit = (intent, newPrice) => {
    saveLimitOverrideMutation.mutate({ intent, newPrice });
  };

  return (
    <ErrorBoundary>
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800">
        <div className="flex items-center justify-between px-4 h-16">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-white text-lg leading-tight">Execution Wall</h1>
              <p className="text-xs text-slate-500">Trade Firewall</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link to={createPageUrl("ExecutionHistory")}>
              <Button 
                variant="ghost" 
                size="icon"
                className="text-slate-400"
              >
                <History className="w-5 h-5" />
              </Button>
            </Link>

            <Link to={createPageUrl("Settings")}>
              <Button 
                variant="ghost" 
                size="icon"
                className="text-slate-400"
              >
                <Settings className="w-5 h-5" />
              </Button>
            </Link>

            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => {
                refetchCandidates();
                refetchExecutions();
              }}
              className="text-slate-400"
            >
              <RefreshCw className={cn("w-5 h-5", candidatesLoading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {/* Execution mode indicator */}
        <div className={cn(
          "h-1",
          settings?.execution_mode === 'off' ? "bg-red-500" :
          settings?.execution_mode === 'safe' ? "bg-amber-500" :
          "bg-emerald-500"
        )} />
      </header>

      {/* Main content */}
      <main className="pb-24">
        {/* Execution Mode Selector - Always Visible */}
        <div className="px-4 pt-3 md:pb-2 pb-8">
          <ExecutionModeToggle
            mode={settings?.execution_mode || 'safe'}
            onChange={(mode) => updateSettingsMutation.mutate({ execution_mode: mode })}
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsContent value="candidates" className="mt-0 h-[calc(100vh-240px)]">
            {/* View mode toggle */}
            <div className="flex justify-end gap-2 px-4 md:pt-4 pt-8 md:pb-2 pb-4">
              <button
                onClick={() => setViewMode("deck")}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-all",
                  viewMode === "deck" 
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/50"
                    : "bg-slate-800/50 text-slate-400 hover:text-slate-300"
                )}
              >
                Swipe
              </button>
              <button
                onClick={() => setViewMode("list")}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-all",
                  viewMode === "list" 
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/50"
                    : "bg-slate-800/50 text-slate-400 hover:text-slate-300"
                )}
              >
                Review All ({candidates.length})
              </button>
            </div>

            {viewMode === "deck" ? (
              <SwipeDeck
                intents={candidates}
                executions={executions}
                onSwipeOn={(intent) => swipeOnMutation.mutate(intent)}
                onSwipeOff={(intent) => swipeOffMutation.mutate(intent)}
                onDeny={(intent) => denyOrderMutation.mutate(intent)}
                onRefresh={refetchCandidates}
                isLoading={candidatesLoading}
                tickers={tickers}
              />
            ) : (
              <div className="px-4 pb-6 overflow-y-auto h-[calc(100vh-250px)] md:mt-0 mt-8">
                <CandidatesList
                  candidates={candidates}
                  onApprove={(intent) => swipeOnMutation.mutate(intent)}
                  onReject={(intent) => swipeOffMutation.mutate(intent)}
                  onDeny={(intent) => denyOrderMutation.mutate(intent)}
                  tickers={tickers}
                />
              </div>
            )}
          </TabsContent>

          <TabsContent value="executions" className="mt-0 px-4 py-6">
            <ExecutionQueue
              executions={executions}
              executionMode={settings?.execution_mode || 'safe'}
              onCancel={(exec) => cancelExecutionMutation.mutate(exec)}
              onForceExecute={(exec) => forceExecuteMutation.mutate(exec)}
              onRetry={(exec) => retryExecutionMutation.mutate(exec)}
              onEditLimit={handleEditLimit}
            />
          </TabsContent>

          <TabsContent value="positions" className="mt-0 px-4 py-6">
            <PositionsList
              positions={positions}
              onBlockSignals={(position) => blockSignalsMutation.mutate(position)}
              onMarkFlat={(position) => markFlatMutation.mutate(position)}
              tickers={tickers}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-0 px-4 py-6">
            <AuditTimeline logs={auditLogs} />
          </TabsContent>

          {/* Bottom navigation */}
          <div className="fixed bottom-0 left-0 right-0 bg-slate-950/90 backdrop-blur-xl border-t border-slate-800 z-50">
            <TabsList className="w-full h-20 bg-transparent grid grid-cols-4 gap-0 p-0 rounded-none">
              <TabsTrigger 
                value="candidates" 
                className={cn(
                  "flex flex-col items-center justify-center gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                  "data-[state=active]:text-blue-400 text-slate-500"
                )}
              >
                <Layers className="w-6 h-6" />
                <span className="text-xs font-medium">Candidates</span>
                {candidates.length > 0 && (
                  <span className="absolute top-2 right-1/2 translate-x-4 w-5 h-5 rounded-full bg-blue-500 text-white text-xs flex items-center justify-center font-bold">
                    {candidates.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="executions" 
                className={cn(
                  "flex flex-col items-center justify-center gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                  "data-[state=active]:text-emerald-400 text-slate-500"
                )}
              >
                <Send className="w-6 h-6" />
                <span className="text-xs font-medium">Executions</span>
                {stats.pending > 0 && (
                  <span className="absolute top-2 right-1/2 translate-x-4 w-5 h-5 rounded-full bg-emerald-500 text-emerald-950 text-xs flex items-center justify-center font-bold">
                    {stats.pending}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="positions" 
                className={cn(
                  "flex flex-col items-center justify-center gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                  "data-[state=active]:text-amber-400 text-slate-500"
                )}
              >
                <TrendingUp className="w-6 h-6" />
                <span className="text-xs font-medium">Positions</span>
                {positions.length > 0 && (
                  <span className="absolute top-2 right-1/2 translate-x-4 w-5 h-5 rounded-full bg-amber-500 text-amber-950 text-xs flex items-center justify-center font-bold">
                    {positions.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="history" 
                className={cn(
                  "flex flex-col items-center justify-center gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                  "data-[state=active]:text-purple-400 text-slate-500"
                )}
              >
                <History className="w-6 h-6" />
                <span className="text-xs font-medium">History</span>
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      </main>

      {/* Limit Price Editor Modal */}
      <LimitPriceEditor
        open={limitEditorOpen}
        onOpenChange={setLimitEditorOpen}
        intent={editingIntent}
        maxAdjustmentPercent={settings?.limit_adjustment_max_percent || 2}
        timeRemaining={editingIntent ? getLimitEditTimeRemaining(editingIntent) : 0}
        onSave={handleSaveLimit}
      />
    </div>
    </ErrorBoundary>
  );
}