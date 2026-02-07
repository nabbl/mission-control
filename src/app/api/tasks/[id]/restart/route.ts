import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, queryAll } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { syslog } from '@/lib/logger';
import type { Task, OpenClawSession } from '@/lib/types';

// POST /api/tasks/[id]/restart - Reset task to fresh state
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const now = new Date().toISOString();

    syslog('info', 'restart', `Restarting task "${existing.title}" (${id})`);

    // 1. End all associated OpenClaw sessions
    const sessions = queryAll<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE task_id = ?',
      [id]
    );

    for (const session of sessions) {
      run(
        `UPDATE openclaw_sessions SET status = 'ended', ended_at = ? WHERE id = ?`,
        [now, session.id]
      );
    }

    // 2. Reset the task to fresh state
    run(
      `UPDATE tasks SET
        status = 'inbox',
        assigned_agent_id = NULL,
        planning_session_key = NULL,
        planning_messages = NULL,
        planning_complete = 0,
        planning_spec = NULL,
        planning_agents = NULL,
        updated_at = ?
       WHERE id = ?`,
      [now, id]
    );

    // 3. Log the restart event
    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_restarted', id, `Task "${existing.title}" was restarted`, now]
    );

    // 4. Log an activity for the restart
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), id, 'status_changed', 'Task restarted - cleared planning data and reset to inbox', now]
    );

    // 5. Fetch the updated task
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       WHERE t.id = ?`,
      [id]
    );

    // 6. Broadcast the update
    if (task) {
      broadcast({
        type: 'task_updated',
        payload: task,
      });
    }

    return NextResponse.json({
      success: true,
      task,
      message: 'Task restarted successfully. Planning data cleared and status reset to inbox.',
      endedSessions: sessions.length,
    });
  } catch (error) {
    syslog('error', 'restart', `Failed to restart task: ${(error as Error).message}`, { stack: (error as Error).stack });
    return NextResponse.json({ error: 'Failed to restart task' }, { status: 500 });
  }
}
