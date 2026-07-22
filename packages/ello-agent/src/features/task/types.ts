/**
 * 本文件负责 task feature 的领域类型与闭合联合。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type TaskBoardScope =
  | { readonly type: 'session'; readonly sessionId: string }
  | { readonly type: 'global'; readonly name: string };

export interface TaskBoard {
  readonly id: string;
  readonly scope: TaskBoardScope;
  readonly nextSequence: number;
  readonly createdAt: string;
  readonly archivedAt?: string | undefined;
}

export interface TaskRef {
  readonly id: string;
  readonly sequence: number;
  readonly subject: string;
  readonly status: TaskStatus;
}

export interface Task {
  readonly id: string;
  readonly boardId: string;
  readonly sequence: number;
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string | undefined;
  readonly status: TaskStatus;
  readonly owner?: string | undefined;
  readonly blocks: readonly TaskRef[];
  readonly blockedBy: readonly TaskRef[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly subject: string;
  readonly description?: string | undefined;
  readonly activeForm?: string | undefined;
  readonly owner?: string | undefined;
  readonly blocks?: readonly string[] | undefined;
  readonly blockedBy?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

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

export type ClaimResult =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly reason: string; readonly task?: Task };
