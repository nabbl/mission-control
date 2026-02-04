import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Planning session prefix for OpenClaw (must match agent:main: format)
const PLANNING_SESSION_PREFIX = 'agent:main:planning:';

// Helper to get messages from transcript file directly
function getMessagesFromTranscript(sessionKey: string): Array<{ role: string; content: string }> {
  try {
    // Get session info to find transcript path
    const sessionsDir = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
    const sessionsFile = join(sessionsDir, 'sessions.json');
    
    if (!existsSync(sessionsFile)) return [];
    
    const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
    const session = Object.values(sessions).find((s: unknown) => 
      (s as { key: string }).key === sessionKey
    ) as { transcriptPath?: string; sessionId?: string } | undefined;
    
    if (!session) return [];
    
    // Try to find transcript file
    const transcriptPath = session.transcriptPath 
      ? join(sessionsDir, session.transcriptPath)
      : join(sessionsDir, `${session.sessionId}.jsonl`);
    
    if (!existsSync(transcriptPath)) return [];
    
    // Parse JSONL transcript
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');
    const messages: Array<{ role: string; content: string }> = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message?.role === 'assistant') {
          // Extract text content from assistant messages
          const textContent = entry.message.content?.find((c: { type: string }) => c.type === 'text');
          if (textContent?.text) {
            messages.push({
              role: 'assistant',
              content: textContent.text
            });
          }
        }
      } catch {
        // Skip invalid lines
      }
    }
    
    return messages;
  } catch (err) {
    console.error('[Planning] Failed to read transcript:', err);
    return [];
  }
}

// GET /api/tasks/[id]/planning - Get planning state
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
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

    // Parse planning messages from JSON
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    
    // Find the latest question (last assistant message with question structure)
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion = null;
    
    if (lastAssistantMessage) {
      try {
        // Try to parse as structured planning response
        const parsed = JSON.parse(lastAssistantMessage.content);
        if (parsed.question) {
          currentQuestion = parsed;
        }
      } catch {
        // Not JSON, might be a plain message
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
    // Get task
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

    // Check if planning already started
    if (task.planning_session_key) {
      return NextResponse.json({ error: 'Planning already started', sessionKey: task.planning_session_key }, { status: 400 });
    }

    // Create session key for this planning task
    const sessionKey = `${PLANNING_SESSION_PREFIX}${taskId}`;

    // Build the initial planning prompt
    const planningPrompt = `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}

You are starting a planning session for this task. Read PLANNING.md for your protocol.

Generate your FIRST question to understand what the user needs. Remember:
- Questions must be multiple choice
- Include an "Other" option
- Be specific to THIS task, not generic

Respond with ONLY valid JSON in this format:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "C", "label": "Third option"},
    {"id": "other", "label": "Other"}
  ]
}`;

    // Connect to OpenClaw and send the planning request
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Send planning request to the main session with a special marker
    // The message will be processed by Charlie who will respond with questions
    await client.call('chat.send', {
      sessionKey: sessionKey,
      message: planningPrompt,
      idempotencyKey: `planning-start-${taskId}-${Date.now()}`,
    });

    // Store the session key and initial message
    const messages = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];
    
    getDb().prepare(`
      UPDATE tasks 
      SET planning_session_key = ?, planning_messages = ?, status = 'planning'
      WHERE id = ?
    `).run(sessionKey, JSON.stringify(messages), taskId);

    // Poll for response (give OpenClaw time to process)
    // Read directly from transcript file as primary method
    let response = null;
    for (let i = 0; i < 30; i++) { // Poll for up to 30 seconds
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Read messages directly from transcript file
      const transcriptMessages = getMessagesFromTranscript(sessionKey);
      console.log('[Planning] Transcript messages:', transcriptMessages.length);
      
      if (transcriptMessages.length > 0) {
        // Get the last assistant message
        const lastAssistant = [...transcriptMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          response = lastAssistant.content;
          console.log('[Planning] Found response in transcript');
          break;
        }
      }
    }

    if (response) {
      // Parse and store the response
      try {
        const parsed = JSON.parse(response);
        messages.push({ role: 'assistant', content: response, timestamp: Date.now() });
        
        getDb().prepare(`
          UPDATE tasks SET planning_messages = ? WHERE id = ?
        `).run(JSON.stringify(messages), taskId);

        return NextResponse.json({
          success: true,
          sessionKey,
          currentQuestion: parsed,
          messages,
        });
      } catch {
        // Response wasn't valid JSON, store it anyway
        messages.push({ role: 'assistant', content: response, timestamp: Date.now() });
        getDb().prepare(`
          UPDATE tasks SET planning_messages = ? WHERE id = ?
        `).run(JSON.stringify(messages), taskId);

        return NextResponse.json({
          success: true,
          sessionKey,
          rawResponse: response,
          messages,
        });
      }
    }

    return NextResponse.json({
      success: true,
      sessionKey,
      messages,
      note: 'Planning started, waiting for response. Poll GET endpoint for updates.',
    });
  } catch (error) {
    console.error('Failed to start planning:', error);
    return NextResponse.json({ error: 'Failed to start planning: ' + (error as Error).message }, { status: 500 });
  }
}
