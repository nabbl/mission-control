/**
 * Lenient parser for OpenClaw `sessions.history` output.
 *
 * The gateway returns `unknown[]` and the shape varies between providers
 * (Claude API, OpenAI, plain text, etc.). This parser handles all known
 * formats and falls back gracefully for unknown ones.
 */

import type { TranscriptEntry } from '../types';

let loggedRawOnce = false;

/** Log the raw history format once per server lifetime for debugging. */
function logRawFormat(raw: unknown[]): void {
  if (loggedRawOnce || raw.length === 0) return;
  loggedRawOnce = true;
  console.log('[parseHistory] Raw history sample (first entry):', JSON.stringify(raw[0], null, 2));
}

/** Deterministic ID from index so React keys stay stable across polls. */
function entryId(index: number): string {
  return `te-${index}`;
}

/**
 * Claude API content block — the assistant message may contain an array of these.
 * We split them into separate TranscriptEntries for tool calls / text.
 */
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | unknown[];
  is_error?: boolean;
}

function isContentBlockArray(v: unknown): v is ContentBlock[] {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'type' in v[0];
}

function parseContentBlocks(blocks: ContentBlock[], baseIndex: number, role: string, timestamp?: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let subIdx = 0;

  for (const block of blocks) {
    const id = `${entryId(baseIndex)}-${subIdx++}`;

    if (block.type === 'text' && block.text) {
      entries.push({
        id,
        role: role as TranscriptEntry['role'],
        content: block.text,
        timestamp,
      });
    } else if (block.type === 'tool_use') {
      entries.push({
        id,
        role: 'tool_call',
        content: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}, null, 2),
        toolName: block.name ?? 'unknown',
        toolCallId: block.id,
        timestamp,
      });
    } else if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((c: unknown) => {
              if (typeof c === 'object' && c !== null && 'text' in c) return (c as { text: string }).text;
              return JSON.stringify(c);
            }).join('\n')
          : JSON.stringify(block.content ?? '');

      entries.push({
        id,
        role: 'tool_result',
        content: resultContent,
        toolCallId: block.tool_use_id,
        isError: block.is_error ?? false,
        timestamp,
      });
    } else {
      // Unknown block type — render as text
      entries.push({
        id,
        role: role as TranscriptEntry['role'],
        content: block.text ?? JSON.stringify(block),
        timestamp,
      });
    }
  }

  return entries;
}

export function parseSessionHistory(raw: unknown[]): TranscriptEntry[] {
  logRawFormat(raw);

  const entries: TranscriptEntry[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];

    // Case 1: Standard chat message { role, content: string }
    if (typeof item === 'object' && item !== null && 'role' in item) {
      const msg = item as Record<string, unknown>;
      const role = String(msg.role ?? 'user');
      const timestamp = msg.timestamp as string | undefined;

      // Content might be a string or an array of content blocks
      if (typeof msg.content === 'string') {
        entries.push({
          id: entryId(entries.length),
          role: normalizeRole(role),
          content: msg.content,
          timestamp,
        });
      } else if (isContentBlockArray(msg.content)) {
        entries.push(...parseContentBlocks(msg.content, entries.length, normalizeRole(role), timestamp));
      } else if (Array.isArray(msg.content)) {
        // Array but not content blocks — join as text
        const text = msg.content.map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (typeof c === 'object' && c !== null && 'text' in c) return (c as { text: string }).text;
          return JSON.stringify(c);
        }).join('\n');
        entries.push({
          id: entryId(entries.length),
          role: normalizeRole(role),
          content: text,
          timestamp,
        });
      } else {
        entries.push({
          id: entryId(entries.length),
          role: normalizeRole(role),
          content: JSON.stringify(msg.content),
          timestamp,
        });
      }
    }
    // Case 2: Plain string
    else if (typeof item === 'string') {
      entries.push({
        id: entryId(entries.length),
        role: 'system',
        content: item,
      });
    }
    // Case 3: Unknown object — render as system JSON
    else {
      entries.push({
        id: entryId(entries.length),
        role: 'system',
        content: JSON.stringify(item, null, 2),
      });
    }
  }

  return entries;
}

function normalizeRole(role: string): TranscriptEntry['role'] {
  switch (role.toLowerCase()) {
    case 'user':
    case 'human':
      return 'user';
    case 'assistant':
    case 'bot':
    case 'ai':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
    case 'tool_result':
      return 'tool_result';
    default:
      return 'assistant';
  }
}
