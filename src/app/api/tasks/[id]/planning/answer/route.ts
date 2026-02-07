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
      syslog('info', 'planning', `Planning complete for task ${taskId} — creating ${result.agents?.length ?? 0} agents, suggested model: ${suggestedModel?.provider ?? 'default'}/${suggestedModel?.model ?? 'default'}`);

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
          INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, created_at, updated_at)
          VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, datetime('now'), datetime('now'))
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
            agent.soul_md || ''
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
