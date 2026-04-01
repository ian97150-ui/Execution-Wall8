const BIAS_CONFIG = {
  OFFERING_LIVE: { label: 'OFFERING LIVE', cls: 'bg-red-500/20 text-red-400 border border-red-500/40' },
  ATM_LIVE:      { label: 'ATM LIVE',      cls: 'bg-red-500/20 text-red-400 border border-red-500/40' },
  PRIME_SHORT:   { label: 'PRIME SHORT',   cls: 'bg-red-500/20 text-red-400 border border-red-500/40' },
  TRAP_SETUP:    { label: 'TRAP SETUP',    cls: 'bg-orange-500/20 text-orange-400 border border-orange-500/40' },
  CLEAN_TAPE:    { label: 'CLEAN TAPE',    cls: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' },
  NO_DATA:       { label: 'NO DATA',       cls: 'bg-slate-700/50 text-slate-500 border border-slate-600/50' },
};

export default function BiasBadge({ bias, size = 'md' }) {
  if (!bias) return null;
  const config = BIAS_CONFIG[bias];
  if (!config) return null;

  const sizeClass = size === 'sm'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2 py-1 text-xs';

  return (
    <span className={`inline-flex items-center rounded-md font-bold tracking-wide ${sizeClass} ${config.cls}`}>
      {config.label}
    </span>
  );
}
