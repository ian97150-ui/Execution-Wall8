import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { 
  ArrowLeft, Save, Clock, Shield, Sliders, 
  Webhook, Bell, BarChart3, AlertTriangle, Info, Zap, Plus, Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

import ExecutionModeToggle from "../components/trading/ExecutionModeToggle";

const ExecutionSettings = base44.entities.ExecutionSettings;

export default function Settings() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const list = await ExecutionSettings.list();
      if (list.length === 0) {
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

  const [formData, setFormData] = useState(null);

  React.useEffect(() => {
    if (settings && !formData) {
      setFormData({
        execution_mode: settings.execution_mode || 'safe',
        default_delay_bars: settings.default_delay_bars || 2,
        gate_threshold_default: settings.gate_threshold_default || 5,
        gates_total_default: settings.gates_total_default || 7,
        limit_edit_window_seconds: settings.limit_edit_window_seconds || 120,
        limit_adjustment_max_percent: settings.limit_adjustment_max_percent || 2.0,
        broker_webhook_url: settings.broker_webhook_url || '',
        bypass_enabled: settings.bypass_enabled || false,
        bypass_intervals: settings.bypass_intervals || [],
        email_notifications_enabled: settings.email_notifications_enabled !== false,
        notification_email: settings.notification_email || '',
        notify_on_signal_approved: settings.notify_on_signal_approved !== false,
        notify_on_signal_rejected: settings.notify_on_signal_rejected || false,
        notify_on_entry_executed: settings.notify_on_entry_executed !== false,
        notify_on_exit_executed: settings.notify_on_exit_executed !== false,
        notify_on_position_closed: settings.notify_on_position_closed !== false,
        notify_on_high_quality: settings.notify_on_high_quality !== false
      });
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      if (settings?.id) {
        await ExecutionSettings.update(settings.id, data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved');
    },
    onError: () => {
      toast.error('Failed to save settings');
    }
  });

  const validateSettings = () => {
    const errors = [];

    // Email validation
    if (formData.email_notifications_enabled && formData.notification_email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.notification_email)) {
        errors.push('Invalid email address');
      }
    }

    // Bypass intervals validation
    if (formData.bypass_enabled && formData.bypass_intervals?.length > 0) {
      formData.bypass_intervals.forEach((interval, idx) => {
        if (interval.start_time >= interval.end_time) {
          errors.push(`Bypass interval ${idx + 1}: Start time must be before end time`);
        }
      });
    }

    // Numeric validations
    if (formData.limit_adjustment_max_percent < 0.1 || formData.limit_adjustment_max_percent > 10) {
      errors.push('Max adjustment percent must be between 0.1% and 10%');
    }

    if (formData.limit_edit_window_seconds < 30 || formData.limit_edit_window_seconds > 600) {
      errors.push('Edit window must be between 30 and 600 seconds');
    }

    if (formData.gate_threshold_default > formData.gates_total_default) {
      errors.push('Gate threshold cannot exceed total gates');
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
                  {formData.gate_threshold_default} / {formData.gates_total_default}
                </span>
              </div>
              <Slider
                value={[formData.gate_threshold_default]}
                min={1}
                max={formData.gates_total_default}
                step={1}
                onValueChange={(v) => setFormData(f => ({ ...f, gate_threshold_default: v[0] }))}
                className="[&_[role=slider]]:bg-emerald-400"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">Total Gates</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={formData.gates_total_default}
                onChange={(e) => setFormData(f => ({ 
                  ...f, 
                  gates_total_default: parseInt(e.target.value) || 7,
                  gate_threshold_default: Math.min(f.gate_threshold_default, parseInt(e.target.value) || 7)
                }))}
                className="bg-slate-800 border-slate-700 text-white"
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
                  value={formData.limit_edit_window_seconds}
                  onChange={(e) => setFormData(f => ({ ...f, limit_edit_window_seconds: parseInt(e.target.value) || 120 }))}
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
                  value={formData.limit_adjustment_max_percent}
                  onChange={(e) => setFormData(f => ({ ...f, limit_adjustment_max_percent: parseFloat(e.target.value) || 2 }))}
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

        {/* Bypass Mode Configuration */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Zap className="w-5 h-5 text-orange-400" />
              Bypass Mode
            </CardTitle>
            <CardDescription className="text-slate-400">
              Configure time-based instant execution windows
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50">
              <div>
                <Label className="text-slate-300">Enable Bypass Mode</Label>
                <p className="text-xs text-slate-500 mt-1">
                  Bypass delays during configured time intervals
                </p>
              </div>
              <Switch
                checked={formData.bypass_enabled}
                onCheckedChange={(checked) => setFormData(f => ({ ...f, bypass_enabled: checked }))}
              />
            </div>

            {formData.bypass_enabled && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-slate-300">Time Intervals</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setFormData(f => ({
                      ...f,
                      bypass_intervals: [
                        ...(f.bypass_intervals || []),
                        { start_time: "09:30", end_time: "16:00", enabled: true }
                      ]
                    }))}
                    className="border-slate-700 text-slate-300"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add Interval
                  </Button>
                </div>

                {(formData.bypass_intervals || []).map((interval, index) => (
                  <div key={index} className="flex items-center gap-2 p-3 rounded-lg bg-slate-800/50">
                    <Input
                      type="time"
                      value={interval.start_time}
                      onChange={(e) => {
                        const newIntervals = [...formData.bypass_intervals];
                        newIntervals[index].start_time = e.target.value;
                        setFormData(f => ({ ...f, bypass_intervals: newIntervals }));
                      }}
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                    <span className="text-slate-500">to</span>
                    <Input
                      type="time"
                      value={interval.end_time}
                      onChange={(e) => {
                        const newIntervals = [...formData.bypass_intervals];
                        newIntervals[index].end_time = e.target.value;
                        setFormData(f => ({ ...f, bypass_intervals: newIntervals }));
                      }}
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                    <Switch
                      checked={interval.enabled}
                      onCheckedChange={(checked) => {
                        const newIntervals = [...formData.bypass_intervals];
                        newIntervals[index].enabled = checked;
                        setFormData(f => ({ ...f, bypass_intervals: newIntervals }));
                      }}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        const newIntervals = formData.bypass_intervals.filter((_, i) => i !== index);
                        setFormData(f => ({ ...f, bypass_intervals: newIntervals }));
                      }}
                      className="text-red-400 hover:text-red-300"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}

                {formData.bypass_intervals?.length === 0 && (
                  <p className="text-xs text-slate-500 text-center py-4">
                    No intervals configured. Add time windows when bypass mode should activate.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-500/10 border border-orange-500/30">
              <Info className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
              <p className="text-xs text-orange-300">
                During bypass intervals, executions forward immediately to broker regardless of the execution mode setting.
              </p>
            </div>
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
                checked={formData.email_notifications_enabled}
                onCheckedChange={(checked) => setFormData(f => ({ ...f, email_notifications_enabled: checked }))}
              />
            </div>

            {formData.email_notifications_enabled && (
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
                      <span className="text-sm text-slate-300">Signal Approved</span>
                      <Switch
                        checked={formData.notify_on_signal_approved}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_signal_approved: checked }))}
                      />
                    </div>
                    
                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Signal Rejected</span>
                      <Switch
                        checked={formData.notify_on_signal_rejected}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_signal_rejected: checked }))}
                      />
                    </div>
                    
                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Entry Order Executed</span>
                      <Switch
                        checked={formData.notify_on_entry_executed}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_entry_executed: checked }))}
                      />
                    </div>
                    
                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Exit Order Executed</span>
                      <Switch
                        checked={formData.notify_on_exit_executed}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_exit_executed: checked }))}
                      />
                    </div>
                    
                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">Position Marked Flat</span>
                      <Switch
                        checked={formData.notify_on_position_closed}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_position_closed: checked }))}
                      />
                    </div>
                    
                    <div className="flex items-center justify-between p-2 rounded bg-slate-800/30">
                      <span className="text-sm text-slate-300">High Quality Signals (A+/A)</span>
                      <Switch
                        checked={formData.notify_on_high_quality}
                        onCheckedChange={(checked) => setFormData(f => ({ ...f, notify_on_high_quality: checked }))}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* TradingView Webhook URL */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Webhook className="w-5 h-5 text-emerald-400" />
              TradingView Webhook URL
            </CardTitle>
            <CardDescription className="text-slate-400">
              Configure this URL in TradingView alerts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Your Webhook URL</Label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/functions/inboundWebhook`}
                  className="bg-slate-800 border-slate-700 text-emerald-400 font-mono text-sm"
                />
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/functions/inboundWebhook`);
                    toast.success('Webhook URL copied!');
                  }}
                  variant="outline"
                  className="border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
                >
                  Copy
                </Button>
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
              <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-xs text-emerald-300 space-y-1">
                <p className="font-medium">Use this single URL for all TradingView alerts:</p>
                <ul className="list-disc list-inside space-y-0.5 ml-2">
                  <li>WALL events (signal quality)</li>
                  <li>ORDER events (executions)</li>
                  <li>EXIT events (position closes)</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Zapier Webhook URL */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Webhook className="w-5 h-5 text-orange-400" />
              Zapier Webhook URL
            </CardTitle>
            <CardDescription className="text-slate-400">
              Use this URL in Zapier "Webhooks by Zapier" actions
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Zapier Webhook URL</Label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/functions/zapier`}
                  className="bg-slate-800 border-slate-700 text-orange-400 font-mono text-sm"
                />
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/functions/zapier`);
                    toast.success('Zapier URL copied!');
                  }}
                  variant="outline"
                  className="border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                >
                  Copy
                </Button>
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-500/10 border border-orange-500/30">
              <Info className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
              <div className="text-xs text-orange-300 space-y-2">
                <p className="font-medium">Supported Actions:</p>
                <div className="space-y-1.5 ml-2">
                  <div>
                    <p className="font-semibold">1. Send Order</p>
                    <code className="text-[10px] bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {`{"action": "send_order", "data": {"symbol": "TSLA", "action": "buy", "quantity": 100}}`}
                    </code>
                  </div>
                  <div>
                    <p className="font-semibold">2. Create Trade Intent</p>
                    <code className="text-[10px] bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {`{"action": "create_trade_intent", "data": {"ticker": "AAPL", "dir": "Long"}}`}
                    </code>
                  </div>
                  <div>
                    <p className="font-semibold">3. Log Data</p>
                    <code className="text-[10px] bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {`{"action": "log", "data": {...}}`}
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Broker Webhook Configuration */}
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Webhook className="w-5 h-5 text-blue-400" />
              Broker Webhook
            </CardTitle>
            <CardDescription className="text-slate-400">
              Endpoint for forwarding approved orders
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Broker Webhook URL</Label>
              <Input
                type="url"
                placeholder="https://api.signalstack.com/webhook/..."
                value={formData.broker_webhook_url}
                onChange={(e) => setFormData(f => ({ ...f, broker_webhook_url: e.target.value }))}
                className="bg-slate-800 border-slate-700 text-white font-mono text-sm"
              />
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                Approved orders will be forwarded to this URL with the original payload,
                optionally modified with limit price overrides.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}