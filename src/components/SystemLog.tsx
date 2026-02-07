'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Trash2, AlertCircle, AlertTriangle, Info, ChevronDown, ChevronUp } from 'lucide-react';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  details?: string;
}

interface SystemLogProps {
  onClose: () => void;
}

const LEVEL_CONFIG = {
  error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', badge: 'bg-red-500/20 text-red-400' },
  warn: { icon: AlertTriangle, color: 'text-yellow-400', bg: 'bg-yellow-400/5', badge: 'bg-yellow-500/20 text-yellow-400' },
  info: { icon: Info, color: 'text-blue-400', bg: '', badge: 'bg-blue-500/20 text-blue-400' },
} as const;

const SOURCE_COLORS: Record<string, string> = {
  planning: 'bg-purple-500/20 text-purple-400',
  dispatch: 'bg-cyan-500/20 text-cyan-400',
  openclaw: 'bg-green-500/20 text-green-400',
  'llm-task': 'bg-orange-500/20 text-orange-400',
  restart: 'bg-yellow-500/20 text-yellow-400',
  system: 'bg-gray-500/20 text-gray-400',
};

export function SystemLog({ onClose }: SystemLogProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTimestamp = useRef<string | undefined>(undefined);

  const fetchLogs = useCallback(async (full = false) => {
    try {
      const params = new URLSearchParams();
      if (!full && lastTimestamp.current) {
        params.set('since', lastTimestamp.current);
      }
      params.set('limit', '200');
      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      const newEntries = data.entries as LogEntry[];

      if (newEntries.length > 0) {
        lastTimestamp.current = newEntries[newEntries.length - 1].timestamp;
      }

      if (full) {
        setEntries(newEntries);
      } else if (newEntries.length > 0) {
        setEntries(prev => {
          const combined = [...prev, ...newEntries];
          // Keep last 500
          return combined.slice(-500);
        });
      }
    } catch {
      // Silently ignore fetch errors for the log panel itself
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchLogs(true);
  }, [fetchLogs]);

  // Poll every 2 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchLogs(false), 2000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleClear = async () => {
    await fetch('/api/logs', { method: 'DELETE' });
    setEntries([]);
    lastTimestamp.current = undefined;
  };

  const filtered = filter === 'all' ? entries : entries.filter(e => e.level === filter);

  const errorCount = entries.filter(e => e.level === 'error').length;
  const warnCount = entries.filter(e => e.level === 'warn').length;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-mc-bg-secondary border-t border-mc-border shadow-2xl" style={{ height: '40vh', minHeight: '200px' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-mc-border bg-mc-bg-tertiary flex-shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold tracking-wide text-mc-text-secondary uppercase">System Log</span>

          {/* Level filter tabs */}
          <div className="flex gap-1">
            {(['all', 'error', 'warn', 'info'] as const).map(level => (
              <button
                key={level}
                onClick={() => setFilter(level)}
                className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                  filter === level
                    ? 'bg-mc-accent/20 text-mc-accent'
                    : 'text-mc-text-secondary hover:text-mc-text'
                }`}
              >
                {level.toUpperCase()}
                {level === 'error' && errorCount > 0 && (
                  <span className="ml-1 text-red-400">({errorCount})</span>
                )}
                {level === 'warn' && warnCount > 0 && (
                  <span className="ml-1 text-yellow-400">({warnCount})</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-mc-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
              className="w-3 h-3 rounded"
            />
            Auto-scroll
          </label>
          <button
            onClick={handleClear}
            className="p-1 text-mc-text-secondary hover:text-mc-text rounded"
            title="Clear logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1 text-mc-text-secondary hover:text-mc-text rounded"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-mc-text-secondary">
            No log entries{filter !== 'all' ? ` at ${filter} level` : ''}
          </div>
        ) : (
          filtered.map(entry => {
            const config = LEVEL_CONFIG[entry.level];
            const Icon = config.icon;
            const sourceColor = SOURCE_COLORS[entry.source] || SOURCE_COLORS.system;
            const isExpanded = expandedId === entry.id;

            return (
              <div key={entry.id}>
                <div
                  className={`flex items-start gap-2 px-4 py-1.5 border-b border-mc-border/30 hover:bg-mc-bg-tertiary/50 ${config.bg}`}
                >
                  <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${config.color}`} />
                  <span className="text-mc-text-secondary flex-shrink-0 w-[140px]">
                    {new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${sourceColor}`}>
                    {entry.source}
                  </span>
                  <span className="text-mc-text flex-1 break-words">{entry.message}</span>
                  {entry.details && (
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                      className="flex-shrink-0 text-mc-text-secondary hover:text-mc-text"
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
                {isExpanded && entry.details && (
                  <div className="px-4 py-2 bg-mc-bg border-b border-mc-border/30">
                    <pre className="text-[11px] text-mc-text-secondary whitespace-pre-wrap break-words overflow-x-auto ml-[168px]">
                      {entry.details}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
