/**
 * Reconciliation system — syncs DB state with gateway reality.
 *
 * Designed to be:
 * - Idempotent: safe to run repeatedly
 * - Tolerant: gateway unreachable = early return, not crash
 * - Non-destructive: never auto-restarts tasks, only flags them
 * - Debounced: skips if called within 30 seconds
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { syslog } from '@/lib/logger';
import type { Task, OpenClawSession, OpenClawSessionInfo } from '@/lib/types';

export interface ReconcileResult {
  ran: boolean;
  sessionsEnded: number;
  tasksErrored: number;
  agentsReset: number;
  sessionsBackfilled: number;
  error?: string;
}

let lastRunAt = 0;
let cachedResult: ReconcileResult | null = null;

const DEBOUNCE_MS = 30_000;

/**
 * Run reconciliation. Returns cached result if called within 30s of last run.
 */
export async function reconcile(): Promise<ReconcileResult> {
  const now = Date.now();
  if (now - lastRunAt < DEBOUNCE_MS && cachedResult) {
    return { ...cachedResult, ran: false };
  }

  const result: ReconcileResult = {
    ran: true,
    sessionsEnded: 0,
    tasksErrored: 0,
    agentsReset: 0,
    sessionsBackfilled: 0,
  };

  // A) Fetch gateway sessions
  let gatewaySessions: OpenClawSessionInfo[];
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }
    const raw = await client.listSessions() as unknown;
    // listSessions() may return an array or { sessions: [...] }
    gatewaySessions = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' && 'sessions' in raw && Array.isArray((raw as Record<string, unknown>).sessions))
        ? (raw as Record<string, unknown>).sessions as OpenClawSessionInfo[]
        : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    syslog('warn', 'reconcile', `Gateway unreachable, skipping reconciliation: ${msg}`);
    result.ran = false;
    result.error = msg;
    return result;
  }

  // Build lookup sets for fast matching (by id and by key)
  const gatewayById = new Map<string, OpenClawSessionInfo>();
  const gatewayByKey = new Map<string, OpenClawSessionInfo>();
  for (const s of gatewaySessions) {
    gatewayById.set(s.id, s);
    if (s.key) gatewayByKey.set(s.key, s);
  }

  // B) Fetch DB state
  const activeSessions = queryAll<OpenClawSession>(
    `SELECT * FROM openclaw_sessions WHERE status = 'active'`
  );
  const inProgressTasks = queryAll<Task>(
    `SELECT * FROM tasks WHERE status IN ('in_progress', 'assigned')`
  );
  const workingAgents = queryAll<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE status = 'working'`
  );

  const tasksToNotify: Task[] = [];
  const nowIso = new Date().toISOString();

  transaction(() => {
    // C) Fix stale sessions (DB says active, gateway says gone)
    for (const dbSession of activeSessions) {
      const sessionKey = `agent:main:${dbSession.openclaw_session_id}`;
      const onGateway =
        gatewayById.has(dbSession.openclaw_session_id) ||
        gatewayByKey.has(sessionKey) ||
        gatewayById.has(sessionKey);

      if (!onGateway) {
        run(
          `UPDATE openclaw_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`,
          [nowIso, nowIso, dbSession.id]
        );
        result.sessionsEnded++;

        // If session had a linked task, flag it
        if (dbSession.task_id) {
          run(
            `UPDATE tasks SET dispatch_error = ?, updated_at = ? WHERE id = ? AND dispatch_error IS NULL`,
            ['Session lost — agent no longer running on gateway', nowIso, dbSession.task_id]
          );
          const flagged = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [dbSession.task_id]);
          if (flagged?.dispatch_error) {
            tasksToNotify.push(flagged);
            result.tasksErrored++;
          }
        }
      }
    }

    // D) Fix orphaned in-progress tasks
    for (const task of inProgressTasks) {
      if (!task.assigned_agent_id) continue;
      // Already has an error from step C? Skip.
      if (task.dispatch_error) continue;

      // Check if agent still has an active session
      const hasActiveSession = activeSessions.some(
        s => s.agent_id === task.assigned_agent_id && s.status === 'active'
          // Only count sessions we didn't just end in step C
          && (gatewayById.has(s.openclaw_session_id) ||
              gatewayByKey.has(`agent:main:${s.openclaw_session_id}`) ||
              gatewayById.has(`agent:main:${s.openclaw_session_id}`))
      );

      if (!hasActiveSession) {
        run(
          `UPDATE tasks SET dispatch_error = ?, updated_at = ? WHERE id = ? AND dispatch_error IS NULL`,
          ['Agent session lost', nowIso, task.id]
        );
        const flagged = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
        if (flagged?.dispatch_error) {
          tasksToNotify.push(flagged);
          result.tasksErrored++;
        }
      }
    }

    // E) Backfill task_id on sessions missing it
    for (const dbSession of activeSessions) {
      if (dbSession.task_id) continue;
      // Find agent's current in_progress task
      const agentTask = inProgressTasks.find(t => t.assigned_agent_id === dbSession.agent_id);
      if (agentTask) {
        run(
          `UPDATE openclaw_sessions SET task_id = ?, updated_at = ? WHERE id = ?`,
          [agentTask.id, nowIso, dbSession.id]
        );
        result.sessionsBackfilled++;
      }
    }

    // F) Fix agent status drift
    for (const agent of workingAgents) {
      const hasActiveSession = activeSessions.some(
        s => s.agent_id === agent.id && s.status === 'active'
          && (gatewayById.has(s.openclaw_session_id) ||
              gatewayByKey.has(`agent:main:${s.openclaw_session_id}`) ||
              gatewayById.has(`agent:main:${s.openclaw_session_id}`))
      );
      const hasInProgressTask = inProgressTasks.some(t => t.assigned_agent_id === agent.id);

      if (!hasActiveSession && !hasInProgressTask) {
        run(
          `UPDATE agents SET status = 'standby', updated_at = ? WHERE id = ?`,
          [nowIso, agent.id]
        );
        result.agentsReset++;
      }
    }
  });

  // G) Broadcast changes (outside transaction)
  for (const task of tasksToNotify) {
    broadcast({ type: 'task_updated', payload: task });
  }

  // H) Log summary
  const parts: string[] = [];
  if (result.sessionsEnded) parts.push(`${result.sessionsEnded} sessions ended`);
  if (result.tasksErrored) parts.push(`${result.tasksErrored} tasks flagged`);
  if (result.agentsReset) parts.push(`${result.agentsReset} agents reset`);
  if (result.sessionsBackfilled) parts.push(`${result.sessionsBackfilled} sessions backfilled`);

  if (parts.length > 0) {
    syslog('warn', 'reconcile', `Reconciliation found issues: ${parts.join(', ')}`);
  } else {
    syslog('info', 'reconcile', 'Reconciliation complete — no issues found');
  }

  lastRunAt = Date.now();
  cachedResult = result;
  return result;
}
