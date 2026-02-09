// OpenClaw Gateway WebSocket Client

import { EventEmitter } from 'events';
import type { OpenClawMessage, OpenClawSessionInfo } from '../types';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

export class OpenClawClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageId = 0;
  private pendingRequests = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private connected = false;
  private authenticated = false; // Track auth state separately from connection state
  private connecting: Promise<void> | null = null; // Lock to prevent multiple simultaneous connection attempts
  private autoReconnect = true;
  private token: string;

  constructor(private url: string = GATEWAY_URL, token: string = GATEWAY_TOKEN) {
    super();
    this.token = token;
    // Prevent Node.js from throwing on unhandled 'error' events
    this.on('error', () => {});
  }

  async connect(): Promise<void> {
    // If already connected, return immediately
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // If a connection attempt is already in progress, wait for it
    if (this.connecting) {
      return this.connecting;
    }

    // Create a new connection attempt
    this.connecting = new Promise((resolve, reject) => {
      try {
        // Clean up any existing connection
        if (this.ws) {
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.onmessage = null;
          this.ws.onopen = null;
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
          }
          this.ws = null;
        }

        // Add token to URL query string for Gateway authentication
        const wsUrl = new URL(this.url);
        if (this.token) {
          wsUrl.searchParams.set('token', this.token);
        }
        console.log('[OpenClaw] Connecting to:', wsUrl.toString().replace(/token=[^&]+/, 'token=***'));
        console.log('[OpenClaw] Token in URL:', wsUrl.searchParams.has('token'));
        this.ws = new WebSocket(wsUrl.toString());

        const connectionTimeout = setTimeout(() => {
          if (!this.connected) {
            this.ws?.close();
            reject(new Error('Connection timeout'));
          }
        }, 10000); // 10 second connection timeout

        this.ws.onopen = async () => {
          clearTimeout(connectionTimeout);
          console.log('[OpenClaw] WebSocket opened, waiting for challenge...');
          // Don't send anything yet - wait for Gateway challenge
          // Token is in URL query string
        };

        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          const wasConnected = this.connected;
          this.connected = false;
          this.authenticated = false;
          this.connecting = null;
          this.emit('disconnected');
          // Log close reason for debugging
          console.log(`[OpenClaw] Disconnected from Gateway (code: ${event.code}, reason: "${event.reason}", wasClean: ${event.wasClean})`);
          // Only auto-reconnect if we were previously connected (not on initial connection failure)
          if (this.autoReconnect && wasConnected) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          console.error('[OpenClaw] WebSocket error');
          this.emit('error', error);
          if (!this.connected) {
            this.connecting = null;
            reject(new Error('Failed to connect to OpenClaw Gateway'));
          }
        };

        this.ws.onmessage = (event) => {
          console.log('[OpenClaw] Received:', event.data);
          try {
            const data = JSON.parse(event.data as string);

            // Handle challenge-response authentication (OpenClaw RequestFrame format)
            if (data.type === 'event' && data.event === 'connect.challenge') {
              console.log('[OpenClaw] Challenge received, responding...');
              const requestId = crypto.randomUUID();
              const response = {
                type: 'req',
                id: requestId,
                method: 'connect',
                params: {
                  minProtocol: 3,
                  maxProtocol: 3,
                  client: {
                    id: 'gateway-client',
                    version: '1.0.0',
                    platform: 'web',
                    mode: 'ui'
                  },
                  auth: {
                    token: this.token
                  }
                }
              };

              // Set up response handler
              this.pendingRequests.set(requestId, {
                resolve: () => {
                  this.connected = true;
                  this.authenticated = true;
                  this.connecting = null;
                  this.emit('connected');
                  console.log('[OpenClaw] Authenticated successfully');
                  resolve();
                },
                reject: (error: Error) => {
                  this.connecting = null;
                  this.ws?.close();
                  reject(new Error(`Authentication failed: ${error.message}`));
                }
              });

              console.log('[OpenClaw] Sending challenge response');
              this.ws!.send(JSON.stringify(response));
              return;
            }

            // Handle RPC responses and other messages
            this.handleMessage(data as OpenClawMessage);
          } catch (err) {
            console.error('[OpenClaw] Failed to parse message:', err);
          }
        };
      } catch (err) {
        this.connecting = null;
        reject(err);
      }
    });

    return this.connecting;
  }

  private handleMessage(data: OpenClawMessage & { type?: string; ok?: boolean; payload?: unknown }): void {
    // Handle OpenClaw ResponseFrame format (type: "res")
    if (data.type === 'res' && data.id !== undefined) {
      const requestId = data.id as string | number;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        const { resolve, reject } = pending;
        this.pendingRequests.delete(requestId);

        if (data.ok === false && data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.payload);
        }
        return;
      }
    }

    // Handle legacy JSON-RPC responses
    const legacyId = data.id as string | number | undefined;
    if (legacyId !== undefined && this.pendingRequests.has(legacyId)) {
      const { resolve, reject } = this.pendingRequests.get(legacyId)!;
      this.pendingRequests.delete(legacyId);

      if (data.error) {
        reject(new Error(data.error.message));
      } else {
        resolve(data.result);
      }
      return;
    }

    // Handle events/notifications
    if (data.method) {
      this.emit('notification', data);
      this.emit(data.method, data.params);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.autoReconnect) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.autoReconnect) return;

      console.log('[OpenClaw] Attempting reconnect...');
      try {
        await this.connect();
      } catch {
        // Don't spam logs on reconnect failure, just schedule another attempt
        this.scheduleReconnect();
      }
    }, 10000); // 10 seconds between reconnect attempts
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || !this.connected || !this.authenticated) {
      throw new Error('Not connected to OpenClaw Gateway');
    }

    const id = crypto.randomUUID();
    const message = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);

      this.ws!.send(JSON.stringify(message));
    });
  }

  // Session management methods
  async listSessions(): Promise<OpenClawSessionInfo[]> {
    return this.call<OpenClawSessionInfo[]>('sessions.list');
  }

  async getSessionHistory(sessionId: string): Promise<unknown[]> {
    return this.call<unknown[]>('sessions.history', { session_id: sessionId });
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    await this.call('sessions.send', { session_id: sessionId, content });
  }

  async createSession(channel: string, peer?: string): Promise<OpenClawSessionInfo> {
    return this.call<OpenClawSessionInfo>('sessions.create', { channel, peer });
  }

  // Node methods (device capabilities)
  async listNodes(): Promise<unknown[]> {
    return this.call<unknown[]>('node.list');
  }

  async describeNode(nodeId: string): Promise<unknown> {
    return this.call('node.describe', { node_id: nodeId });
  }

  disconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnect on intentional close
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.connecting = null;
  }

  isConnected(): boolean {
    return this.connected && this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
    if (!enabled && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// Singleton instance for server-side usage
let clientInstance: OpenClawClient | null = null;

export function getOpenClawClient(): OpenClawClient {
  if (!clientInstance) {
    clientInstance = new OpenClawClient();
  }
  return clientInstance;
}

// --- llm-task HTTP client ---

function getGatewayHttpUrl(): string {
  const wsUrl = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://');
}

export interface LlmTaskArgs {
  prompt: string;
  input?: unknown;
  schema?: object;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function invokeLlmTask<T>(args: LlmTaskArgs): Promise<T> {
  // Dynamic import to avoid circular dependency issues at module init
  const { syslog } = await import('@/lib/logger');

  const httpUrl = getGatewayHttpUrl();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';

  syslog('info', 'llm-task', `Invoking llm-task (${args.prompt.substring(0, 60)}...)`, {
    model: args.model,
    maxTokens: args.maxTokens,
  });

  const res = await fetch(`${httpUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      tool: 'llm-task',
      action: 'json',
      args: {
        prompt: args.prompt,
        ...(args.input !== undefined ? { input: args.input } : {}),
        ...(args.schema ? { schema: args.schema } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    syslog('error', 'llm-task', `HTTP ${res.status} from gateway`, text);
    throw new Error(`llm-task failed (${res.status}): ${text}`);
  }

  const body = await res.json();

  if (body.ok === false) {
    const errMsg = body.error?.message ?? JSON.stringify(body);
    syslog('error', 'llm-task', `Gateway returned error: ${errMsg}`, body);
    throw new Error(`llm-task error: ${errMsg}`);
  }

  // Response shape: { ok, result: { content: [...], details: { json, provider, model } } }
  // The pre-parsed JSON is in result.details.json
  const json = body.result?.details?.json;
  if (json !== undefined) {
    syslog('info', 'llm-task', `Response OK (provider: ${body.result?.details?.provider ?? 'unknown'}, model: ${body.result?.details?.model ?? 'unknown'})`);
    return json as T;
  }

  // Fallback: parse from content text
  const text = body.result?.content?.[0]?.text;
  if (text) {
    syslog('info', 'llm-task', 'Response OK (parsed from content text)');
    return JSON.parse(text) as T;
  }

  syslog('error', 'llm-task', 'No usable result from gateway', body);
  throw new Error('llm-task returned no usable result');
}

// --- Planning response schema & types ---

export interface PlanningQuestionResponse {
  type: 'question';
  question: string;
  options: Array<{ id: string | number; label: string }>;
}

export interface PlanningCompleteResponse {
  type: 'complete';
  spec: {
    title: string;
    summary: string;
    deliverables: string[];
    success_criteria: string[];
    constraints: Record<string, unknown>;
  };
  agents: Array<{
    name: string;
    role: string;
    avatar_emoji?: string;
    soul_md?: string;
    instructions?: string;
    skills?: string[];
  }>;
  execution_plan: {
    approach: string;
    steps: string[];
  };
  suggested_model?: {
    provider: string;
    model: string;
  };
}

export type PlanningResponse = PlanningQuestionResponse | PlanningCompleteResponse;

// Minimal gateway schema — just ensures the LLM returns a JSON object with a
// `type` string. All real validation happens in normalisePlanningResponse()
// so we can handle local-model quirks (wrong types, objects instead of
// strings, etc.) gracefully instead of getting a 400 from the gateway.
export const PLANNING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string' },
  },
  required: ['type'],
} as const;

/** Convert any value to a useful string (handles objects the LLM returns instead of strings). */
function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    // Common pattern: LLM returns { title: "...", description: "..." } instead of a string
    const obj = v as Record<string, unknown>;
    return obj.title ? String(obj.title) + (obj.description ? ` — ${obj.description}` : '')
      : obj.name ? String(obj.name) + (obj.description ? ` — ${obj.description}` : '')
      : JSON.stringify(v);
  }
  return String(v ?? '');
}

/**
 * Normalise raw LLM output into a valid PlanningResponse.
 * Local models sometimes use wrong `type` values or omit fields —
 * we infer the intent from whatever fields are actually present.
 */
export function normalisePlanningResponse(raw: Record<string, unknown>): PlanningResponse {
  // Infer type from fields present if the `type` value is non-standard
  const declaredType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const hasQuestion = typeof raw.question === 'string' && Array.isArray(raw.options);
  const hasSpec = raw.spec && typeof raw.spec === 'object';

  let type: 'question' | 'complete';
  if (declaredType === 'question' || declaredType === 'ask') {
    type = 'question';
  } else if (declaredType === 'complete' || declaredType === 'done' || declaredType === 'finished') {
    type = 'complete';
  } else if (hasQuestion) {
    type = 'question';
  } else if (hasSpec) {
    type = 'complete';
  } else {
    throw new Error(`Could not determine planning response type (got "${raw.type}")`);
  }

  if (type === 'question') {
    const options = Array.isArray(raw.options)
      ? (raw.options as Array<Record<string, unknown>>).map((o, i) => ({
          id: o.id ?? String(i + 1),
          label: typeof o.label === 'string' ? o.label : String(o.label ?? `Option ${i + 1}`),
        }))
      : [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }];

    return {
      type: 'question',
      question: typeof raw.question === 'string' ? raw.question : 'Could you clarify?',
      options: options as Array<{ id: string | number; label: string }>,
    };
  }

  // type === 'complete'
  const spec = (raw.spec ?? {}) as Record<string, unknown>;
  const agents = Array.isArray(raw.agents)
    ? (raw.agents as Array<Record<string, unknown>>).map(a => ({
        name: String(a.name ?? 'Agent'),
        role: String(a.role ?? 'General'),
        avatar_emoji: typeof a.avatar_emoji === 'string' ? a.avatar_emoji : undefined,
        soul_md: typeof a.soul_md === 'string' ? a.soul_md : undefined,
        instructions: typeof a.instructions === 'string' ? a.instructions : undefined,
        skills: Array.isArray(a.skills) ? a.skills.map(String) : undefined,
      }))
    : [{ name: 'Agent', role: 'General' }];

  const execPlan = (raw.execution_plan ?? {}) as Record<string, unknown>;

  // Extract model suggestion if present
  const rawModel = raw.suggested_model as Record<string, unknown> | undefined;
  const suggested_model = rawModel && typeof rawModel === 'object'
    ? { provider: String(rawModel.provider ?? ''), model: String(rawModel.model ?? '') }
    : undefined;

  return {
    type: 'complete',
    spec: {
      title: String(spec.title ?? 'Untitled'),
      summary: String(spec.summary ?? ''),
      deliverables: Array.isArray(spec.deliverables) ? spec.deliverables.map(stringify) : [],
      success_criteria: Array.isArray(spec.success_criteria) ? spec.success_criteria.map(stringify) : [],
      constraints: (typeof spec.constraints === 'object' && spec.constraints && !Array.isArray(spec.constraints)) ? spec.constraints as Record<string, unknown> : {},
    },
    agents,
    execution_plan: {
      approach: String(execPlan.approach ?? ''),
      steps: Array.isArray(execPlan.steps) ? execPlan.steps.map(stringify) : [],
    },
    suggested_model,
  };
}
