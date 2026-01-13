import React from 'react';
import { cn } from "@/lib/utils";
import { Clock, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

export default function DelayProgress({ intent, status = "waiting" }) {
  const [remainingTime, setRemainingTime] = React.useState(0);

  React.useEffect(() => {
    if (status !== "waiting" || !intent?.delay_expires_at) return;
    
    const interval = setInterval(() => {
      const expiry = new Date(intent.delay_expires_at).getTime();
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((expiry - now) / 1000));
      setRemainingTime(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [status, intent?.delay_expires_at]);

  const totalSeconds = intent?.delay_seconds || 120;
  const progress = totalSeconds > 0 ? ((totalSeconds - remainingTime) / totalSeconds) * 100 : 0;

  const statusConfig = {
    waiting: { 
      icon: Clock, 
      color: "text-amber-400", 
      label: "Delay timer active"
    },
    confirmed: { 
      icon: CheckCircle2, 
      color: "text-emerald-400", 
      label: "Ready for execution"
    },
    invalidated: { 
      icon: XCircle, 
      color: "text-red-400", 
      label: "Signal invalidated"
    },
    expired: { 
      icon: AlertTriangle, 
      color: "text-slate-400", 
      label: "Trade expired"
    }
  };

  const config = statusConfig[status] || statusConfig.waiting;
  const StatusIcon = config.icon;

  const formatTime = (seconds) => {
    if (seconds <= 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className={cn(
      "p-3 rounded-lg border transition-all",
      status === "waiting" ? "bg-amber-500/10 border-amber-500/30" : 
      status === "confirmed" ? "bg-emerald-500/10 border-emerald-500/30" : 
      status === "invalidated" ? "bg-red-500/10 border-red-500/30" : 
      "bg-slate-800/50 border-slate-700"
    )}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <StatusIcon className={cn("w-4 h-4", config.color)} />
          <span className={cn("text-sm font-medium", config.color)}>
            {config.label}
          </span>
        </div>
        {status === "waiting" && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-mono font-bold text-white">
              {formatTime(remainingTime)}
            </span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {status === "waiting" && (
        <div className="mt-2">
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div 
              className="h-full bg-amber-500 transition-all duration-1000 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}