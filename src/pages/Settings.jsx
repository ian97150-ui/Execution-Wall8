import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import {
  ArrowLeft, Save, Clock, Shield, Sliders,
  Webhook, Bell, BarChart3, AlertTriangle, Info, Zap, Plus, Trash2,
  ExternalLink, Send
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

import ExecutionModeToggle from "../components/trading/ExecutionModeToggle";
import api from "@/api/apiClient";

// Get the backend API URL
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export default function Settings() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
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

  const [formData, setFormData] = useState(null);

  React.useEffect(() => {
    if (settings && !formData) {
      setFormData({
        execution_mode: settings.execution_mode || 'safe',
        default_delay_bars: settings.default_delay_bars || 2,
        gate_threshold: settings.gate_threshold || 5,
        limit_edit_window: settings.limit_edit_window || 120,
        max_adjustment_pct: settings.max_adjustment_pct || 2.0,
        broker_webhook_url: settings.broker_webhook_url || '',
        broker_webhook_enabled: settings.broker_webhook_enabled || false,
        email_notifications: settings.email_notifications || false,
        notification_email: settings.notification_email || '',
        notify_on_order_received: settings.notify_on_order_received !== false,
        notify_on_approval: settings.notify_on_approval !== false,
        notify_on_execution: settings.notify_on_execution !== false,
        notify_on_close: settings.notify_on_close !== false
      });
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      const response = await api.put('/settings', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved');
    },
    onError: () => {
      toast.error('Failed to save settings');
    }
  });

  const testBrokerMutation = useMutation({
    mutationFn: async (url) => {
      const response = await api.post('/settings/test-broker-webhook', { url });
      return response.data;
    },
    onSuccess: () => {
      toast.success('Broker webhook test successful!');
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Broker webhook test failed');
    }
  });

  const validateSettings = () => {
    const errors = [];

    // Email validation
    if (formData.email_notifications && formData.notification_email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.notification_email)) {
        errors.push('Invalid email address');
      }
    }

    // Broker webhook URL validation
    if (formData.broker_webhook_enabled && formData.broker_webhook_url) {
      try {
        new URL(formData.broker_webhook_url);
      } catch {
        errors.push('Invalid broker webhook URL');
      }
    }

    // Numeric validations
    if (formData.max_adjustment_pct < 0.1 || formData.max_adjustment_pct > 10) {
      errors.push('Max adjustment percent must be between 0.1% and 10%');
    }

    if (formData.limit_edit_window < 30 || formData.limit_edit_window > 600) {
      errors.push('Edit window must be between 30 and 600 seconds');
    }

    return errors;
  };

  const handleSave = () => {
    if (!formData) return;

    const errors = validateSettings();
    if (errors.length > 0) {
      errors.forEach(error => toast.error(error));
      return;
    }

    updateMutation.mutate(formData);
  };

  if (isLoading || !formData) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="animate-pulse text-slate-500">Loading...</div>
      </div>
    );
  }

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
            <h1 className="font-bold text-white text-lg">Settings</h1>
          </div>
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="bg-blue-500 hover:bg-blue-600"
          >
            <Save className="w-4 h-4 mr-2" />
            Save
          </Button>
        </div>
      </header>

      <main className="p-4 space-y-6 max-w-2xl mx-auto pb-8">
        {/* Execution Mode */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Shield className="w-5 h-5 text-blue-400" />
              Execution Mode
            </CardTitle>
            <CardDescription className="text-slate-400">
              Control how trades are processed
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExecutionModeToggle
              mode={formData.execution_mode}
              onChange={(mode) => setFormData(f => ({ ...f, execution_mode: mode }))}
            />
          </CardContent>
        </Card>

        {/* Delay Settings */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Clock className="w-5 h-5 text-amber-400" />
              Delay Configuration
            </CardTitle>
            <CardDescription className="text-slate-400">
              Bar-based persistence delay before execution
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-slate-300">Default Delay Bars</Label>
                <span className="text-lg font-bold text-white font-mono">
                  {formData.default_delay_bars}
                </span>
              </div>
              <Slider
                value={[formData.default_delay_bars]}
                min={0}
                max={10}
                step={1}
                onValueChange={(v) => setFormData(f => ({ ...f, default_delay_bars: v[0] }))}
                className="[&_[role=slider]]:bg-amber-400"
              />
              <p className="text-xs text-slate-500">
                Number of bars to wait before executing a trade
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Gate Threshold */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <BarChart3 className="w-5 h-5 text-emerald-400" />
              Gate Configuration
            </CardTitle>
            <CardDescription className="text-slate-400">
              Minimum gates required to show in candidate deck
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-slate-300">Gate Threshold</Label>
                <span className="text-lg font-bold text-white">
                  {formData.gate_threshold}
                </span>
              </div>
              <Slider
                value={[formData.gate_threshold]}
                min={1}
                max={10}
                step={1}
                onValueChange={(v) => setFormData(f => ({ ...f, gate_threshold: v[0] }))}
                className="[&_[role=slider]]:bg-emerald-400"
              />
            </div>
          </CardContent>
        </Card>

        {/* Limit Edit Settings */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Sliders className="w-5 h-5 text-purple-400" />
              Limit Price Editing
            </CardTitle>
            <CardDescription className="text-slate-400">
              Configure the limit price adjustment window
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Edit Window (seconds)</Label>
                <Input
                  type="number"
                  min={30}
                  max={600}
                  value={formData.limit_edit_window}
                  onChange={(e) => setFormData(f => ({ ...f, limit_edit_window: parseInt(e.target.value) || 120 }))}
                  className="bg-slate-800 border-slate-700 text-white"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Max Adjustment (%)</Label>
                <Input
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={formData.max_adjustment_pct}
                  onChange={(e) => setFormData(f => ({ ...f, max_adjustment_pct: parseFloat(e.target.value) || 2 }))}
                  className="bg-slate-800 border-slate-700 text-white"
                />
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
              <Info className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
              <p className="text-xs text-purple-300">
                Limit edits are one-time overrides that apply to the next execution only.
                The original strategy limit resumes after the override is used.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Broker Webhook */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Send className="w-5 h-5 text-orange-400" />
              Broker Webhook
            </CardTitle>
            <CardDescription className="text-slate-400">
              Forward approved orders to your broker via webhook
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50">
              <div>
                <Label className="text-slate-300">Enable Broker Webhook</Label>
                <p className="text-xs text-slate-500 mt-1">
                  Orders will be forwarded to your broker when executed
                </p>
              </div>
              <Switch
                checked={formData.broker_webhook_enabled}
                onCheckedChange={(checked) => setFormData(f => ({ ...f, broker_webhook_enabled: checked }))}
              />
            </div>

            {formData.broker_webhook_enabled && (
              <>
                <div className="space-y-2">
                  <Label className="text-slate-300">Broker Webhook URL</Label>
                  <div className="flex gap-2">
                    <Input
                      type="url"
                      placeholder="https://your-broker.com/webhook"
                      value={formData.broker_webhook_url}
                      onChange={(e) => setFormData(f => ({ ...f, broker_webhook_url: e.target.value }))}
                      className="bg-slate-800 border-slate-700 text-white"
                    />
                    <Button
                      onClick={() => testBrokerMutation.mutate(formData.broker_webhook_url)}
                      disabled={!formData.broker_webhook_url || testBrokerMutation.isPending}
                      variant="outline"
                      className="border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                    >
                      {testBrokerMutation.isPending ? 'Testing...' : 'Test'}
                    </Button>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-orange-500/10 border border-orange-500/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-orange-400" />
                    <span className="text-xs font-semibold text-orange-300">Order Payload Format</span>
                  </div>
                  <pre className="bg-slate-800/50 p-2 rounded text-[10px] text-orange-200 overflow-x-auto">
{`{
  "symbol": "AAPL",
  "action": "buy",
  "quantity": 100,
  "limit_price": 150.25
}`}
                  </pre>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Email Notifications */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Bell className="w-5 h-5 text-blue-400" />
              Email Notifications
            </CardTitle>
            <CardDescription className="text-slate-400">
              Receive alerts for execution requests
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50">
              <div>
                <Label className="text-slate-300">Enable Email Notifications</Label>
                <p className="text-xs text-slate-500 mt-1">
                  Get notified when execution requests are awaiting approval
                </p>
              </div>
              <Switch
                checked={formData.email_notifications}
                onCheckedChange={(checked) => setFormData(f => ({ ...f, email_notifications: checked }))}
              />
            </div>

            {formData.email_notifications && (
              <>
                <div className="space-y-2">
                  <Label className="text-slate-300">Notification Email</Label>
                  <Input
                    type="email"
                    placeholder="your@email.com"
                    value={formData.notification_email}
                    onChange={(e) => setFormData(f => ({ ...f, notification_email: e.target.value }))}
                    className="bg-slate-800 border-slate-700 text-white"
                  />
                </div>

                <div className="space-y-3 pt-2">
                  <Label className="text-slate-300">Event Preferences</Label>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Order Received</span>
                      <Switch
                        checked={formData.notify_on_order_received}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_order_received: checked }))}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Signal Approved</span>
                      <Switch
                        checked={formData.notify_on_approval}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_approval: checked }))}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Order Executed</span>
                      <Switch
                        checked={formData.notify_on_execution}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_execution: checked }))}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Position Closed</span>
                      <Switch
                        checked={formData.notify_on_close}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_close: checked }))}
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-700">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const response = await api.post('/settings/test-email');
                        if (response.data.success) {
                          toast.success(response.data.message);
                        } else {
                          toast.error(response.data.error || 'Test email failed');
                        }
                      } catch (err) {
                        const errorMsg = err.response?.data?.error || err.message || 'Failed to send test email';
                        toast.error(errorMsg);
                      }
                    }}
                    className="w-full border-blue-500/50 text-blue-400 hover:bg-blue-500/20"
                  >
                    Send Test Email
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Unified Webhook URL */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Webhook className="w-5 h-5 text-emerald-400" />
              Webhook URL
            </CardTitle>
            <CardDescription className="text-slate-400">
              Single endpoint for all TradingView signals (WALL, ORDER, EXIT)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Your Webhook URL</Label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  readOnly
                  value={`${API_BASE_URL.replace('/api', '')}/api/webhook`}
                  className="bg-slate-800 border-slate-700 text-emerald-400 font-mono text-sm"
                />
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(`${API_BASE_URL.replace('/api', '')}/api/webhook`);
                    toast.success('Webhook URL copied!');
                  }}
                  variant="outline"
                  className="border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
                >
                  Copy
                </Button>
              </div>
            </div>

            {/* Signal Types */}
            <div className="space-y-3">
              {/* WALL Signal */}
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-4 h-4 text-blue-400" />
                  <span className="text-xs font-semibold text-blue-300">WALL Signal (Candidate Cards)</span>
                </div>
                <p className="text-[10px] text-blue-200 mb-2">Creates a card for review with gate-based confidence scoring</p>
                <pre className="bg-slate-800/50 p-2 rounded text-[10px] text-blue-200 overflow-x-auto whitespace-pre-wrap">
{`{
  "event": "WALL",
  "ticker": "AAPL",
  "dir": "Short",
  "price": 189.34,
  "strategy_id": "scalper",
  "tf": "1m",
  "intent": {
    "dvtpShortTrig": false,
    "shortArmed": false,
    "testMode": "NEW_LOW"
  },
  "gates": {
    "rule2_Fire": true,
    "Ovr60": true,
    "gatedShort_1": true,
    "VolumeGate": true
  }
}`}
                </pre>
                <div className="mt-2 text-[9px] text-blue-300/80">
                  <p><strong>Gate Scoring:</strong> confidence = gates_hit / gates_total</p>
                  <p>Quality derived: A+ (90%+), A (80%+), B (70%+), C (60%+), D (&lt;60%)</p>
                </div>
              </div>

              {/* ORDER Signal */}
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-semibold text-emerald-300">ORDER Signal (Direct Execution)</span>
                </div>
                <p className="text-[10px] text-emerald-200 mb-2">Creates execution directly (bypasses review)</p>
                <pre className="bg-slate-800/50 p-2 rounded text-[10px] text-emerald-200 overflow-x-auto">
{`{
  "event": "ORDER",
  "ticker": "AAPL",
  "dir": "Long",
  "price": 150.50,
  "limit_price": 150.25,
  "quantity": 100
}`}
                </pre>
              </div>

              {/* EXIT Signal */}
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-300">EXIT Signal (Close Position)</span>
                </div>
                <p className="text-[10px] text-amber-200 mb-2">Creates exit order to close position</p>
                <pre className="bg-slate-800/50 p-2 rounded text-[10px] text-amber-200 overflow-x-auto">
{`{
  "event": "EXIT",
  "ticker": "AAPL",
  "dir": "Long",
  "price": 155.00,
  "quantity": 100
}`}
                </pre>
              </div>
            </div>

            <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-700/30 border border-slate-600/30">
              <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
              <div className="text-xs text-slate-300 space-y-1">
                <p><strong>Note:</strong> If no "event" is specified, signals default to WALL.</p>
                <p>Raw payloads are stored verbatim for replay, audits, and ML labeling.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Database Info */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <BarChart3 className="w-5 h-5 text-cyan-400" />
              Database Status
            </CardTitle>
            <CardDescription className="text-slate-400">
              Local SQLite database with 80 MB limit
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/30">
              <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
              <div className="text-xs text-cyan-300">
                <p>Your data is stored locally in a SQLite database.</p>
                <p className="mt-1">Automatic cleanup runs hourly to maintain the 80 MB size limit.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
