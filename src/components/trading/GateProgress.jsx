import React from 'react';
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function GateProgress({ gatesOpen, gatesTotal, gateDetails = [], showDetails = false }) {
  const percentage = (gatesOpen / gatesTotal) * 100;
  
  const getProgressColor = () => {
    if (percentage >= 85) return "bg-emerald-500";
    if (percentage >= 70) return "bg-lime-500";
    if (percentage >= 50) return "bg-amber-500";
    return "bg-red-500";
  };

  const getTextColor = () => {
    if (percentage >= 85) return "text-emerald-400";
    if (percentage >= 70) return "text-lime-400";
    if (percentage >= 50) return "text-amber-400";
    return "text-red-400";
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Gate Status</span>
        <span className={cn("text-sm font-bold", getTextColor())}>
          {gatesOpen}/{gatesTotal}
        </span>
      </div>
      
      {/* Progress bar */}
      <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden">
        <div 
          className={cn("h-full rounded-full transition-all duration-500", getProgressColor())}
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Gate dots */}
      {showDetails && gateDetails.length > 0 && (
        <div className="flex gap-1 mt-3">
          <TooltipProvider>
            {gateDetails.map((gate, idx) => (
              <Tooltip key={idx}>
                <TooltipTrigger>
                  <div 
                    className={cn(
                      "w-6 h-6 rounded-md flex items-center justify-center transition-all",
                      gate.open 
                        ? "bg-emerald-500/20 text-emerald-400" 
                        : "bg-red-500/20 text-red-400"
                    )}
                  >
                    {gate.open ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" />
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="bg-slate-800 border-slate-700">
                  <p className="font-medium">{gate.name}</p>
                  {!gate.open && gate.reason && (
                    <p className="text-xs text-slate-400 mt-1">{gate.reason}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}