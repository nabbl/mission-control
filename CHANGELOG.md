# Changelog

All notable changes to Mission Control will be documented in this file.

## [Unreleased]

### Added
- **Task Auto-Dispatch**: Tasks automatically dispatch to agent's OpenClaw session when moved to ASSIGNED status
- **Agent Completion Detection**: Agents can report completion via TASK_COMPLETE message, auto-moves to REVIEW
- **Review Workflow Enforcement**: Only master agent (Charlie) can move tasks from REVIEW to DONE
- **Task Dispatch API** (`POST /api/tasks/[id]/dispatch`): Manually trigger task dispatch to agent
- **Agent Completion Webhook** (`POST /api/webhooks/agent-completion`): Receive completion notifications from agents

### Changed
- Task status transitions now trigger OpenClaw integration automatically
- PATCH /api/tasks/[id] now enforces review workflow rules

### Technical Details
- Auto-dispatch occurs on status change: `* → assigned`
- Agent completion message format: `TASK_COMPLETE: [summary]`
- Only agents with `is_master = 1` can approve reviews (REVIEW → DONE)

---

## [1.0.0] - 2026-01-31

### Initial Release
- Agent management with personality files (SOUL.md, USER.md, AGENTS.md)
- Mission Queue Kanban board (INBOX → ASSIGNED → IN PROGRESS → REVIEW → DONE)
- Agent-to-agent chat and conversations
- Live event feed
- OpenClaw Gateway WebSocket integration
- SQLite database with full schema
- Next.js 14 web interface
