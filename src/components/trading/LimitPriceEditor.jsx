import React, { useState, useEffect } from 'react';
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { AlertTriangle, Clock, TrendingUp, TrendingDown, Check, X } from "lucide-react";

export default function LimitPriceEditor({ 
  open, 
  onOpenChange, 
  intent, 
  maxAdjustmentPercent = 2,
  onSave,
  timeRemaining = 120
}) {
  const [adjustedPrice, setAdjustedPrice] = useState(intent?.limit_price || 0);
  const [percentChange, setPercentChange] = useState(0);

  const originalPrice = intent?.limit_price || 0;
  const minPrice = originalPrice * (1 - maxAdjustmentPercent / 100);
  const maxPrice = originalPrice * (1 + maxAdjustmentPercent / 100);
  
  const isLong = intent?.side === "long";

  useEffect(() => {
    if (intent?.limit_price) {
      setAdjustedPrice(intent.limit_price);
      setPercentChange(0);
    }
  }, [intent]);

  const handleSliderChange = (value) => {
    const pct = value[0];
    setPercentChange(pct);
    setAdjustedPrice(originalPrice * (1 + pct / 100));
  };

  const handlePriceChange = (e) => {
    const price = parseFloat(e.target.value) || 0;
    const clampedPrice = Math.max(minPrice, Math.min(maxPrice, price));
    setAdjustedPrice(clampedPrice);
    setPercentChange(((clampedPrice - originalPrice) / originalPrice) * 100);
  };

  const handleSave = () => {
    onSave?.(intent, adjustedPrice);
    onOpenChange(false);
  };

  const formatPrice = (price) => {
    if (!price || price === undefined || price === null) return "0.00";
    return Number(price).toLocaleString('en-US', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 4 
    });
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  if (!intent) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-white">
            <span className="text-2xl font-black">{intent.ticker}</span>
            <span className={cn(
              "px-2 py-0.5 rounded text-xs font-bold",
              isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
            )}>
              {intent.side?.toUpperCase()}
            </span>
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Adjust limit entry price within ±{maxAdjustmentPercent}%
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Timer warning */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
            <div className="flex items-center gap-2 text-amber-400">
              <Clock className="w-4 h-4" />
              <span className="text-sm font-medium">Edit window expires in</span>
            </div>
            <span className="font-mono font-bold text-amber-300">{formatTime(timeRemaining)}</span>
          </div>

          {/* Original vs Adjusted */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-800/50 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Original</p>
              <p className="text-xl font-mono font-bold text-slate-400">${formatPrice(originalPrice)}</p>
            </div>
            <div className={cn(
              "rounded-xl p-4 text-center border-2",
              percentChange === 0 
                ? "bg-slate-800/50 border-slate-700"
                : percentChange > 0 
                  ? "bg-emerald-500/10 border-emerald-500/50"
                  : "bg-rose-500/10 border-rose-500/50"
            )}>
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Adjusted</p>
              <p className="text-xl font-mono font-bold text-white">${formatPrice(adjustedPrice)}</p>
            </div>
          </div>

          {/* Price input */}
          <div className="space-y-2">
            <label className="text-xs text-slate-400 uppercase tracking-wider">
              Limit Price
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">$</span>
              <Input
                type="number"
                step="0.01"
                value={adjustedPrice ? Number(adjustedPrice).toFixed(4) : "0.0000"}
                onChange={handlePriceChange}
                className="pl-8 text-lg font-mono bg-slate-800 border-slate-700 text-white h-12"
              />
            </div>
          </div>

          {/* Slider */}
          <div className="space-y-4">
            <div className="flex justify-between text-xs text-slate-500">
              <span>-{maxAdjustmentPercent}%</span>
              <span className={cn(
                "font-mono font-bold",
                percentChange === 0 
                  ? "text-slate-400"
                  : percentChange > 0 
                    ? "text-emerald-400"
                    : "text-rose-400"
              )}>
                {percentChange > 0 ? '+' : ''}{Number(percentChange).toFixed(2)}%
              </span>
              <span>+{maxAdjustmentPercent}%</span>
            </div>
            <Slider
              value={[percentChange]}
              min={-maxAdjustmentPercent}
              max={maxAdjustmentPercent}
              step={0.01}
              onValueChange={handleSliderChange}
              className="[&_[role=slider]]:bg-white"
            />
          </div>

          {/* Safety notice */}
          <div className="flex items-start gap-2 p-3 rounded-xl bg-slate-800/50 text-slate-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              This adjustment applies <strong>once</strong> to the next eligible execution only. 
              The original strategy limit will resume after.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            onClick={() => onOpenChange(false)}
            variant="outline"
            className="flex-1 h-12 border-slate-700 text-slate-400"
          >
            <X className="w-4 h-4 mr-2" />
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="flex-1 h-12 bg-blue-500 hover:bg-blue-600 text-white font-bold"
          >
            <Check className="w-4 h-4 mr-2" />
            Apply Override
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}