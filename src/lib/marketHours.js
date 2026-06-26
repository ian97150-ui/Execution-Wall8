// Mirrors the backend's extended trading window (secWatchScanner.ts's
// isLiveScoreWindowET: weekdays, 04:00-18:00 ET) - used to stop frontend
// polling from keeping the Neon compute endpoint awake 24/7. Outside this
// window TradingView isn't sending webhooks, so there's nothing new to poll for.
export function isTradingWindowET() {
  const day = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return false;

  const etHHMM = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = etHHMM.split(':').map(Number);
  const totalMin = h * 60 + m;
  return totalMin >= 240 && totalMin < 1080; // 04:00-18:00 ET
}

// Use as a refetchInterval value in @tanstack/react-query: polls at
// activeMs during the trading window, falls back to idleMs (or false to
// stop entirely) outside it. Re-evaluated by the library on every tick.
export function tradingWindowRefetchInterval(activeMs, idleMs = false) {
  return () => (isTradingWindowET() ? activeMs : idleMs);
}
