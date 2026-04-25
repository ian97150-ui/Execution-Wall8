import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BarChart2, Plus, Trash2, Play, Square, ChevronRight } from 'lucide-react';

const API = ((import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:3000/api')) + '/sim');

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const text = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch {}
    const err = new Error(parsed.error || text);
    err.output = parsed.output || null;
    throw err;
  }
  return res.json();
}

export function BacktestPanel() {
  const qc = useQueryClient();
  const [selected, setSelected]     = useState(null); // { ticker, spike_date }
  const [lines, setLines]           = useState([]);
  const [running, setRunning]       = useState(false);
  const [showAdd, setShowAdd]       = useState(false);
  const [addTicker, setAddTicker]   = useState('');
  const [addDate, setAddDate]       = useState('');
  const [addStatus, setAddStatus]   = useState('');
  const esRef   = useRef(null);
  const termRef = useRef(null);

  // Load ticker list
  const { data: tickers = [], isLoading } = useQuery({
    queryKey: ['sim-tickers'],
    queryFn:  () => apiFetch('/tickers'),
    refetchInterval: false,
  });

  // Auto-select first ticker when list loads
  useEffect(() => {
    if (!selected && tickers.length > 0) {
      setSelected({ ticker: tickers[0].ticker, spike_date: tickers[0].spike_date });
    }
  }, [tickers, selected]);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [lines]);

  const stopStream = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setRunning(false);
  }, []);

  const runCmd = useCallback((cmd) => {
    stopStream();
    setLines([]);
    setRunning(true);

    const params = new URLSearchParams({ cmd });
    if (selected && (cmd === 'flips' || cmd === 'replay')) {
      params.set('ticker', selected.ticker);
      params.set('date',   selected.spike_date);
    }

    const es = new EventSource(`${API}/run?${params}`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const text = JSON.parse(e.data);
        setLines(prev => [...prev, ...text.split('\n')]);
      } catch {
        setLines(prev => [...prev, e.data]);
      }
    };

    es.addEventListener('done', () => {
      es.close(); esRef.current = null;
      setRunning(false);
    });

    es.onerror = (e) => {
      console.error('[BacktestPanel] EventSource error', e, 'readyState:', es.readyState);
      setLines(prev => [...prev, `[connection closed — readyState=${es.readyState}]`]);
      es.close(); esRef.current = null;
      setRunning(false);
    };
  }, [selected, stopStream]);

  // Cleanup on unmount
  useEffect(() => () => stopStream(), [stopStream]);

  // Delete mutation
  const deleteMut = useMutation({
    mutationFn: ({ ticker, spike_date }) =>
      apiFetch(`/tickers/${encodeURIComponent(ticker)}/${encodeURIComponent(spike_date)}`,
               { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sim-tickers'] }),
  });

  // Add mutation
  const addMut = useMutation({
    mutationFn: ({ ticker, date }) =>
      apiFetch('/tickers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticker, date }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sim-tickers'] });
      setAddStatus('Added.');
      setAddTicker(''); setAddDate('');
      setTimeout(() => setAddStatus(''), 2000);
    },
    onError: (err) => {
      setAddStatus(`Error: ${err.message}`);
    },
  });

  const handleAdd = (e) => {
    e.preventDefault();
    if (!addTicker.trim() || !addDate.trim()) return;
    setAddStatus('Fetching data...');
    addMut.mutate({ ticker: addTicker.trim().toUpperCase(), date: addDate.trim() });
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground" style={{ minHeight: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold tracking-wide">BACKTEST SIMULATION</span>
        </div>
        <button
          onClick={() => { setShowAdd(s => !s); setAddStatus(''); }}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-accent transition-colors"
        >
          <Plus className="w-3 h-3" /> Add Ticker
        </button>
      </div>

      {/* Add ticker form */}
      {showAdd && (
        <form onSubmit={handleAdd}
          className="flex items-end gap-2 px-4 py-2 border-b border-border bg-muted/40">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Ticker</label>
            <input
              value={addTicker} onChange={e => setAddTicker(e.target.value)}
              placeholder="SKYQ"
              className="w-24 h-7 px-2 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Spike Date</label>
            <input
              type="date" value={addDate} onChange={e => setAddDate(e.target.value)}
              className="h-7 px-2 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <button type="submit" disabled={addMut.isPending}
            className="h-7 px-3 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {addMut.isPending ? 'Fetching…' : 'Add'}
          </button>
          {addStatus && <span className="text-xs text-muted-foreground">{addStatus}</span>}
        </form>
      )}

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Ticker list */}
        <div className="w-44 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
          <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border">
            Sessions
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoading && (
              <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
            )}
            {!isLoading && tickers.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No tickers. Click + Add Ticker.
              </div>
            )}
            {tickers.map((row) => {
              const isSelected = selected?.ticker === row.ticker &&
                                 selected?.spike_date === row.spike_date;
              return (
                <div
                  key={row.id}
                  onClick={() => setSelected({ ticker: row.ticker, spike_date: row.spike_date })}
                  className={`group flex items-start justify-between px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors ${isSelected ? 'bg-accent' : ''}`}
                >
                  <div className="flex items-start gap-1.5 min-w-0">
                    {isSelected
                      ? <ChevronRight className="w-3 h-3 mt-0.5 text-primary flex-shrink-0" />
                      : <span className="w-3 flex-shrink-0" />
                    }
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{row.ticker}</div>
                      <div className="text-xs text-muted-foreground">{row.spike_date}</div>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteMut.mutate({ ticker: row.ticker, spike_date: row.spike_date }); }}
                    className="opacity-0 group-hover:opacity-100 ml-1 text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Terminal */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Terminal header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/20">
            <span className="text-xs text-muted-foreground font-mono">
              {selected
                ? `${selected.ticker}  ${selected.spike_date}`
                : 'Select a session from the list'}
            </span>
            {running && (
              <button onClick={stopStream}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-border hover:bg-accent text-destructive">
                <Square className="w-3 h-3" /> Stop
              </button>
            )}
          </div>

          {/* Output pane */}
          <pre
            ref={termRef}
            className="flex-1 overflow-y-auto px-3 py-2 text-xs font-mono leading-5 bg-black/80 text-green-400 whitespace-pre-wrap break-words"
            style={{ minHeight: 0 }}
          >
            {lines.length === 0
              ? <span className="text-muted-foreground">Ready. Select a command below.</span>
              : lines.join('\n')
            }
            {running && <span className="animate-pulse">▋</span>}
          </pre>

          {/* Command buttons */}
          <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/10 flex-wrap">
            <CmdButton
              label="Health Check"
              disabled={running}
              onClick={() => {
                setLines(['[fetch] GET /api/sim/health ...']);
                fetch('/api/sim/health')
                  .then(r => {
                    setLines(prev => [...prev, `[http] status ${r.status}`]);
                    return r.text();
                  })
                  .then(t => setLines(prev => [...prev, t]))
                  .catch(e => setLines(prev => [...prev, `[error] ${e.message}`]));
              }}
            />
            <CmdButton
              label="Test SSE"
              disabled={running}
              onClick={() => runCmd('test')}
            />
            <span className="text-border">|</span>
            <CmdButton
              label="Flip Analysis"
              icon={<Play className="w-3 h-3" />}
              disabled={running || !selected}
              onClick={() => runCmd('flips')}
            />
            <CmdButton
              label="Flip All"
              disabled={running}
              onClick={() => runCmd('flips-all')}
            />
            <CmdButton
              label="Replay"
              disabled={running || !selected}
              onClick={() => runCmd('replay')}
            />
            <CmdButton
              label="Patterns"
              disabled={running}
              onClick={() => runCmd('patterns')}
            />
            <CmdButton
              label="Backtest"
              disabled={running}
              onClick={() => runCmd('backtest')}
            />
            {lines.length > 0 && !running && (
              <button
                onClick={() => setLines([])}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CmdButton({ label, icon, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 text-xs px-3 py-1 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}
