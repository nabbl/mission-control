import { queryOne, queryAll } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { syslog } from '@/lib/logger';
import { run } from '@/lib/db';
import type { Task } from '@/lib/types';

/**
 * Called when a subtask reaches 'review' or 'done'.
 * Handles:
 * 1. Unblocking dependent siblings (auto-dispatch when all deps met)
 * 2. Moving parent to 'review' when all subtasks are done
 */
export async function onSubtaskCompleted(subtaskId: string): Promise<void> {
  const subtask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [subtaskId]);
  if (!subtask?.parent_task_id) return;

  const parentId = subtask.parent_task_id;
  const siblings = queryAll<Task>(
    'SELECT * FROM tasks WHERE parent_task_id = ?',
    [parentId]
  );

  // Build set of completed sibling IDs
  const completedIds = new Set(
    siblings
      .filter(s => s.status === 'review' || s.status === 'done')
      .map(s => s.id)
  );

  // Check siblings still in 'inbox' — if all their deps are met, dispatch them
  const baseUrl = `http://localhost:${process.env.PORT || 3000}`;

  for (const sibling of siblings) {
    if (sibling.status !== 'inbox') continue;

    let depIds: string[] = [];
    try {
      depIds = JSON.parse(sibling.depends_on || '[]');
    } catch {
      continue;
    }

    if (depIds.length === 0) continue; // Already dispatched or no deps

    const allDepsMet = depIds.every(id => completedIds.has(id));
    if (!allDepsMet) continue;

    syslog('info', 'subtasks', `All dependencies met for subtask "${sibling.title}" (${sibling.id}), dispatching`);

    fetch(`${baseUrl}/api/tasks/${sibling.id}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).then(async (res) => {
      if (res.ok) {
        syslog('info', 'subtasks', `Dependent subtask ${sibling.id} dispatched`);
      } else {
        const text = await res.text();
        syslog('error', 'subtasks', `Dependent subtask ${sibling.id} dispatch failed (${res.status})`, text);
      }
    }).catch(err => {
      syslog('error', 'subtasks', `Dependent subtask ${sibling.id} dispatch error`, { error: (err as Error).message });
    });
  }

  // Check if ALL siblings are in review/done → move parent to 'review'
  const allDone = siblings.every(s => s.status === 'review' || s.status === 'done');
  if (allDone) {
    syslog('info', 'subtasks', `All subtasks complete for parent ${parentId}, moving parent to review`);
    run(
      'UPDATE tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ['review', parentId]
    );

    const updatedParent = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [parentId]);
    if (updatedParent) {
      broadcast({ type: 'task_updated', payload: updatedParent });
    }
  }
}
