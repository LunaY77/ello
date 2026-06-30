import type { TaskEventBus } from './events.js';
import type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskStore,
  UpdateTaskInput,
} from './types.js';

type MutableTask = {
  -readonly [K in keyof Task]: Task[K];
};

/** 任务业务层：维护状态机、依赖双向关系和 claim 语义。 */
export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly events?: TaskEventBus,
  ) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: await this.store.nextId(),
      subject: input.subject,
      description: input.description ?? '',
      ...(input.activeForm !== undefined
        ? { activeForm: input.activeForm }
        : {}),
      status: 'pending',
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      blocks: [...(input.blocks ?? [])],
      blockedBy: [...(input.blockedBy ?? [])],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(task);
    await this.reconcileLinks(task.id, [], task.blocks, [], task.blockedBy);
    const created = await this.requireTask(task.id);
    await this.emitChanged(created);
    return created;
  }

  async list(): Promise<readonly Task[]> {
    return this.store.list();
  }

  async get(id: string): Promise<Task | null> {
    return this.store.get(id);
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const current = await this.requireTask(id);
    const next: MutableTask = {
      ...current,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.blocks !== undefined ? { blocks: [...input.blocks] } : {}),
      ...(input.blockedBy !== undefined
        ? { blockedBy: [...input.blockedBy] }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (input.activeForm !== undefined) {
      if (input.activeForm === null) {
        delete next.activeForm;
      } else {
        next.activeForm = input.activeForm;
      }
    }
    if (input.owner !== undefined) {
      if (input.owner === null) {
        delete next.owner;
      } else {
        next.owner = input.owner;
      }
    }
    await this.store.save(next);
    await this.reconcileLinks(
      id,
      current.blocks,
      next.blocks,
      current.blockedBy,
      next.blockedBy,
    );
    if (next.status === 'completed') {
      await this.releaseBlockedTasks(id);
    }
    const updated = await this.requireTask(id);
    await this.emitChanged(updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.store.get(id);
    if (current === null) {
      return false;
    }
    await this.reconcileLinks(id, current.blocks, [], current.blockedBy, []);
    const deleted = await this.store.delete(id);
    if (deleted) {
      this.events?.emit({ type: 'task.deleted', id });
      this.events?.emit({
        type: 'task.list.changed',
        tasks: await this.list(),
      });
    }
    return deleted;
  }

  async claim(id: string, owner: string): Promise<ClaimResult> {
    const task = await this.store.get(id);
    if (task === null) {
      return { ok: false, reason: `unknown task: ${id}` };
    }
    if (task.status === 'completed' || task.status === 'cancelled') {
      return { ok: false, reason: `task is ${task.status}`, task };
    }
    if (task.blockedBy.length > 0) {
      return {
        ok: false,
        reason: `task is blocked by ${task.blockedBy.join(', ')}`,
        task,
      };
    }
    if (task.owner !== undefined && task.owner !== owner) {
      return {
        ok: false,
        reason: `task is already owned by ${task.owner}`,
        task,
      };
    }
    return {
      ok: true,
      task: await this.update(id, { owner, status: 'in_progress' }),
    };
  }

  async reset(): Promise<void> {
    await this.store.reset();
    this.events?.emit({ type: 'task.reset' });
    this.events?.emit({ type: 'task.list.changed', tasks: [] });
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.store.get(id);
    if (task === null) {
      throw new Error(`Unknown task: ${id}`);
    }
    return task;
  }

  private async reconcileLinks(
    id: string,
    oldBlocks: readonly string[],
    nextBlocks: readonly string[],
    oldBlockedBy: readonly string[],
    nextBlockedBy: readonly string[],
  ): Promise<void> {
    await this.syncReverse(id, oldBlocks, nextBlocks, 'blockedBy');
    await this.syncReverse(id, oldBlockedBy, nextBlockedBy, 'blocks');
  }

  private async syncReverse(
    id: string,
    oldIds: readonly string[],
    nextIds: readonly string[],
    field: 'blocks' | 'blockedBy',
  ): Promise<void> {
    const oldSet = new Set(oldIds);
    const nextSet = new Set(nextIds);
    for (const targetId of new Set([...oldIds, ...nextIds])) {
      const target = await this.store.get(targetId);
      if (target === null) {
        continue;
      }
      const values = new Set(target[field]);
      if (nextSet.has(targetId)) {
        values.add(id);
      }
      if (oldSet.has(targetId) && !nextSet.has(targetId)) {
        values.delete(id);
      }
      await this.store.save({
        ...target,
        [field]: [...values],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async releaseBlockedTasks(completedId: string): Promise<void> {
    for (const task of await this.store.list()) {
      if (!task.blockedBy.includes(completedId)) {
        continue;
      }
      await this.store.save({
        ...task,
        blockedBy: task.blockedBy.filter((id) => id !== completedId),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async emitChanged(task: Task): Promise<void> {
    this.events?.emit({ type: 'task.changed', task });
    this.events?.emit({ type: 'task.list.changed', tasks: await this.list() });
  }
}
