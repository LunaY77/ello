import type { TaskBoardRepository } from '../repositories/task-board-repository.js';

import type { TaskEventBus } from './events.js';
import type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskBoard,
  UpdateTaskInput,
} from './types.js';

export class TaskService {
  constructor(
    private readonly repository: TaskBoardRepository,
    readonly board: TaskBoard,
    private readonly events?: TaskEventBus,
  ) {}

  create(input: CreateTaskInput): Task {
    const task = this.repository.createTask(this.board.id, input);
    this.emitChanged(task);
    return task;
  }

  list(): readonly Task[] {
    return this.repository.listTasks(this.board.id);
  }

  get(reference: string): Task | null {
    return this.repository.getTask(this.board.id, reference);
  }

  update(reference: string, input: UpdateTaskInput): Task {
    const task = this.repository.updateTask(this.board.id, reference, input);
    this.emitChanged(task);
    return task;
  }

  delete(reference: string): boolean {
    const task = this.get(reference);
    if (task === null) return false;
    const deleted = this.repository.deleteTask(this.board.id, task.id);
    if (deleted) {
      this.events?.emit({ type: 'task.deleted', id: task.id });
      this.events?.emit({ type: 'task.list.changed', tasks: this.list() });
    }
    return deleted;
  }

  claim(reference: string, owner: string): ClaimResult {
    const result = this.repository.claimTask(this.board.id, reference, owner);
    if (result.ok) this.emitChanged(result.task);
    return result;
  }

  reset(): void {
    this.repository.resetBoard(this.board.id);
    this.events?.emit({ type: 'task.reset' });
    this.events?.emit({ type: 'task.list.changed', tasks: [] });
  }

  private emitChanged(task: Task): void {
    this.events?.emit({ type: 'task.changed', task });
    this.events?.emit({ type: 'task.list.changed', tasks: this.list() });
  }
}
