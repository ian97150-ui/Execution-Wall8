import React from 'react';
import { cn } from "@/lib/utils";
import { Sparkles, Star, TrendingUp, Minus } from "lucide-react";

export default function QualityBadge({ tier, score, size = "default" }) {
  const tierConfig = {
    "A+": { 
      bg: "bg-gradient-to-br from-amber-400 to-yellow-500", 
      text: "text-amber-950",
      icon: Sparkles,
      glow: "shadow-amber-500/30"
    },
    "A": { 
      bg: "bg-gradient-to-br from-emerald-400 to-green-500", 
      text: "text-emerald-950",
      icon: Star,
      glow: "shadow-emerald-500/30"
    },
    "B": { 
      bg: "bg-gradient-to-br from-blue-400 to-blue-500", 
      text: "text-blue-950",
      icon: TrendingUp,
      glow: "shadow-blue-500/30"
    },
    "C": { 
      bg: "bg-gradient-to-br from-slate-400 to-slate-500", 
      text: "text-slate-950",
      icon: Minus,
      glow: "shadow-slate-500/30"
    },
    "D": { 
      bg: "bg-gradient-to-br from-red-400 to-red-500", 
      text: "text-red-950",
      icon: Minus,
      glow: "shadow-red-500/30"
    }
  };

  const config = tierConfig[tier] || tierConfig["C"];
  const Icon = config.icon;

  const sizeClasses = size === "large" 
    ? "w-14 h-14 text-xl" 
    : "w-10 h-10 text-sm";

  return (
    <div className="flex flex-col items-center gap-1">
      <div 
        className={cn(
          "rounded-xl flex items-center justify-center font-black shadow-lg",
          config.bg,
          config.text,
          config.glow,
          sizeClasses
        )}
      >
        {tier}
      </div>
      {score !== undefined && (
        <span className="text-xs text-slate-500 font-medium">{score}/100</span>
      )}
    </div>
  );
}