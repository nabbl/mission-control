import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  invokeLlmTask,
  PLANNING_RESPONSE_SCHEMA,
  normalisePlanningResponse,
  type PlanningResponse,
} from '@/lib/openclaw/client';
import { syslog } from '@/lib/logger';

// Planning session prefix (kept for DB marker compatibility)
const PLANNING_SESSION_PREFIX = 'agent:main:planning:';

// Backward-compat fallback for old-format messages already in the DB
function extractJSON(text: string): object | null {
  try {
    return JSON.parse(text.trim());
  } catch {
    // Continue
  }
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue
    }
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue
    }
  }
  return null;
}

// GET /api/tasks/[id]/planning - Get planning state
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_spec?: string;
      planning_agents?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];

    // Find current question from last assistant message
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion = null;

    if (lastAssistantMessage) {
      try {
        const parsed = JSON.parse(lastAssistantMessage.content);
        if (parsed.type === 'question') {
          currentQuestion = parsed;
        }
      } catch {
        // Backward compat: try extractJSON for old-format messages
        const parsed = extractJSON(lastAssistantMessage.content);
        if (parsed && 'question' in parsed) {
          currentQuestion = parsed;
        }
      }
    }

    return NextResponse.json({
      taskId,
      sessionKey: task.planning_session_key,
      messages,
      currentQuestion,
      isComplete: !!task.planning_complete,
      spec: task.planning_spec ? JSON.parse(task.planning_spec) : null,
      agents: task.planning_agents ? JSON.parse(task.planning_agents) : null,
      isStarted: messages.length > 0,
    });
  } catch (error) {
    console.error('Failed to get planning state:', error);
    return NextResponse.json({ error: 'Failed to get planning state' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/planning - Start planning session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      planning_session_key?: string;
      planning_messages?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.planning_session_key) {
      return NextResponse.json({ error: 'Planning already started', sessionKey: task.planning_session_key }, { status: 400 });
    }

    const sessionKey = `${PLANNING_SESSION_PREFIX}${taskId}`;

    const planningPrompt = `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}

You are starting a planning session for this task. Your goal is to ask clarifying questions to understand what the user needs, then produce a complete plan.

Generate your FIRST question to understand what the user needs. Remember:
- Questions must be multiple choice with 2-5 options
- Include an "Other" option with id "other"
- Be specific to THIS task, not generic

You MUST respond with a JSON object containing a "type" field set to "question".`;

    // Store session key marker + initial user message
    const messages = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];

    getDb().prepare(`
      UPDATE tasks
      SET planning_session_key = ?, planning_messages = ?, status = 'planning'
      WHERE id = ?
    `).run(sessionKey, JSON.stringify(messages), taskId);

    // Call llm-task for structured response
    syslog('info', 'planning', `Starting planning for task "${task.title}"`, { taskId });

    const raw = await invokeLlmTask<Record<string, unknown>>({
      prompt: planningPrompt,
      schema: PLANNING_RESPONSE_SCHEMA,
      temperature: 0.7,
      maxTokens: 800,
    });

    const result = normalisePlanningResponse(raw);
    syslog('info', 'planning', `Planning started — first question generated`, { taskId, type: result.type });

    // Store response
    messages.push({ role: 'assistant', content: JSON.stringify(result), timestamp: Date.now() });

    getDb().prepare(`
      UPDATE tasks SET planning_messages = ? WHERE id = ?
    `).run(JSON.stringify(messages), taskId);

    const currentQuestion = result.type === 'question' ? result : null;

    return NextResponse.json({
      success: true,
      sessionKey,
      currentQuestion,
      messages,
    });
  } catch (error) {
    syslog('error', 'planning', `Failed to start planning: ${(error as Error).message}`, { taskId, stack: (error as Error).stack });
    return NextResponse.json({ error: 'Failed to start planning: ' + (error as Error).message }, { status: 500 });
  }
}
