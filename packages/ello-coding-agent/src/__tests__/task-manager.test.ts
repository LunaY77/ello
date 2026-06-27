import { describe, expect, it } from 'vitest';

import { TaskManager, formatTasks } from '../task-manager.js';

describe('TaskManager', () => {
  it('creates and updates tasks', () => {
    const manager = new TaskManager();
    const task = manager.create('Implement feature');
    const updated = manager.update(task.id, { status: 'completed' });

    expect(updated.status).toBe('completed');
    expect(formatTasks(manager.list())).toContain(task.id);
  });
});
