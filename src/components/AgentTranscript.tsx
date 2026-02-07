/**
 * AgentTranscript Component
 * Shows live agent conversation transcript with tool calls, model info, and token usage.
 */

'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Bot, User, Terminal, ChevronDown, ChevronRight, AlertCircle,
  Cpu, Loader2, Wrench, MessageSquare,
} from 'lucide-react';
import type { TranscriptEntry, TranscriptResponse } from '@/lib/types';

interface AgentTranscriptProps {
  taskId: string;
  taskStatus?: string;
}

const POLL_ACTIVE_MS = 5000;
const POLL_IDLE_MS = 30000;
const MAX_COLLAPSED_LENGTH = 400;

export function AgentTranscript({ taskId, taskStatus }: AgentTranscriptProps) {
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevEntryCountRef = useRef(0);

  const isActive = taskStatus === 'in_progress' || taskStatus === 'assigned';

  const fetchTranscript = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/transcript`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      const data: TranscriptResponse = await res.json();
      setTranscript(data);
      if (data.error && data.entries.length === 0) {
        setError(data.error);
      } else {
        setError(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    setError(null);
    setTranscript(null);
    fetchTranscript();
  }, [taskId, fetchTranscript]);

  // Polling
  useEffect(() => {
    const interval = setInterval(fetchTranscript, isActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(interval);
  }, [fetchTranscript, isActive]);

  // Auto-scroll when new entries arrive
  useEffect(() => {
    const entryCount = transcript?.entries.length ?? 0;
    if (entryCount > prevEntryCountRef.current && autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevEntryCountRef.current = entryCount;
  }, [transcript?.entries.length]);

  // Detect if user scrolled up
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 60;
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedEntries(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // --- Rendering ---

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-mc-text-secondary" />
        <span className="text-mc-text-secondary">Loading transcript...</span>
      </div>
    );
  }

  if (error && (!transcript || transcript.entries.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  if (!transcript || transcript.entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <Bot className="w-8 h-8 mb-2 opacity-50" />
        <p>No transcript available yet</p>
        {isActive && (
          <p className="text-xs mt-1">Waiting for agent activity...</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full -m-4">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-mc-border bg-mc-bg-secondary flex-shrink-0 flex-wrap">
        {/* Model badge */}
        {transcript.model && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-purple-500/15 text-purple-400 border border-purple-500/20">
            <Cpu className="w-3 h-3" />
            {transcript.modelProvider ? `${transcript.modelProvider}/` : ''}{transcript.model}
          </span>
        )}

        {/* Token usage */}
        {transcript.tokenUsage && transcript.tokenUsage.total && (
          <span className="text-xs text-mc-text-secondary">
            {transcript.tokenUsage.total.toLocaleString()} tokens
            {transcript.tokenUsage.input != null && transcript.tokenUsage.output != null && (
              <span className="opacity-60"> ({transcript.tokenUsage.input.toLocaleString()}in / {transcript.tokenUsage.output.toLocaleString()}out)</span>
            )}
          </span>
        )}

        {/* Session status */}
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span className={`w-2 h-2 rounded-full ${
            transcript.sessionStatus === 'active' ? 'bg-green-500 animate-pulse' :
            transcript.sessionStatus === 'completed' ? 'bg-mc-accent' :
            'bg-mc-text-secondary'
          }`} />
          <span className="text-mc-text-secondary capitalize">{transcript.sessionStatus ?? 'unknown'}</span>
        </span>
      </div>

      {/* Transcript list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
      >
        {transcript.entries.map((entry) => (
          <TranscriptEntryRow
            key={entry.id}
            entry={entry}
            expanded={expandedEntries.has(entry.id)}
            onToggle={() => toggleExpand(entry.id)}
          />
        ))}

        {isActive && (
          <div className="flex items-center gap-2 py-2 text-mc-text-secondary text-xs">
            <Loader2 className="w-3 h-3 animate-spin" />
            Agent is working...
          </div>
        )}
      </div>
    </div>
  );
}

// --- Entry row ---

function TranscriptEntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: TranscriptEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  switch (entry.role) {
    case 'user':
      return <UserEntry entry={entry} expanded={expanded} onToggle={onToggle} />;
    case 'assistant':
      return <AssistantEntry entry={entry} expanded={expanded} onToggle={onToggle} />;
    case 'tool_call':
      return <ToolCallEntry entry={entry} expanded={expanded} onToggle={onToggle} />;
    case 'tool_result':
      return <ToolResultEntry entry={entry} expanded={expanded} onToggle={onToggle} />;
    case 'system':
      return <SystemEntry entry={entry} />;
    default:
      return <SystemEntry entry={entry} />;
  }
}

function UserEntry({ entry, expanded, onToggle }: { entry: TranscriptEntry; expanded: boolean; onToggle: () => void }) {
  const isLong = entry.content.length > MAX_COLLAPSED_LENGTH;
  const displayContent = isLong && !expanded ? entry.content.slice(0, MAX_COLLAPSED_LENGTH) + '...' : entry.content;

  return (
    <div className="flex gap-2 p-2 rounded-lg bg-mc-bg-tertiary/50">
      <User className="w-4 h-4 mt-0.5 text-blue-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-blue-400 mb-0.5">User</div>
        <div className="text-sm text-mc-text whitespace-pre-wrap break-words">{displayContent}</div>
        {isLong && (
          <button onClick={onToggle} className="text-xs text-mc-accent hover:underline mt-1">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantEntry({ entry, expanded, onToggle }: { entry: TranscriptEntry; expanded: boolean; onToggle: () => void }) {
  const isLong = entry.content.length > MAX_COLLAPSED_LENGTH;
  const displayContent = isLong && !expanded ? entry.content.slice(0, MAX_COLLAPSED_LENGTH) + '...' : entry.content;

  return (
    <div className="flex gap-2 p-2 rounded-lg">
      <MessageSquare className="w-4 h-4 mt-0.5 text-mc-accent flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-mc-accent mb-0.5">Assistant</div>
        <div className="text-sm text-mc-text whitespace-pre-wrap break-words">{displayContent}</div>
        {isLong && (
          <button onClick={onToggle} className="text-xs text-mc-accent hover:underline mt-1">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

function ToolCallEntry({ entry, expanded, onToggle }: { entry: TranscriptEntry; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="ml-6">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Wrench className="w-3 h-3" />
        {entry.toolName ?? 'tool'}
      </button>
      {expanded && (
        <div className="mt-1 ml-2 p-2 bg-mc-bg rounded border border-mc-border text-xs font-mono text-mc-text-secondary whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
          {entry.content}
        </div>
      )}
    </div>
  );
}

function ToolResultEntry({ entry, expanded, onToggle }: { entry: TranscriptEntry; expanded: boolean; onToggle: () => void }) {
  const isLong = entry.content.length > 200;
  const preview = entry.content.slice(0, 120);

  return (
    <div className="ml-6">
      <button
        onClick={onToggle}
        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono border transition-colors ${
          entry.isError
            ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
            : 'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border hover:bg-mc-border'
        }`}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Terminal className="w-3 h-3" />
        {isLong ? `result (${entry.content.length} chars)` : preview}
      </button>
      {expanded && (
        <div className="mt-1 ml-2 p-2 bg-mc-bg rounded border border-mc-border text-xs font-mono text-mc-text-secondary whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
          {entry.content}
        </div>
      )}
    </div>
  );
}

function SystemEntry({ entry }: { entry: TranscriptEntry }) {
  return (
    <div className="px-2 py-1 text-xs text-mc-text-secondary italic opacity-60">
      {entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content}
    </div>
  );
}
