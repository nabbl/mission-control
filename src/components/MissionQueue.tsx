'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, ChevronDown, GripVertical, AlertTriangle, RotateCcw, Cpu, GitBranch } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { formatDistanceToNow } from 'date-fns';

interface MissionQueueProps {
  workspaceId?: string;
}

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'planning', label: '📋 PLANNING', color: 'border-t-mc-accent-purple' },
  { id: 'inbox', label: 'INBOX', color: 'border-t-mc-accent-pink' },
  { id: 'assigned', label: 'ASSIGNED', color: 'border-t-mc-accent-yellow' },
  { id: 'in_progress', label: 'IN PROGRESS', color: 'border-t-mc-accent' },
  { id: 'testing', label: 'TESTING', color: 'border-t-mc-accent-cyan' },
  { id: 'review', label: 'REVIEW', color: 'border-t-mc-accent-purple' },
  { id: 'done', label: 'DONE', color: 'border-t-mc-accent-green' },
];

export function MissionQueue({ workspaceId }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent } = useMissionControl();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [subtasksByParent, setSubtasksByParent] = useState<Record<string, Task[]>>({});

  const fetchSubtasks = useCallback(async (parentId: string) => {
    try {
      const res = await fetch(`/api/tasks?parent_task_id=${parentId}`);
      if (res.ok) {
        const data = await res.json();
        setSubtasksByParent(prev => ({ ...prev, [parentId]: data }));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const toggleExpand = useCallback((taskId: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
        fetchSubtasks(taskId);
      }
      return next;
    });
  }, [fetchSubtasks]);

  // Re-fetch subtasks when SSE events arrive for expanded parents
  useEffect(() => {
    Array.from(expandedParents).forEach(parentId => {
      fetchSubtasks(parentId);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const getTasksByStatus = (status: TaskStatus) =>
    tasks.filter((task) => task.status === status);

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault();
    if (!draggedTask || draggedTask.status === targetStatus) {
      setDraggedTask(null);
      return;
    }

    // Optimistic update
    updateTaskStatus(draggedTask.id, targetStatus);

    // Persist to API
    try {
      const res = await fetch(`/api/tasks/${draggedTask.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
      });

      if (res.ok) {
        // Add event
        addEvent({
          id: crypto.randomUUID(),
          type: targetStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: draggedTask.id,
          message: `Task "${draggedTask.title}" moved to ${targetStatus}`,
          created_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Failed to update task status:', error);
      // Revert on error
      updateTaskStatus(draggedTask.id, draggedTask.status);
    }

    setDraggedTask(null);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className="w-4 h-4 text-mc-text-secondary" />
          <span className="text-sm font-medium uppercase tracking-wider">Mission Queue</span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-mc-accent-pink text-mc-bg rounded text-sm font-medium hover:bg-mc-accent-pink/90"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Kanban Columns */}
      <div className="flex-1 flex gap-3 p-3 overflow-x-auto">
        {COLUMNS.map((column) => {
          const columnTasks = getTasksByStatus(column.id);
          return (
            <div
              key={column.id}
              className={`flex-1 min-w-[220px] max-w-[300px] flex flex-col bg-mc-bg rounded-lg border border-mc-border/50 border-t-2 ${column.color}`}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, column.id)}
            >
              {/* Column Header */}
              <div className="p-2 border-b border-mc-border flex items-center justify-between">
                <span className="text-xs font-medium uppercase text-mc-text-secondary">
                  {column.label}
                </span>
                <span className="text-xs bg-mc-bg-tertiary px-2 py-0.5 rounded text-mc-text-secondary">
                  {columnTasks.length}
                </span>
              </div>

              {/* Tasks */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {columnTasks.map((task) => (
                  <div key={task.id}>
                    <TaskCard
                      task={task}
                      onDragStart={handleDragStart}
                      onClick={() => setEditingTask(task)}
                      isDragging={draggedTask?.id === task.id}
                      isExpanded={expandedParents.has(task.id)}
                      onToggleExpand={task.subtask_progress ? () => toggleExpand(task.id) : undefined}
                    />
                    {/* Subtask mini-cards */}
                    {expandedParents.has(task.id) && subtasksByParent[task.id] && (
                      <div className="ml-3 mt-1 space-y-1 border-l-2 border-mc-accent/20 pl-2">
                        {subtasksByParent[task.id].map((sub) => (
                          <SubtaskMiniCard
                            key={sub.id}
                            task={sub}
                            onClick={() => setEditingTask(sub)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Modals */}
      {showCreateModal && (
        <TaskModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />
      )}
      {editingTask && (
        <TaskModal task={editingTask} onClose={() => setEditingTask(null)} workspaceId={workspaceId} />
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onDragStart: (e: React.DragEvent, task: Task) => void;
  onClick: () => void;
  isDragging: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

function TaskCard({ task, onDragStart, onClick, isDragging, isExpanded, onToggleExpand }: TaskCardProps) {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't open the modal
    setRetrying(true);
    try {
      await fetch(`/api/tasks/${task.id}/dispatch`, { method: 'POST' });
    } catch {
      // Dispatch route handles error recording
    } finally {
      setRetrying(false);
    }
  };

  const priorityStyles = {
    low: 'text-mc-text-secondary',
    normal: 'text-mc-accent',
    high: 'text-mc-accent-yellow',
    urgent: 'text-mc-accent-red',
  };

  const priorityDots = {
    low: 'bg-mc-text-secondary/40',
    normal: 'bg-mc-accent',
    high: 'bg-mc-accent-yellow',
    urgent: 'bg-mc-accent-red',
  };

  const isPlanning = task.status === 'planning';
  const isParent = !!task.subtask_progress;

  return (
    <div
      draggable={!isParent}
      onDragStart={(e) => !isParent && onDragStart(e, task)}
      onClick={onClick}
      className={`group bg-mc-bg-secondary border rounded-lg cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isPlanning ? 'border-purple-500/40 hover:border-purple-500' : isParent ? 'border-mc-accent/30 hover:border-mc-accent/60' : 'border-mc-border/50 hover:border-mc-accent/40'}`}
    >
      {/* Drag handle bar (hidden for parent tasks) */}
      {!isParent && (
        <div className="flex items-center justify-center py-1.5 border-b border-mc-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="w-4 h-4 text-mc-text-secondary/50 cursor-grab" />
        </div>
      )}

      {/* Card content */}
      <div className="p-4">
        {/* Title + expand toggle */}
        <div className="flex items-start gap-1.5 mb-3">
          {onToggleExpand && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
              className="flex-shrink-0 p-0.5 mt-0.5 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary transition-colors"
            >
              {isExpanded
                ? <ChevronDown className="w-3.5 h-3.5" />
                : <ChevronRight className="w-3.5 h-3.5" />
              }
            </button>
          )}
          <h4 className="text-sm font-medium leading-snug line-clamp-2">
            {task.title}
          </h4>
        </div>

        {/* Subtask progress bar */}
        {task.subtask_progress && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-mc-text-secondary">Subtasks</span>
              <span className="text-[10px] text-mc-accent font-medium">
                {task.subtask_progress.done}/{task.subtask_progress.total}
              </span>
            </div>
            <div className="h-1.5 bg-mc-bg-tertiary rounded-full overflow-hidden">
              <div
                className="h-full bg-mc-accent rounded-full transition-all"
                style={{ width: `${task.subtask_progress.total > 0 ? (task.subtask_progress.done / task.subtask_progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
        
        {/* Planning mode indicator */}
        {isPlanning && (
          <div className="flex items-center gap-2 mb-3 py-2 px-3 bg-purple-500/10 rounded-md border border-purple-500/20">
            <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-purple-400 font-medium">Continue planning</span>
          </div>
        )}

        {/* Assigned agent */}
        {task.assigned_agent && (
          <div className="flex items-center gap-2 mb-3 py-1.5 px-2 bg-mc-bg-tertiary/50 rounded">
            <span className="text-base">{(task.assigned_agent as unknown as { avatar_emoji: string }).avatar_emoji}</span>
            <span className="text-xs text-mc-text-secondary truncate">
              {(task.assigned_agent as unknown as { name: string }).name}
            </span>
          </div>
        )}

        {/* Dispatch error indicator */}
        {task.dispatch_error && (
          <div className="flex items-start gap-2 mb-3 py-2 px-3 bg-amber-500/10 rounded-md border border-amber-500/20">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-amber-400 line-clamp-2">{task.dispatch_error}</span>
            </div>
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="flex-shrink-0 p-1 rounded hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50"
              title="Retry dispatch"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}

        {/* Model badge */}
        {(() => {
          const agent = task.assigned_agent as unknown as { model?: string } | undefined;
          const modelName = task.model || agent?.model;
          if (!modelName) return null;
          return (
            <div className="flex items-center gap-1.5 mb-3">
              <Cpu className="w-3 h-3 text-purple-400 flex-shrink-0" />
              <span className="text-[10px] font-mono text-purple-400 truncate">{modelName}</span>
            </div>
          );
        })()}

        {/* Footer: priority + timestamp */}
        <div className="flex items-center justify-between pt-2 border-t border-mc-border/20">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${priorityDots[task.priority]}`} />
            <span className={`text-xs capitalize ${priorityStyles[task.priority]}`}>
              {task.priority}
            </span>
          </div>
          <span className="text-[10px] text-mc-text-secondary/60">
            {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>
    </div>
  );
}

const statusColors: Record<string, string> = {
  inbox: 'bg-pink-500/20 text-pink-400',
  assigned: 'bg-yellow-500/20 text-yellow-400',
  in_progress: 'bg-blue-500/20 text-blue-400',
  testing: 'bg-cyan-500/20 text-cyan-400',
  review: 'bg-purple-500/20 text-purple-400',
  done: 'bg-green-500/20 text-green-400',
};

function SubtaskMiniCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="bg-mc-bg-secondary/60 border border-mc-border/30 rounded px-3 py-2 cursor-pointer hover:border-mc-accent/30 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${statusColors[task.status] || 'bg-mc-bg-tertiary text-mc-text-secondary'}`}>
          {task.status.replace('_', ' ').toUpperCase()}
        </span>
        <h5 className="text-xs font-medium truncate flex-1">{task.title}</h5>
      </div>
      <div className="flex items-center gap-3">
        {task.assigned_agent && (
          <span className="text-[10px] text-mc-text-secondary truncate">
            {(task.assigned_agent as unknown as { avatar_emoji?: string }).avatar_emoji} {(task.assigned_agent as unknown as { name: string }).name}
          </span>
        )}
        {task.branch_name && (
          <span className="flex items-center gap-1 text-[10px] text-mc-text-secondary/60 truncate">
            <GitBranch className="w-2.5 h-2.5" />
            {task.branch_name}
          </span>
        )}
      </div>
    </div>
  );
}
