import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  invokeLlmTask,
  PLANNING_RESPONSE_SCHEMA,
  normalisePlanningResponse,
  type PlanningResponse,
} from '@/lib/openclaw/client';
import { syslog } from '@/lib/logger';

// POST /api/tasks/[id]/planning/answer - Submit an answer and get next question
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const { answer, otherText } = body;

    if (!answer) {
      return NextResponse.json({ error: 'Answer is required' }, { status: 400 });
    }

    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      planning_session_key?: string;
      planning_messages?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning not started' }, { status: 400 });
    }

    // Build the answer text
    const answerText = answer.toLowerCase() === 'other' && otherText
      ? otherText
      : answer;

    // Append user answer to messages
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    messages.push({ role: 'user', content: answerText, timestamp: Date.now() });

    // Build conversation history for context (llm-task is stateless)
    const conversationHistory = messages.map((m: { role: string; content: string }) => ({
      role: m.role,
      content: m.content,
    }));

    const prompt = `You are continuing a planning session for a task. The conversation history is provided as input.

The user has just answered a question. Based on the full conversation so far, either:
1. Ask the NEXT clarifying question if you need more information (set type to "question")
2. Complete the planning if you have enough information (set type to "complete")

When completing, include a full spec with title, summary, deliverables, success_criteria, and constraints. Also include agents (with name, role, avatar_emoji, soul_md, and instructions) and an execution_plan with approach and steps.

Also include a "suggested_model" object with "provider" and "model" fields. Use "anthropic" provider with "claude-sonnet-4-5-20250929" for complex programming/coding tasks. Use "lmstudio" provider (empty model) for simpler tasks like writing, research, or content generation.

Each agent can optionally be assigned skills from this list: ["coding-agent"].
- "coding-agent": Gives the agent access to Claude Code CLI for writing/editing code, running commands, using git, file system access, etc. Assign this skill to any agent that needs to produce, modify, or debug code.
Include a "skills" array on each agent (empty array if no skills needed).

For complex tasks requiring multiple parallel or sequential workstreams, include a "subtasks" array instead of "agents". Each subtask has:
- title: short name
- description: what this subtask accomplishes
- instructions: detailed agent instructions
- agent: { name, role, avatar_emoji, soul_md, skills[] }
- branch_name: git branch name (e.g. "feature/add-auth"). Auto-generated if omitted.
- depends_on: array of other subtask TITLES that must complete first (empty array for independent subtasks)

If subtasks are present, agents[] is ignored. Use subtasks for multi-step projects; use agents[] for simple single-agent tasks.

You MUST respond with a JSON object containing a "type" field set to either "question" or "complete".`;

    // Call llm-task with full conversation history
    syslog('info', 'planning', `Processing answer for task ${taskId}: "${answerText.substring(0, 80)}"`);

    const raw = await invokeLlmTask<Record<string, unknown>>({
      prompt,
      input: conversationHistory,
      schema: PLANNING_RESPONSE_SCHEMA,
      temperature: 0.7,
      maxTokens: 2000,
      timeoutMs: 60000,
    });

    const result = normalisePlanningResponse(raw);
    syslog('info', 'planning', `LLM response normalised — type: ${result.type}`, { taskId });

    // Store response
    messages.push({ role: 'assistant', content: JSON.stringify(result), timestamp: Date.now() });

    if (result.type === 'complete') {
      const suggestedModel = result.suggested_model;
      const hasSubtasks = result.subtasks && result.subtasks.length > 0;

      syslog('info', 'planning', `Planning complete for task ${taskId} — ${hasSubtasks ? `${result.subtasks!.length} subtasks` : `${result.agents?.length ?? 0} agents`}, suggested model: ${suggestedModel?.provider ?? 'default'}/${suggestedModel?.model ?? 'default'}`);

      if (hasSubtasks) {
        // === SUBTASK PATH ===
        // Update parent task
        getDb().prepare(`
          UPDATE tasks
          SET planning_messages = ?,
              planning_complete = 1,
              planning_spec = ?,
              planning_agents = ?,
              model_provider = COALESCE(model_provider, ?),
              model = COALESCE(model, ?),
              status = 'in_progress'
          WHERE id = ?
        `).run(
          JSON.stringify(messages),
          JSON.stringify(result.spec),
          JSON.stringify(result.agents),
          suggestedModel?.provider || null,
          suggestedModel?.model || null,
          taskId
        );

        // Fetch parent for inherited fields
        const parentTask = getDb().prepare('SELECT workspace_id, business_id, priority FROM tasks WHERE id = ?').get(taskId) as {
          workspace_id: string; business_id: string; priority: string;
        };

        const insertAgent = getDb().prepare(`
          INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, skills, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'standby', ?, ?, datetime('now'), datetime('now'))
        `);

        const insertSubtask = getDb().prepare(`
          INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id, parent_task_id, branch_name, depends_on, created_at, updated_at)
          VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
        `);

        // First pass: create agents + subtask rows, build title→id map
        const titleToIdMap = new Map<string, string>();
        const subtaskIds: string[] = [];

        for (const st of result.subtasks!) {
          const agentId = crypto.randomUUID();
          insertAgent.run(
            agentId,
            parentTask.workspace_id,
            st.agent.name,
            st.agent.role,
            st.instructions,
            st.agent.avatar_emoji || '🤖',
            st.agent.soul_md || '',
            JSON.stringify(st.agent.skills || [])
          );

          const subtaskId = crypto.randomUUID();
          const branchName = st.branch_name || 'subtask/' + st.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          insertSubtask.run(
            subtaskId,
            st.title,
            st.description,
            parentTask.priority,
            agentId,
            parentTask.workspace_id,
            parentTask.business_id,
            taskId,
            branchName
          );

          titleToIdMap.set(st.title, subtaskId);
          subtaskIds.push(subtaskId);
        }

        // Second pass: resolve depends_on (title → id)
        const updateDeps = getDb().prepare('UPDATE tasks SET depends_on = ? WHERE id = ?');
        const dispatchTargets: string[] = [];

        for (const st of result.subtasks!) {
          const subtaskId = titleToIdMap.get(st.title)!;
          if (st.depends_on && st.depends_on.length > 0) {
            const depIds = st.depends_on
              .map(title => titleToIdMap.get(title))
              .filter((id): id is string => !!id);
            updateDeps.run(JSON.stringify(depIds), subtaskId);
          } else {
            // No dependencies — eligible for immediate dispatch
            dispatchTargets.push(subtaskId);
          }
        }

        // Auto-dispatch subtasks with no dependencies
        const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
        for (const subtaskId of dispatchTargets) {
          fetch(`${baseUrl}/api/tasks/${subtaskId}/dispatch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }).then(async (res) => {
            if (res.ok) {
              syslog('info', 'dispatch', `Subtask ${subtaskId} dispatched successfully`);
            } else {
              const text = await res.text();
              syslog('error', 'dispatch', `Subtask ${subtaskId} dispatch failed (${res.status})`, text);
            }
          }).catch(err => {
            syslog('error', 'dispatch', `Subtask ${subtaskId} dispatch error`, { error: (err as Error).message });
          });
        }

        syslog('info', 'planning', `Created ${subtaskIds.length} subtasks for task ${taskId}, dispatching ${dispatchTargets.length} immediately`);

        return NextResponse.json({
          complete: true,
          spec: result.spec,
          agents: result.agents,
          subtasks: result.subtasks,
          subtaskCount: subtaskIds.length,
          executionPlan: result.execution_plan,
          messages,
          autoDispatched: true,
        });
      }

      // === SINGLE-AGENT PATH (unchanged) ===
      getDb().prepare(`
        UPDATE tasks
        SET planning_messages = ?,
            planning_complete = 1,
            planning_spec = ?,
            planning_agents = ?,
            model_provider = COALESCE(model_provider, ?),
            model = COALESCE(model, ?),
            status = 'inbox'
        WHERE id = ?
      `).run(
        JSON.stringify(messages),
        JSON.stringify(result.spec),
        JSON.stringify(result.agents),
        suggestedModel?.provider || null,
        suggestedModel?.model || null,
        taskId
      );

      // Create the agents in the workspace and track first agent for auto-assign
      let firstAgentId: string | null = null;

      if (result.agents && result.agents.length > 0) {
        const insertAgent = getDb().prepare(`
          INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, skills, created_at, updated_at)
          VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, ?, datetime('now'), datetime('now'))
        `);

        for (const agent of result.agents) {
          const agentId = crypto.randomUUID();
          if (!firstAgentId) firstAgentId = agentId;

          insertAgent.run(
            agentId,
            taskId,
            agent.name,
            agent.role,
            agent.instructions || '',
            agent.avatar_emoji || '🤖',
            agent.soul_md || '',
            JSON.stringify(agent.skills || [])
          );
        }
      }

      // AUTO-DISPATCH: Assign to first agent and trigger dispatch
      if (firstAgentId) {
        getDb().prepare(`
          UPDATE tasks SET assigned_agent_id = ? WHERE id = ?
        `).run(firstAgentId, taskId);

        syslog('info', 'dispatch', `Auto-assigned task ${taskId} to agent ${firstAgentId}`);

        const dispatchUrl = `http://localhost:${process.env.PORT || 3000}/api/tasks/${taskId}/dispatch`;
        syslog('info', 'dispatch', `Triggering dispatch: ${dispatchUrl}`);

        try {
          const dispatchRes = await fetch(dispatchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });

          if (dispatchRes.ok) {
            const dispatchData = await dispatchRes.json();
            syslog('info', 'dispatch', `Dispatch successful for task ${taskId}`, dispatchData);
          } else {
            const errorText = await dispatchRes.text();
            syslog('error', 'dispatch', `Dispatch failed (${dispatchRes.status}) for task ${taskId}`, errorText);
          }
        } catch (err) {
          syslog('error', 'dispatch', `Auto-dispatch error for task ${taskId}`, { error: (err as Error).message });
        }
      }

      return NextResponse.json({
        complete: true,
        spec: result.spec,
        agents: result.agents,
        executionPlan: result.execution_plan,
        messages,
        autoDispatched: !!firstAgentId,
      });
    }

    // Not complete — return next question
    getDb().prepare(`
      UPDATE tasks SET planning_messages = ? WHERE id = ?
    `).run(JSON.stringify(messages), taskId);

    return NextResponse.json({
      complete: false,
      currentQuestion: result,
      messages,
    });
  } catch (error) {
    syslog('error', 'planning', `Failed to submit answer: ${(error as Error).message}`, { taskId, stack: (error as Error).stack });
    return NextResponse.json({ error: 'Failed to submit answer: ' + (error as Error).message }, { status: 500 });
  }
}
