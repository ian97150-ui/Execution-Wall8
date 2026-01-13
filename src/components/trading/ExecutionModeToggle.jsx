import React from 'react';
import { cn } from "@/lib/utils";
import { ShieldOff, ShieldCheck, Zap, Lock } from "lucide-react";

export default function ExecutionModeToggle({ mode, onChange, disabled = false }) {
  const modes = [
    { 
      value: "off", 
      label: "OFF", 
      icon: ShieldOff, 
      color: "bg-red-500",
      activeColor: "bg-red-500 text-white shadow-red-500/40",
      description: "All execution blocked"
    },
    { 
      value: "safe", 
      label: "SAFE", 
      icon: ShieldCheck, 
      color: "bg-amber-500",
      activeColor: "bg-amber-500 text-amber-950 shadow-amber-500/40",
      description: "Delay + validation enabled"
    },
    { 
      value: "full", 
      label: "FULL", 
      icon: Zap, 
      color: "bg-emerald-500",
      activeColor: "bg-emerald-500 text-emerald-950 shadow-emerald-500/40",
      description: "Immediate execution"
    }
  ];

  const currentIndex = modes.findIndex(m => m.value === mode);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Execution Mode</span>
        {disabled && <Lock className="w-3 h-3 text-slate-500" />}
      </div>
      
      <div className="relative bg-slate-800/60 rounded-xl p-1 flex gap-1">
        {/* Sliding background */}
        <div 
          className={cn(
            "absolute top-1 h-[calc(100%-8px)] rounded-lg transition-all duration-300 shadow-lg",
            modes[currentIndex]?.activeColor
          )}
          style={{ 
            width: `calc(${100/3}% - 4px)`,
            left: `calc(${currentIndex * (100/3)}% + 4px)`
          }}
        />
        
        {modes.map((m) => {
          const Icon = m.icon;
          const isActive = mode === m.value;
          
          return (
            <button
              key={m.value}
              onClick={() => !disabled && onChange(m.value)}
              disabled={disabled}
              className={cn(
                "relative z-10 flex-1 flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg transition-all duration-200",
                isActive 
                  ? "text-current" 
                  : "text-slate-500 hover:text-slate-300",
                disabled && "cursor-not-allowed opacity-50"
              )}
            >
              <Icon className={cn("w-4 h-4", isActive && "drop-shadow-sm")} />
              <span className="text-[10px] font-bold tracking-wide">{m.label}</span>
            </button>
          );
        })}
      </div>
      
      <p className="text-[10px] text-center text-slate-500 px-1">
        {modes.find(m => m.value === mode)?.description}
      </p>
    </div>
  );
}