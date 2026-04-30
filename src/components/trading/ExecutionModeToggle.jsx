import React, { useState, useEffect, useRef } from 'react';
import { cn } from "@/lib/utils";
import { ShieldOff, ShieldCheck, Zap, Lock, X } from "lucide-react";

function generateCode() {
  // 4-digit code using only digits 1–8
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 8) + 1).join('');
}

export default function ExecutionModeToggle({ mode, onChange, disabled = false }) {
  const modes = [
    {
      value: "off",
      label: "OFF",
      icon: ShieldOff,
      activeColor: "bg-red-500 text-white shadow-red-500/40",
      description: "All execution blocked"
    },
    {
      value: "safe",
      label: "SAFE",
      icon: ShieldCheck,
      activeColor: "bg-amber-500 text-amber-950 shadow-amber-500/40",
      description: "Delay + validation enabled"
    },
    {
      value: "full",
      label: "FULL",
      icon: Zap,
      activeColor: "bg-emerald-500 text-emerald-950 shadow-emerald-500/40",
      description: "Immediate execution"
    }
  ];

  const [pending, setPending] = useState(null);   // mode being confirmed
  const [code, setCode] = useState('');            // generated code
  const [input, setInput] = useState('');          // user's typed input
  const [error, setError] = useState(false);
  const inputRef = useRef(null);

  const currentIndex = modes.findIndex(m => m.value === mode);

  function requestChange(newMode) {
    if (disabled || newMode === mode) return;
    const generated = generateCode();
    setPending(newMode);
    setCode(generated);
    setInput('');
    setError(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function confirm() {
    if (input === code) {
      onChange(pending);
      cancel();
    } else {
      setError(true);
      setInput('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function cancel() {
    setPending(null);
    setCode('');
    setInput('');
    setError(false);
  }

  function handleKey(e) {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
    // Only allow digits 1–8
    if (e.key.length === 1 && !/[1-8]/.test(e.key)) e.preventDefault();
  }

  const pendingModeObj = modes.find(m => m.value === pending);

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
            width: `calc(${100 / 3}% - 4px)`,
            left: `calc(${currentIndex * (100 / 3)}% + 4px)`
          }}
        />

        {modes.map((m) => {
          const Icon = m.icon;
          const isActive = mode === m.value;
          return (
            <button
              key={m.value}
              onClick={() => requestChange(m.value)}
              disabled={disabled}
              className={cn(
                "relative z-10 flex-1 flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg transition-all duration-200",
                isActive ? "text-current" : "text-slate-500 hover:text-slate-300",
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

      {/* Confirmation dialog */}
      {pending && (
        <div className="mt-2 bg-slate-900 border border-slate-700 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-200 uppercase tracking-wide">
              Confirm → {pendingModeObj?.label}
            </span>
            <button onClick={cancel} className="text-slate-500 hover:text-slate-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <p className="text-[10px] text-slate-400">
            Type the code to confirm mode change:
          </p>

          {/* Code display */}
          <div className="flex gap-1.5 justify-center">
            {code.split('').map((digit, i) => (
              <span
                key={i}
                className="w-8 h-8 flex items-center justify-center bg-slate-800 border border-slate-600 rounded-lg text-sm font-mono font-bold text-slate-100"
              >
                {digit}
              </span>
            ))}
          </div>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={input}
            onChange={e => {
              const val = e.target.value.replace(/[^1-8]/g, '').slice(0, 4);
              setInput(val);
              setError(false);
            }}
            onKeyDown={handleKey}
            placeholder="_ _ _ _"
            className={cn(
              "w-full text-center font-mono text-lg tracking-[0.4em] bg-slate-800 border rounded-lg py-1.5 outline-none transition-colors",
              error
                ? "border-red-500 text-red-400"
                : "border-slate-600 text-slate-100 focus:border-slate-400"
            )}
          />

          {error && (
            <p className="text-[10px] text-red-400 text-center">Incorrect code — try again</p>
          )}

          <button
            onClick={confirm}
            disabled={input.length !== 4}
            className={cn(
              "w-full py-1.5 rounded-lg text-[11px] font-semibold transition-colors",
              input.length === 4
                ? "bg-slate-600 hover:bg-slate-500 text-white"
                : "bg-slate-800 text-slate-600 cursor-not-allowed"
            )}
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}
