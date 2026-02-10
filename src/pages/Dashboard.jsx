import React, { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  Layers, Send, History, Settings, X,
  RefreshCw, Bell, Shield, TrendingUp, Webhook, ScrollText
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
import ExecutionEditor from "../components/trading/ExecutionEditor";
import CandidatesList from "../components/trading/CandidatesList";
import PositionsList from "../components/trading/PositionsList";
import BlockedTickersList from "../components/trading/BlockedTickersList";
import ErrorBoundary from "../components/ErrorBoundary";

// Import new REST API client
import api from "@/api/apiClient";

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("candidates");
  const [editingIntent, setEditingIntent] = useState(null);
  const [limitEditorOpen, setLimitEditorOpen] = useState(false);
  const [executionEditorOpen, setExecutionEditorOpen] = useState(false);
  const [editingExecution, setEditingExecution] = useState(null);
  const [editingPosition, setEditingPosition] = useState(null);
  const [viewMode, setViewMode] = useState("deck"); // "deck" or "list"

  const queryClient = useQueryClient();

  // Fetch settings
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      try {
        const response = await api.get('/settings');
        return response.data;
      } catch (error) {
        // If no settings exist, create default
        if (error.response?.status === 404) {
          const createResponse = await api.post('/settings', {
            execution_mode: 'safe',
            default_delay_bars: 2,
            gate_threshold: 5,
            limit_edit_window: 120,
            max_adjustment_pct: 2.0
          });
          return createResponse.data;
        }
        throw error;
      }
    }
  });

  // Fetch candidates (intents that are armed/eligible)
  const { data: candidates = [], isLoading: candidatesLoading, refetch: refetchCandidates } = useQuery({
    queryKey: ['candidates'],
    queryFn: async () => {
      const response = await api.get('/trade-intents', {
        params: {
          card_state: 'ARMED,ELIGIBLE,WAITING_DIP',
          status: 'pending,swiped_on'
        }
      });
      // Filter out expired intents, then sort so pending cards come first (swiped_on at the back)
      const now = new Date();
      const valid = (response.data || []).filter(intent => new Date(intent.expires_at) > now);
      return valid.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        return new Date(b.created_date || b.created_at) - new Date(a.created_date || a.created_at);
      });
    },
    enabled: !!settings,
    refetchInterval: 5000
  });

  // Fetch blocked intents (swiped_off status - for revive section)
  // Don't filter by expiry - show all blocked cards from today for potential revival
  const { data: blockedIntents = [], refetch: refetchBlockedIntents } = useQuery({
    queryKey: ['blockedIntents'],
    queryFn: async () => {
      const response = await api.get('/trade-intents', {
        params: {
          status: 'swiped_off'
        }
      });
      // Only show cards blocked today (within last 24 hours)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return (response.data || []).filter(intent => new Date(intent.created_date) > oneDayAgo);
    },
    enabled: !!settings,
    refetchInterval: 10000
  });

  // Fetch executions from the Execution table (only pending/executing - active queue)
  const { data: executions = [], refetch: refetchExecutions } = useQuery({
    queryKey: ['executions'],
    queryFn: async () => {
      const response = await api.get('/executions', {
        params: { status: 'pending,executing' }
      });
      return response.data || [];
    },
    refetchInterval: 3000
  });

  // Force execute an order
  const forceExecuteMutation = useMutation({
    mutationFn: async (exec) => {
      const response = await api.post(`/executions/${exec.id}/execute`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Order executed');
    }
  });

  // Note: Auto-execute on delay expiry is now handled by backend scheduler
  // This ensures orders execute even when browser is closed

  // Fetch ticker configs
  const { data: tickers = [], refetch: refetchTickers } = useQuery({
    queryKey: ['tickers'],
    queryFn: async () => {
      const response = await api.get('/ticker-configs');
      return response.data || [];
    }
  });

  // Fetch audit logs
  const { data: auditLogs = [] } = useQuery({
    queryKey: ['auditLogs'],
    queryFn: async () => {
      const response = await api.get('/audit-logs', {
        params: { limit: 100 }
      });
      // Parse details if it's a string
      return (response.data || []).map(log => ({
        ...log,
        details: typeof log.details === 'string' ? JSON.parse(log.details) : log.details
      }));
    },
    refetchInterval: 10000
  });

  // Fetch open positions
  const { data: positions = [], refetch: refetchPositions } = useQuery({
    queryKey: ['positions'],
    queryFn: async () => {
      const response = await api.get('/positions', {
        params: { open_only: true }
      });
      return response.data || [];
    },
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
      const response = await api.put('/settings', data);
      return response.data;
    },
    onMutate: async (newData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['settings'] });

      // Snapshot the previous value
      const previousSettings = queryClient.getQueryData(['settings']);

      // Optimistically update to the new value
      queryClient.setQueryData(['settings'], (old) => ({
        ...old,
        ...newData
      }));

      // Return context with the previous value
      return { previousSettings };
    },
    onError: (err, newData, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      queryClient.setQueryData(['settings'], context.previousSettings);
      toast.error('Failed to update settings');
    },
    onSuccess: () => {
      toast.success('Settings updated');
    },
    onSettled: () => {
      // Always refetch after error or success
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    }
  });

  const swipeOnMutation = useMutation({
    mutationFn: async (intent) => {
      // Backend handles ticker config update and audit log creation
      await api.post(`/trade-intents/${intent.id}/swipe`, { action: 'approve' });
      return intent.id;
    },
    onSuccess: (intentId) => {
      // Move approved card to back of deck so user sees the next card
      // It drops off on next refetch since swiped_on is excluded from the query
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
      // Backend handles ticker config update, other intent invalidation, and audit log
      await api.post(`/trade-intents/${intent.id}/swipe`, { action: 'off' });
      return intent.id;
    },
    onSuccess: (intentId) => {
      // Remove the card from candidates list (it's now blocked)
      queryClient.setQueryData(['candidates'], (old = []) => {
        return old.filter(i => i.id !== intentId);
      });

      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['blockedIntents'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Ticker disabled - moved to blocked');
    }
  });

  const denyOrderMutation = useMutation({
    mutationFn: async (intent) => {
      // Backend handles audit log creation
      await api.post(`/trade-intents/${intent.id}/swipe`, { action: 'deny' });
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
      // Backend handles audit log creation
      await api.put(`/ticker-configs/${ticker}`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
    }
  });

  const saveLimitOverrideMutation = useMutation({
    mutationFn: async ({ intent, newPrice }) => {
      const originalPrice = intent.limit_price;

      // Update the execution's limit_price directly so broker gets the new price
      await api.put(`/executions/${intent.id}`, {
        limit_price: newPrice
      });

      await api.post('/audit-logs', {
        event_type: 'limit_edit',
        ticker: intent.ticker,
        details: JSON.stringify({
          execution_id: intent.id,
          side: intent.dir,
          previous_value: String(originalPrice),
          new_value: String(newPrice),
          original_price: originalPrice,
          new_price: newPrice,
          change_percent: ((newPrice - originalPrice) / originalPrice) * 100
        })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Limit price updated - broker will receive new price');
    }
  });

  // Save execution edits (price AND quantity) - for enhanced exit order editing
  const saveExecutionMutation = useMutation({
    mutationFn: async ({ execution, newPrice, newQuantity }) => {
      const updateData = {};
      if (newPrice !== undefined) updateData.limit_price = newPrice;
      if (newQuantity !== undefined) updateData.quantity = newQuantity;

      await api.put(`/executions/${execution.id}`, updateData);

      // Log the edit
      await api.post('/audit-logs', {
        event_type: 'execution_edited',
        ticker: execution.ticker,
        details: JSON.stringify({
          execution_id: execution.id,
          order_type: execution.order_type,
          price_change: newPrice !== undefined ? {
            from: execution.limit_price,
            to: newPrice
          } : null,
          quantity_change: newQuantity !== undefined ? {
            from: execution.quantity,
            to: newQuantity
          } : null
        })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Execution updated');
    }
  });

  const cancelExecutionMutation = useMutation({
    mutationFn: async (exec) => {
      await api.post(`/executions/${exec.id}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Execution cancelled');
    }
  });

  // Approve an execution's linked intent (for safe mode)
  const approveExecutionMutation = useMutation({
    mutationFn: async (exec) => {
      if (!exec.intent_id) {
        throw new Error('No linked intent to approve');
      }
      await api.post(`/trade-intents/${exec.intent_id}/swipe`, { action: 'approve' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Order approved - will execute shortly');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to approve order');
    }
  });

  const retryExecutionMutation = useMutation({
    mutationFn: async (exec) => {
      // Re-execute the order
      const response = await api.post(`/executions/${exec.id}/execute`);
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

  // Create demo execution for testing the approval flow
  const createDemoMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/executions/demo');
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['executions'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Demo execution created - try the Approve button!');
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create demo');
    }
  });

  // Create demo WALL card for testing
  const createDemoWallMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/trade-intents/demo');
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success(`Demo WALL card created: ${data.intent.ticker}`);
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create demo');
    }
  });

  const blockSignalsMutation = useMutation({
    mutationFn: async (position) => {
      // Calculate 1am next day
      const now = new Date();
      const nextDay1am = new Date();
      nextDay1am.setDate(now.getDate() + 1);
      nextDay1am.setHours(1, 0, 0, 0);

      const existing = tickers.find(t => t.ticker === position.ticker);
      if (existing) {
        await api.put(`/ticker-configs/${position.ticker}`, {
          enabled: false,
          blocked_until: nextDay1am.toISOString()
        });
      } else {
        await api.post('/ticker-configs', {
          ticker: position.ticker,
          enabled: false,
          blocked_until: nextDay1am.toISOString()
        });
      }

      // Close the position
      await api.post(`/positions/${position.id}/mark-flat`);

      await api.post('/audit-logs', {
        event_type: 'ticker_toggle',
        ticker: position.ticker,
        details: JSON.stringify({
          new_value: 'disabled',
          reason: 'Blocked from position management',
          blocked_until: nextDay1am.toISOString()
        })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Signals blocked until 1am tomorrow');
    }
  });

  const unblockSignalsMutation = useMutation({
    mutationFn: async (position) => {
      await api.put(`/ticker-configs/${position.ticker}`, {
        enabled: true,
        blocked_until: null
      });

      await api.post('/audit-logs', {
        event_type: 'ticker_toggle',
        ticker: position.ticker,
        details: JSON.stringify({
          new_value: 'enabled',
          reason: 'Unblocked from position management'
        })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Signals unblocked for this ticker');
    }
  });

  const markFlatMutation = useMutation({
    mutationFn: async (position) => {
      const response = await api.post(`/positions/${position.id}/mark-flat`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Position marked flat - 5 min cooldown active');
    }
  });

  // Revive a blocked ticker (move back to candidates)
  const reviveTickerMutation = useMutation({
    mutationFn: async (intent) => {
      // Use the 'revive' action which resets status to 'pending' and enables ticker
      await api.post(`/trade-intents/${intent.id}/swipe`, { action: 'revive' });
      return intent.id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['blockedIntents'] });
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Ticker revived - moved back to candidates');
    }
  });

  // Block wall alerts for a ticker (until next daily reset)
  const blockWallAlertsMutation = useMutation({
    mutationFn: async (ticker) => {
      await api.put(`/ticker-configs/${ticker}`, {
        alerts_blocked: true
      });

      await api.post('/audit-logs', {
        event_type: 'wall_alerts_blocked',
        ticker: ticker,
        details: JSON.stringify({
          reason: 'User blocked wall alerts until next daily reset'
        })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Wall alerts blocked until next daily reset');
    },
    onError: () => {
      toast.error('Failed to block alerts');
    }
  });

  // Unblock wall alerts for a ticker
  const unblockAlertsMutation = useMutation({
    mutationFn: async (ticker) => {
      await api.put(`/ticker-configs/${ticker}`, {
        alerts_blocked: false
      });

      await api.post('/audit-logs', {
        event_type: 'wall_alerts_unblocked',
        ticker: ticker,
        details: JSON.stringify({
          reason: 'User unblocked wall alerts'
        })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickers'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['auditLogs'] });
      toast.success('Wall alerts unblocked');
    },
    onError: () => {
      toast.error('Failed to unblock alerts');
    }
  });

  // Calculate edit window from delay settings (delay_bars × bar_duration × 60)
  const getEditWindowSeconds = useCallback(() => {
    const delayBars = settings?.default_delay_bars || 2;
    const barDuration = settings?.bar_duration_minutes || 1;
    return delayBars * barDuration * 60; // Convert to seconds
  }, [settings]);

  // Check if limit edit is available for an intent
  const canEditLimit = useCallback((intent) => {
    if (!intent.limit_price) return false;
    const windowSeconds = getEditWindowSeconds();
    const createdAt = new Date(intent.created_date).getTime();
    const now = Date.now();
    return (now - createdAt) < (windowSeconds * 1000);
  }, [settings, getEditWindowSeconds]);

  // Get remaining time for limit edit
  const getLimitEditTimeRemaining = useCallback((intent) => {
    if (!intent.limit_price) return 0;
    const windowSeconds = getEditWindowSeconds();
    const createdAt = new Date(intent.created_date).getTime();
    const expiresAt = createdAt + (windowSeconds * 1000);
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return remaining;
  }, [settings, getEditWindowSeconds]);

  const handleEditLimit = async (exec) => {
    // Check if this is an exit order
    const isExit = exec.order_type === 'exit' ||
      (exec.raw_payload && JSON.parse(exec.raw_payload).event === 'EXIT');

    if (isExit) {
      // Fetch execution with position context for exit orders
      try {
        const response = await api.get(`/executions/${exec.id}/with-position`);
        const { execution, position, isExit: confirmedExit } = response.data;
        setEditingExecution(execution);
        setEditingPosition(position);
        setExecutionEditorOpen(true);
      } catch (error) {
        console.error('Failed to fetch position context:', error);
        // Fallback to basic editing
        setEditingExecution(exec);
        setEditingPosition(null);
        setExecutionEditorOpen(true);
      }
    } else {
      // Use legacy LimitPriceEditor for entry orders
      setEditingIntent(exec);
      setLimitEditorOpen(true);
    }
  };

  const handleSaveLimit = (intent, newPrice) => {
    saveLimitOverrideMutation.mutate({ intent, newPrice });
  };

  const handleSaveExecution = ({ execution, newPrice, newQuantity }) => {
    saveExecutionMutation.mutate({ execution, newPrice, newQuantity });
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
              <Link to={createPageUrl("AuditLog")}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-slate-400"
                  title="Audit Log"
                >
                  <ScrollText className="w-5 h-5" />
                </Button>
              </Link>

              <Link to={createPageUrl("WebhookLogs")}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-slate-400"
                  title="Webhook Logs"
                >
                  <Webhook className="w-5 h-5" />
                </Button>
              </Link>

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
            <TabsContent value="candidates" className="mt-0 overflow-y-auto" style={{ height: 'calc(100vh - 240px)' }}>
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
                <button
                  onClick={() => setViewMode("blocked")}
                  className={cn(
                    "px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    viewMode === "blocked"
                      ? "bg-red-500/20 text-red-400 border border-red-500/50"
                      : "bg-slate-800/50 text-slate-400 hover:text-slate-300",
                    blockedIntents.length === 0 && "opacity-50"
                  )}
                  disabled={blockedIntents.length === 0}
                >
                  Blocked ({blockedIntents.length})
                </button>
              </div>

              {viewMode === "deck" && (
                <SwipeDeck
                  intents={candidates}
                  executions={executions}
                  onSwipeOn={(intent) => swipeOnMutation.mutate(intent)}
                  onSwipeOff={(intent) => swipeOffMutation.mutate(intent)}
                  onDeny={(intent) => denyOrderMutation.mutate(intent)}
                  onBlockAlerts={(intent) => blockWallAlertsMutation.mutate(intent.ticker)}
                  onUnblockAlerts={(intent) => unblockAlertsMutation.mutate(intent.ticker)}
                  isBlockingAlerts={blockWallAlertsMutation.isPending || unblockAlertsMutation.isPending}
                  onRefresh={refetchCandidates}
                  isLoading={candidatesLoading}
                  tickers={tickers}
                  tradingviewChartId={settings?.tradingview_chart_id}
                  onCreateDemo={() => createDemoWallMutation.mutate()}
                  isDemoLoading={createDemoWallMutation.isPending}
                />
              )}

              {viewMode === "list" && (
                <div className="px-4 pb-6 md:mt-0 mt-8">
                  <CandidatesList
                    candidates={candidates}
                    onApprove={(intent) => swipeOnMutation.mutate(intent)}
                    onReject={(intent) => swipeOffMutation.mutate(intent)}
                    onDeny={(intent) => denyOrderMutation.mutate(intent)}
                    onBlockAlerts={(intent) => blockWallAlertsMutation.mutate(intent.ticker)}
                    onUnblockAlerts={(intent) => unblockAlertsMutation.mutate(intent.ticker)}
                    isBlockingAlerts={blockWallAlertsMutation.isPending || unblockAlertsMutation.isPending}
                    tickers={tickers}
                    tradingviewChartId={settings?.tradingview_chart_id}
                  />
                </div>
              )}

              {viewMode === "blocked" && (
                <div className="px-4 pb-6 md:mt-0 mt-8">
                  <BlockedTickersList
                    blockedIntents={blockedIntents}
                    onRevive={(intent) => reviveTickerMutation.mutate(intent)}
                    onBlockWallAlerts={(ticker) => blockWallAlertsMutation.mutate(ticker)}
                    onUnblockAlerts={(ticker) => unblockAlertsMutation.mutate(ticker)}
                    isLoading={reviveTickerMutation.isPending}
                    isBlockingAlerts={blockWallAlertsMutation.isPending || unblockAlertsMutation.isPending}
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
                onApprove={(exec) => approveExecutionMutation.mutate(exec)}
                onRetry={(exec) => retryExecutionMutation.mutate(exec)}
                onEditLimit={handleEditLimit}
                onCreateDemo={() => createDemoMutation.mutate()}
                isDemoLoading={createDemoMutation.isPending}
              />
            </TabsContent>

            <TabsContent value="positions" className="mt-0 px-4 py-6">
              <PositionsList
                positions={positions}
                onBlockSignals={(position) => blockSignalsMutation.mutate(position)}
                onUnblockSignals={(position) => unblockSignalsMutation.mutate(position)}
                onMarkFlat={(position) => markFlatMutation.mutate(position)}
                tickers={tickers}
              />
            </TabsContent>

            <TabsContent value="history" className="mt-0 px-4 py-6">
              <AuditTimeline logs={auditLogs} />
            </TabsContent>

            {/* Bottom navigation */}
            <div className="fixed bottom-0 left-0 right-0 bg-slate-950/90 backdrop-blur-xl border-t border-slate-800 z-50 safe-area-pb">
              <TabsList className="w-full h-16 sm:h-20 bg-transparent grid grid-cols-4 gap-0 p-0 rounded-none">
                <TabsTrigger
                  value="candidates"
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 sm:gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                    "data-[state=active]:text-blue-400 text-slate-500"
                  )}
                >
                  <Layers className="w-5 h-5 sm:w-6 sm:h-6" />
                  <span className="text-[10px] sm:text-xs font-medium">Candidates</span>
                  {candidates.length > 0 && (
                    <span className="absolute top-1 sm:top-2 right-1/2 translate-x-3 sm:translate-x-4 w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-blue-500 text-white text-[10px] sm:text-xs flex items-center justify-center font-bold">
                      {candidates.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="executions"
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 sm:gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                    "data-[state=active]:text-emerald-400 text-slate-500"
                  )}
                >
                  <Send className="w-5 h-5 sm:w-6 sm:h-6" />
                  <span className="text-[10px] sm:text-xs font-medium">Executions</span>
                  {stats.pending > 0 && (
                    <span className="absolute top-1 sm:top-2 right-1/2 translate-x-3 sm:translate-x-4 w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-emerald-500 text-emerald-950 text-[10px] sm:text-xs flex items-center justify-center font-bold">
                      {stats.pending}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="positions"
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 sm:gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                    "data-[state=active]:text-amber-400 text-slate-500"
                  )}
                >
                  <TrendingUp className="w-5 h-5 sm:w-6 sm:h-6" />
                  <span className="text-[10px] sm:text-xs font-medium">Positions</span>
                  {positions.length > 0 && (
                    <span className="absolute top-1 sm:top-2 right-1/2 translate-x-3 sm:translate-x-4 w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-amber-500 text-amber-950 text-[10px] sm:text-xs flex items-center justify-center font-bold">
                      {positions.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 sm:gap-1 h-full rounded-none data-[state=active]:bg-transparent",
                    "data-[state=active]:text-purple-400 text-slate-500"
                  )}
                >
                  <History className="w-5 h-5 sm:w-6 sm:h-6" />
                  <span className="text-[10px] sm:text-xs font-medium">History</span>
                </TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
        </main>

        {/* Limit Price Editor Modal (for entry orders) */}
        <LimitPriceEditor
          open={limitEditorOpen}
          onOpenChange={setLimitEditorOpen}
          intent={editingIntent}
          maxAdjustmentPercent={settings?.max_adjustment_pct || 2}
          timeRemaining={editingIntent ? getLimitEditTimeRemaining(editingIntent) : 0}
          onSave={handleSaveLimit}
        />

        {/* Execution Editor Modal (for exit orders - supports price AND quantity) */}
        <ExecutionEditor
          open={executionEditorOpen}
          onOpenChange={setExecutionEditorOpen}
          execution={editingExecution}
          position={editingPosition}
          isExit={editingExecution?.order_type === 'exit'}
          maxAdjustmentPercent={settings?.max_adjustment_pct || 2}
          timeRemaining={editingExecution ? getLimitEditTimeRemaining(editingExecution) : 0}
          onSave={handleSaveExecution}
        />
      </div>
    </ErrorBoundary>
  );
}
