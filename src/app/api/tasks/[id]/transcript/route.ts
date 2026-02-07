import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { parseSessionHistory } from '@/lib/openclaw/parseHistory';
import { syslog } from '@/lib/logger';
import type { Task, OpenClawSession, OpenClawSessionInfo, TranscriptResponse } from '@/lib/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/tasks/[id]/transcript
 *
 * Fetches live session history from OpenClaw for the task's assigned agent,
 * parses it into TranscriptEntry[], and returns model/token metadata.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    // 1. Find the task and its assigned agent
    const task = queryOne<Task>(
      'SELECT * FROM tasks WHERE id = ?',
      [id]
    );

    if (!task) {
      return NextResponse.json({ entries: [], error: 'Task not found' } satisfies TranscriptResponse, { status: 404 });
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json({
        entries: [],
        error: 'No agent assigned to this task',
      } satisfies TranscriptResponse);
    }

    // 2. Find the agent's active OpenClaw session
    const session = queryOne<OpenClawSession>(
      `SELECT * FROM openclaw_sessions
       WHERE agent_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [task.assigned_agent_id]
    );

    if (!session) {
      return NextResponse.json({
        entries: [],
        error: 'No active session found for this agent',
      } satisfies TranscriptResponse);
    }

    // 3. Connect to OpenClaw if needed
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json({
          entries: [],
          sessionId: session.openclaw_session_id,
          error: 'Failed to connect to OpenClaw Gateway',
        } satisfies TranscriptResponse, { status: 503 });
      }
    }

    // 4. Fetch session history + session metadata in parallel
    const sessionKey = `agent:main:${session.openclaw_session_id}`;

    let rawHistory: unknown[] = [];
    let sessionInfo: OpenClawSessionInfo | undefined;

    try {
      const [historyResult, sessionsResult] = await Promise.allSettled([
        client.getSessionHistory(sessionKey),
        client.listSessions(),
      ]);

      if (historyResult.status === 'fulfilled') {
        rawHistory = historyResult.value;
      } else {
        syslog('warn', 'transcript', `Failed to fetch history for ${sessionKey}: ${historyResult.reason}`);
      }

      if (sessionsResult.status === 'fulfilled') {
        // listSessions() may return an array or a payload object with { sessions: [...] }
        const raw = sessionsResult.value as unknown;
        const sessionsList: OpenClawSessionInfo[] = Array.isArray(raw)
          ? raw
          : (raw && typeof raw === 'object' && 'sessions' in raw && Array.isArray((raw as Record<string, unknown>).sessions))
            ? (raw as Record<string, unknown>).sessions as OpenClawSessionInfo[]
            : [];
        sessionInfo = sessionsList.find(
          (s) => s.id === sessionKey || s.id === session.openclaw_session_id || s.key === sessionKey
        );
      }
    } catch (err) {
      syslog('error', 'transcript', `OpenClaw API error: ${(err as Error).message}`);
      return NextResponse.json({
        entries: [],
        sessionId: session.openclaw_session_id,
        error: `OpenClaw error: ${(err as Error).message}`,
      } satisfies TranscriptResponse, { status: 502 });
    }

    // 5. Parse history
    const entries = parseSessionHistory(rawHistory);

    // 6. Build response
    const response: TranscriptResponse = {
      entries,
      sessionId: session.openclaw_session_id,
      sessionStatus: sessionInfo?.status ?? session.status,
      model: sessionInfo?.model ?? task.model ?? undefined,
      modelProvider: sessionInfo?.modelProvider ?? task.model_provider ?? undefined,
      tokenUsage: sessionInfo?.totalTokens ? {
        input: sessionInfo.inputTokens,
        output: sessionInfo.outputTokens,
        total: sessionInfo.totalTokens,
      } : undefined,
    };

    return NextResponse.json(response);
  } catch (error) {
    syslog('error', 'transcript', `Unexpected error: ${(error as Error).message}`, { stack: (error as Error).stack });
    return NextResponse.json(
      { entries: [], error: (error as Error).message } satisfies TranscriptResponse,
      { status: 500 }
    );
  }
}
