/** coding-agent 任务状态。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 可持久化任务实体。 */
export interface Task {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string | undefined;
  readonly status: TaskStatus;
  readonly owner?: string | undefined;
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建任务时允许调用方传入的字段。 */
export interface CreateTaskInput {
  readonly subject: string;
  readonly description?: string | undefined;
  readonly activeForm?: string | undefined;
  readonly owner?: string | undefined;
  readonly blocks?: readonly string[] | undefined;
  readonly blockedBy?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** 更新任务时允许调用方传入的字段。 */
export interface UpdateTaskInput {
  readonly subject?: string | undefined;
  readonly description?: string | undefined;
  readonly activeForm?: string | null | undefined;
  readonly status?: TaskStatus | undefined;
  readonly owner?: string | null | undefined;
  readonly blocks?: readonly string[] | undefined;
  readonly blockedBy?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** claim 的确定性结果，便于 CLI/TUI 展示冲突原因。 */
export type ClaimResult =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly reason: string; readonly task?: Task };

/** 任务列表存储接口。 */
export interface TaskStore {
  nextId(): Promise<string>;
  list(): Promise<readonly Task[]>;
  get(id: string): Promise<Task | null>;
  save(task: Task): Promise<Task>;
  delete(id: string): Promise<boolean>;
  reset(): Promise<void>;
}
