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
import {
  AlertTriangle, Clock, TrendingUp, TrendingDown, Check, X,
  DollarSign, Hash, Save
} from "lucide-react";

/**
 * ExecutionEditor - Enhanced editor for exit orders
 * Supports both price AND quantity adjustments
 */
export default function ExecutionEditor({
  open,
  onOpenChange,
  execution,
  position,           // Linked position (for exits)
  isExit = false,
  maxAdjustmentPercent = 2,
  onSave,
  timeRemaining = 120
}) {
  const originalPrice = parseFloat(execution?.limit_price) || 0;
  const originalQty = execution?.quantity || 1;
  const positionQty = position?.quantity || originalQty;

  const [adjustedPrice, setAdjustedPrice] = useState(originalPrice);
  const [adjustedQty, setAdjustedQty] = useState(originalQty);
  const [pricePercent, setPricePercent] = useState(0);

  // Price adjustment bounds
  const minPrice = originalPrice * (1 - maxAdjustmentPercent / 100);
  const maxPrice = originalPrice * (1 + maxAdjustmentPercent / 100);

  // Quantity bounds (for exits, max is position quantity)
  const minQty = 1;
  const maxQty = isExit ? positionQty : originalQty * 2;

  const isLong = execution?.dir === "Long";

  useEffect(() => {
    if (execution) {
      const price = parseFloat(execution.limit_price) || 0;
      setAdjustedPrice(price);
      setAdjustedQty(execution.quantity || 1);
      setPricePercent(0);
    }
  }, [execution?.id]);

  const handlePriceSlider = (value) => {
    const percent = value[0];
    setPricePercent(percent);
    const newPrice = originalPrice * (1 + percent / 100);
    setAdjustedPrice(Number(newPrice.toFixed(4)));
  };

  const handlePriceInput = (e) => {
    const value = parseFloat(e.target.value) || 0;
    const clamped = Math.max(minPrice, Math.min(maxPrice, value));
    setAdjustedPrice(clamped);
    if (originalPrice > 0) {
      const percent = ((clamped - originalPrice) / originalPrice) * 100;
      setPricePercent(percent);
    }
  };

  const handleQtyInput = (e) => {
    const value = parseInt(e.target.value) || 1;
    const clamped = Math.max(minQty, Math.min(maxQty, value));
    setAdjustedQty(clamped);
  };

  const handleSave = () => {
    onSave?.({
      execution,
      newPrice: adjustedPrice,
      newQuantity: adjustedQty
    });
    onOpenChange(false);
  };

  const priceChanged = Math.abs(adjustedPrice - originalPrice) > 0.0001;
  const qtyChanged = adjustedQty !== originalQty;
  const hasChanges = priceChanged || qtyChanged;

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

  if (!execution) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-white">
            {isExit ? (
              <AlertTriangle className="w-5 h-5 text-amber-400" />
            ) : (
              <DollarSign className="w-5 h-5 text-emerald-400" />
            )}
            <span className="text-2xl font-black">{execution.ticker}</span>
            <span className={cn(
              "px-2 py-0.5 rounded text-xs font-bold",
              isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
            )}>
              {isExit ? 'EXIT' : execution.dir?.toUpperCase()}
            </span>
            {isExit && (
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-500/20 text-orange-400">
                {execution.order_action?.toUpperCase()}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {isExit
              ? "Adjust exit order price and quantity"
              : `Adjust limit entry price within ±${maxAdjustmentPercent}%`
            }
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Position Context (for exits) */}
          {isExit && position && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <p className="text-xs text-amber-400 uppercase tracking-wider mb-1">Closing Position</p>
              <p className="text-sm text-white">
                {position.side} {position.quantity} shares @ ${formatPrice(position.entry_price)}
              </p>
            </div>
          )}

          {/* Timer warning */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
            <div className="flex items-center gap-2 text-amber-400">
              <Clock className="w-4 h-4" />
              <span className="text-sm font-medium">Edit window expires in</span>
            </div>
            <span className="font-mono font-bold text-amber-300">{formatTime(timeRemaining)}</span>
          </div>

          {/* Original vs Adjusted Price */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-800/50 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Original Price</p>
              <p className="text-xl font-mono font-bold text-slate-400">${formatPrice(originalPrice)}</p>
            </div>
            <div className={cn(
              "rounded-xl p-4 text-center border-2",
              !priceChanged
                ? "bg-slate-800/50 border-slate-700"
                : pricePercent > 0
                  ? "bg-emerald-500/10 border-emerald-500/50"
                  : "bg-rose-500/10 border-rose-500/50"
            )}>
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Adjusted Price</p>
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
                onChange={handlePriceInput}
                className="pl-8 text-lg font-mono bg-slate-800 border-slate-700 text-white h-12"
              />
            </div>
          </div>

          {/* Price Slider */}
          <div className="space-y-4">
            <div className="flex justify-between text-xs text-slate-500">
              <span>-{maxAdjustmentPercent}%</span>
              <span className={cn(
                "font-mono font-bold",
                pricePercent === 0
                  ? "text-slate-400"
                  : pricePercent > 0
                    ? "text-emerald-400"
                    : "text-rose-400"
              )}>
                {pricePercent > 0 ? '+' : ''}{Number(pricePercent).toFixed(2)}%
              </span>
              <span>+{maxAdjustmentPercent}%</span>
            </div>
            <Slider
              value={[pricePercent]}
              min={-maxAdjustmentPercent}
              max={maxAdjustmentPercent}
              step={0.01}
              onValueChange={handlePriceSlider}
              className="[&_[role=slider]]:bg-white"
            />
          </div>

          {/* Quantity Editor (always shown for exits, optional for entries) */}
          {(isExit || true) && (
            <div className="space-y-3">
              <label className="text-xs text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <Hash className="w-3 h-3" />
                Quantity
              </label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Input
                    type="number"
                    value={adjustedQty}
                    onChange={handleQtyInput}
                    min={minQty}
                    max={maxQty}
                    step="1"
                    className="text-lg font-mono bg-slate-800 border-slate-700 text-white h-12"
                  />
                </div>
                <div className="text-sm text-slate-500">
                  <span className="text-slate-400">Original: </span>
                  <span className="font-mono">{originalQty}</span>
                </div>
              </div>
              {isExit && adjustedQty < positionQty && adjustedQty > 0 && (
                <p className="text-xs text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Partial exit: {positionQty - adjustedQty} shares will remain in position
                </p>
              )}
              {isExit && (
                <p className="text-xs text-slate-500">
                  Max quantity: {positionQty} (full position)
                </p>
              )}
            </div>
          )}

          {/* Safety notice */}
          <div className="flex items-start gap-2 p-3 rounded-xl bg-slate-800/50 text-slate-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              {isExit
                ? "This adjustment will update the exit order sent to the broker. Changes are final."
                : "This adjustment applies once to the next eligible execution only. The original strategy limit will resume after."
              }
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
            disabled={!hasChanges}
            className={cn(
              "flex-1 h-12 font-bold",
              hasChanges
                ? "bg-emerald-500 hover:bg-emerald-600 text-white"
                : "bg-slate-700 text-slate-400 cursor-not-allowed"
            )}
          >
            <Save className="w-4 h-4 mr-2" />
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
