'use client';

import { useState, useEffect } from 'react';
import { Plus, ChevronRight, Zap, ZapOff, Loader2, Cpu } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus, OpenClawSession, OpenClawSessionInfo } from '@/lib/types';
import { AgentModal } from './AgentModal';

type FilterTab = 'all' | 'working' | 'standby';

interface AgentsSidebarProps {
  workspaceId?: string;
}

export function AgentsSidebar({ workspaceId }: AgentsSidebarProps) {
  const { agents, selectedAgent, setSelectedAgent, agentOpenClawSessions, setAgentOpenClawSession } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  // Map: openclaw_session_id -> session info (model, status)
  const [sessionInfoMap, setSessionInfoMap] = useState<Record<string, OpenClawSessionInfo>>({});

  // Load OpenClaw session status for all agents on mount
  useEffect(() => {
    const loadOpenClawSessions = async () => {
      for (const agent of agents) {
        try {
          const res = await fetch(`/api/agents/${agent.id}/openclaw`);
          if (res.ok) {
            const data = await res.json();
            if (data.linked && data.session) {
              setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
            }
          }
        } catch (error) {
          console.error(`Failed to load OpenClaw session for ${agent.name}:`, error);
        }
      }
    };
    if (agents.length > 0) {
      loadOpenClawSessions();
    }
  }, [agents.length]);

  // Load active sub-agent count
  useEffect(() => {
    const loadSubAgentCount = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch (error) {
        console.error('Failed to load sub-agent count:', error);
      }
    };

    loadSubAgentCount();

    // Poll every 10 seconds to keep count updated
    const interval = setInterval(loadSubAgentCount, 10000);
    return () => clearInterval(interval);
  }, []);

  // Poll OpenClaw gateway for session model info
  useEffect(() => {
    const loadSessionInfo = async () => {
      try {
        const res = await fetch('/api/openclaw/status');
        if (res.ok) {
          const data = await res.json();
          if (data.connected && Array.isArray(data.sessions)) {
            const map: Record<string, OpenClawSessionInfo> = {};
            for (const s of data.sessions as OpenClawSessionInfo[]) {
              map[s.id] = s;
            }
            setSessionInfoMap(map);
          }
        }
      } catch {
        // Silently fail — sidebar info is supplementary
      }
    };

    loadSessionInfo();
    const interval = setInterval(loadSessionInfo, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleConnectToOpenClaw = async (agent: Agent, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent selecting the agent
    setConnectingAgentId(agent.id);

    try {
      const existingSession = agentOpenClawSessions[agent.id];

      if (existingSession) {
        // Disconnect
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'DELETE' });
        if (res.ok) {
          setAgentOpenClawSession(agent.id, null);
        }
      } else {
        // Connect
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
        } else {
          const error = await res.json();
          console.error('Failed to connect to OpenClaw:', error);
          alert(`Failed to connect: ${error.error || 'Unknown error'}`);
        }
      }
    } catch (error) {
      console.error('OpenClaw connection error:', error);
    } finally {
      setConnectingAgentId(null);
    }
  };

  const filteredAgents = agents.filter((agent) => {
    if (filter === 'all') return true;
    return agent.status === filter;
  });

  const getStatusBadge = (status: AgentStatus) => {
    const styles = {
      standby: 'status-standby',
      working: 'status-working',
      offline: 'status-offline',
    };
    return styles[status] || styles.standby;
  };

  return (
    <aside className="w-64 bg-mc-bg-secondary border-r border-mc-border flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-mc-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ChevronRight className="w-4 h-4 text-mc-text-secondary" />
            <span className="text-sm font-medium uppercase tracking-wider">Agents</span>
            <span className="bg-mc-bg-tertiary text-mc-text-secondary text-xs px-2 py-0.5 rounded">
              {agents.length}
            </span>
          </div>
        </div>

        {/* Active Sub-Agents Counter */}
        {activeSubAgents > 0 && (
          <div className="mb-3 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-green-400">●</span>
              <span className="text-mc-text">Active Sub-Agents:</span>
              <span className="font-bold text-green-400">{activeSubAgents}</span>
            </div>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="flex gap-1">
          {(['all', 'working', 'standby'] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1 text-xs rounded uppercase ${
                filter === tab
                  ? 'bg-mc-accent text-mc-bg font-medium'
                  : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredAgents.map((agent) => {
          const openclawSession = agentOpenClawSessions[agent.id];
          const isConnecting = connectingAgentId === agent.id;

          return (
            <div
              key={agent.id}
              className={`w-full rounded hover:bg-mc-bg-tertiary transition-colors ${
                selectedAgent?.id === agent.id ? 'bg-mc-bg-tertiary' : ''
              }`}
            >
              <button
                onClick={() => {
                  setSelectedAgent(agent);
                  setEditingAgent(agent);
                }}
                className="w-full flex items-center gap-3 p-2 text-left"
              >
                {/* Avatar */}
                <div className="text-2xl relative">
                  {agent.avatar_emoji}
                  {openclawSession && (
                    <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-mc-bg-secondary" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{agent.name}</span>
                    {!!agent.is_master && (
                      <span className="text-xs text-mc-accent-yellow">★</span>
                    )}
                  </div>
                  <div className="text-xs text-mc-text-secondary truncate">
                    {agent.role}
                  </div>
                  {/* Model info from gateway session or agent config */}
                  {(() => {
                    // Try to find live model from gateway session
                    const ocSession = openclawSession;
                    const sessionKey = ocSession ? `agent:main:${ocSession.openclaw_session_id}` : null;
                    const liveInfo = sessionKey ? sessionInfoMap[sessionKey] : null;
                    const modelName = liveInfo?.model || agent.model;
                    if (!modelName) return null;
                    return (
                      <div className="flex items-center gap-1 mt-0.5">
                        <Cpu className="w-3 h-3 text-purple-400 flex-shrink-0" />
                        <span className="text-[10px] font-mono text-purple-400 truncate">{modelName}</span>
                      </div>
                    );
                  })()}
                </div>

                {/* Status */}
                <span
                  className={`text-xs px-2 py-0.5 rounded uppercase ${getStatusBadge(
                    agent.status
                  )}`}
                >
                  {agent.status}
                </span>
              </button>

              {/* OpenClaw Connect Button - show for master agents */}
              {!!agent.is_master && (
                <div className="px-2 pb-2">
                  <button
                    onClick={(e) => handleConnectToOpenClaw(agent, e)}
                    disabled={isConnecting}
                    className={`w-full flex items-center justify-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                      openclawSession
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-mc-bg text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text'
                    }`}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Connecting...</span>
                      </>
                    ) : openclawSession ? (
                      <>
                        <Zap className="w-3 h-3" />
                        <span>OpenClaw Connected</span>
                      </>
                    ) : (
                      <>
                        <ZapOff className="w-3 h-3" />
                        <span>Connect to OpenClaw</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Agent Button */}
      <div className="p-3 border-t border-mc-border">
        <button
          onClick={() => setShowCreateModal(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-mc-bg-tertiary hover:bg-mc-border rounded text-sm text-mc-text-secondary hover:text-mc-text transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Agent
        </button>
      </div>

      {/* Modals */}
      {showCreateModal && (
        <AgentModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />
      )}
      {editingAgent && (
        <AgentModal
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          workspaceId={workspaceId}
        />
      )}
    </aside>
  );
}
