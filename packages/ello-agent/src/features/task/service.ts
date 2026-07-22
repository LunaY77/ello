/**
 * 本文件负责 task feature 的“service”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { TaskEventBus } from './events.js';
import type { TaskBoardStore } from './store.js';
import type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskBoard,
  UpdateTaskInput,
} from './types.js';

export class TaskService {
  /**
   * 创建 `TaskService`，由该实例独占 Task 领域服务 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   * - `board`: `constructor TaskService` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `events`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   */
  constructor(
    private readonly repository: TaskBoardStore,
    readonly board: TaskBoard,
    private readonly events?: TaskEventBus,
  ) {}

  /**
   * 构造 Task 领域服务 模块 中的 `create` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `input`: `create` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - 返回 `create` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Task 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  create(input: CreateTaskInput): Task {
    const task = this.repository.createTask(this.board.id, input);
    this.emitChanged(task);
    return task;
  }

  /**
   * 读取 Task 领域服务 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(): readonly Task[] {
    return this.repository.listTasks(this.board.id);
  }

  /**
   * 读取 Task 领域服务 模块 的 `get` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `reference`: `get` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  get(reference: string): Task | null {
    return this.repository.getTask(this.board.id, reference);
  }

  /**
   * 按 Task 领域服务 模块 的一致性约束执行 `update` 状态变更。
   *
   * Args:
   * - `reference`: `update` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `input`: `update` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - 返回 `update` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Task 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  update(reference: string, input: UpdateTaskInput): Task {
    const task = this.repository.updateTask(this.board.id, reference, input);
    this.emitChanged(task);
    return task;
  }

  /**
   * 按 Task 领域服务 模块 的一致性约束执行 `delete` 状态变更。
   *
   * Args:
   * - `reference`: `delete` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   *
   * Throws:
   * - 当 Task 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * 执行 Task 领域服务 模块 定义的 `claim` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `reference`: `claim` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `owner`: `claim` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `claim` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  claim(reference: string, owner: string): ClaimResult {
    const result = this.repository.claimTask(this.board.id, reference, owner);
    if (result.ok) this.emitChanged(result.task);
    return result;
  }

  /**
   * 执行 Task 领域服务 模块 定义的 `reset` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Task 领域服务 模块 的同步状态变更完成后返回，不产生业务结果。
   */
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
