// Server-side in-memory log store for system diagnostics

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  details?: string;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];

export function syslog(level: LogLevel, source: string, message: string, details?: unknown): void {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    details: details !== undefined ? (typeof details === 'string' ? details : JSON.stringify(details, null, 2)) : undefined,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  // Also log to console for server-side visibility
  const prefix = `[${source}]`;
  if (level === 'error') {
    console.error(prefix, message, details ?? '');
  } else if (level === 'warn') {
    console.warn(prefix, message, details ?? '');
  } else {
    console.log(prefix, message, details ?? '');
  }
}

export function getLogEntries(since?: string, limit = 100): LogEntry[] {
  let result = entries;
  if (since) {
    result = result.filter(e => e.timestamp > since);
  }
  return result.slice(-limit);
}

export function clearLogEntries(): void {
  entries.length = 0;
}
