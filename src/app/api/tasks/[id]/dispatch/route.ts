import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { syslog } from '@/lib/logger';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent's OpenClaw session.
 * Creates session if needed, sends task details to agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json(
        { error: 'Task has no assigned agent' },
        { status: 400 }
      );
    }

    // Guard: parent tasks with subtasks cannot be dispatched directly
    const subtaskCount = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ?', [id]
    );
    if (subtaskCount && subtaskCount.count > 0) {
      return NextResponse.json(
        { error: 'Parent tasks with subtasks cannot be dispatched directly' },
        { status: 400 }
      );
    }

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [task.assigned_agent_id]
    );

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    // Connect to OpenClaw Gateway
    syslog('info', 'dispatch', `Dispatching task "${task.title}" to agent ${agent.name}`);

    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        syslog('info', 'openclaw', 'Connecting to OpenClaw Gateway...');
        await client.connect();
        syslog('info', 'openclaw', 'Connected to OpenClaw Gateway');
      } catch (err) {
        syslog('error', 'openclaw', `Failed to connect to OpenClaw Gateway: ${(err as Error).message}`);
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    // Get or create OpenClaw session for this agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active']
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
      
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', task.id, now, now]
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId]
      );

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now]
      );
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Failed to create agent session' },
        { status: 500 }
      );
    }

    // Backfill task_id on reused session if missing
    if (!session.task_id || session.task_id !== task.id) {
      run(
        'UPDATE openclaw_sessions SET task_id = ?, updated_at = ? WHERE id = ?',
        [task.id, now, session.id]
      );
    }

    // Build task message for agent
    const priorityEmoji = {
      low: '🔵',
      normal: '⚪',
      high: '🟡',
      urgent: '🔴'
    }[task.priority] || '⚪';

    // Get project path for deliverables
    const projectsPath = getProjectsPath();
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const taskProjectDir = `${projectsPath}/${projectDir}`;
    const missionControlUrl = getMissionControlUrl();

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}

**OUTPUT DIRECTORY:** ${taskProjectDir}
Create this directory and save all deliverables there.

**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${taskProjectDir}/filename.html"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask me (Charlie).`;

    // Inject skill instructions based on agent's skills
    const agentSkills: string[] = (() => {
      try { return JSON.parse(agent.skills as unknown as string || '[]'); }
      catch { return []; }
    })();

    let skillInstructions = '';
    if (agentSkills.includes('coding-agent')) {
      skillInstructions += `\n\n**AVAILABLE SKILLS:**
You have the \`coding-agent\` skill available. For any coding work (writing, editing, or debugging code, running commands, using git), invoke it with:
/coding-agent <your instructions>
Use this skill instead of writing code inline.`;
    }

    // Prepend branch instructions for subtasks
    let branchInstructions = '';
    if (task.parent_task_id && (task as unknown as { branch_name?: string }).branch_name) {
      const branchName = (task as unknown as { branch_name: string }).branch_name;
      branchInstructions = `\n\n**GIT BRANCH:** \`${branchName}\`
- Create this branch from \`main\`: \`git checkout -b ${branchName} main\`
- Do ALL work on this branch
- When complete, push and create a PR from \`${branchName}\` to \`main\`
- Include the PR URL when reporting deliverables\n`;
    }

    const fullTaskMessage = branchInstructions + taskMessage + (skillInstructions || '');

    if (agentSkills.length > 0) {
      syslog('info', 'dispatch', `Agent ${agent.name} has skills: ${agentSkills.join(', ')}`);
    }

    // Send message to agent's session using chat.send
    try {
      // Resolve model: task override > agent default > gateway default
      const modelProvider = task.model_provider || agent.model_provider || undefined;
      const model = task.model || agent.model || undefined;

      if (modelProvider || model) {
        syslog('info', 'dispatch', `Using model: ${modelProvider || 'default'}/${model || 'default'}`);
      }

      // Use sessionKey for routing to the agent's session
      // Format: agent:main:{openclaw_session_id}
      const sessionKey = `agent:main:${session.openclaw_session_id}`;
      await client.call('chat.send', {
        sessionKey,
        message: fullTaskMessage,
        ...(model ? { model } : {}),
        idempotencyKey: `dispatch-${task.id}-${Date.now()}`
      });

      // Update task status to in_progress and clear any previous dispatch error
      run(
        'UPDATE tasks SET status = ?, dispatch_error = NULL, updated_at = ? WHERE id = ?',
        ['in_progress', now, id]
      );

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Log dispatch event
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_dispatched',
          agent.id,
          task.id,
          `Task "${task.title}" dispatched to ${agent.name}`,
          now
        ]
      );

      syslog('info', 'dispatch', `Task "${task.title}" dispatched to ${agent.name} (session: ${session.openclaw_session_id})`);

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent'
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      syslog('error', 'dispatch', `Failed to send task to agent: ${errMsg}`, { taskId: task.id, agentId: agent.id });

      // Record dispatch error on the task
      run(
        'UPDATE tasks SET dispatch_error = ?, updated_at = ? WHERE id = ?',
        [`Dispatch failed: ${errMsg}`, now, id]
      );
      const erroredTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (erroredTask) {
        broadcast({ type: 'task_updated', payload: erroredTask });
      }

      return NextResponse.json(
        { error: `Failed to send task to agent: ${errMsg}` },
        { status: 500 }
      );
    }
  } catch (error) {
    syslog('error', 'dispatch', `Failed to dispatch task: ${error instanceof Error ? error.message : 'Unknown'}`, { stack: (error as Error).stack });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to dispatch task' },
      { status: 500 }
    );
  }
}
