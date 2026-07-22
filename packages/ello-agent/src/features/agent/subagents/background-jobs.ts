/**
 * 后台委派任务的进程内存储。
 *
 * 对齐 opencode `core/background-job.ts`：**故意不持久化**。job 只活在当前进程，
 * 进程退出 = running job 丢失。完成后由 {@link BackgroundJobStore.onSettled}
 * 通知会话运行时，把结果注入 parent session。
 */

/** 一个后台委派任务的快照。 */
export interface BackgroundJob {
  /** = subagent run id。 */
  readonly id: string;
  readonly parentSessionId: string;
  readonly agentName: string;
  /** = 委派时的 description，用于 TUI sidebar 标题。 */
  readonly title: string;
  readonly status: 'running' | 'completed' | 'error' | 'cancelled';
  readonly startedAt: string;
  readonly completedAt?: string;
  /** completed 时的 child 最终文本。 */
  readonly output?: string;
  readonly error?: string;
}

/** 启动后台任务时提供的描述信息。 */
export interface BackgroundJobDescriptor {
  readonly id: string;
  readonly parentSessionId: string;
  readonly agentName: string;
  readonly title: string;
}

/** 后台任务的运行句柄：最终文本 + 主动中断。 */
export interface BackgroundJobHandle {
  /** 解析为 child 的最终输出文本。 */
  readonly final: Promise<string>;
  /**
   * 主动中断 child 运行（cancel 时调用）。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 产品 Agent `background-jobs` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  readonly abort: (reason?: unknown) => void;
}

/** 进程内后台任务存储。 */
export class BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly handles = new Map<string, BackgroundJobHandle>();
  private readonly settledListeners = new Set<(job: BackgroundJob) => void>();

  /**
   * 登记并启动一个后台任务，立即返回 running 快照。
   *
   * Args:
   * - `descriptor`: `start` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `handle`: `start` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `start` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 产品 Agent `background-jobs` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  start(
    descriptor: BackgroundJobDescriptor,
    handle: BackgroundJobHandle,
  ): BackgroundJob {
    const job: BackgroundJob = {
      ...descriptor,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.handles.set(job.id, handle);
    handle.final.then(
      (output) => this.settle(job.id, { status: 'completed', output }),
      (error) =>
        this.settle(job.id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return job;
  }

  /**
   * 读取 产品 Agent `background-jobs` 模块 的 `get` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * 读取 产品 Agent `background-jobs` 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `parentSessionId`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(parentSessionId?: string): readonly BackgroundJob[] {
    const all = [...this.jobs.values()];
    return parentSessionId === undefined
      ? all
      : all.filter((job) => job.parentSessionId === parentSessionId);
  }

  /**
   * 标记 cancelled 并中断 child stream；已结束的任务忽略。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 产品 Agent `background-jobs` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== 'running') {
      return;
    }
    this.handles.get(id)?.abort('background job cancelled');
    this.settle(id, { status: 'cancelled' });
  }

  /**
   * 执行 产品 Agent `background-jobs` 模块 定义的 `stopAll` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播。
   *
   * Returns:
   * - Promise 在 产品 Agent `background-jobs` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async stopAll(reason: string): Promise<void> {
    const handles = [...this.handles.values()];
    for (const handle of handles) {
      handle.abort(reason);
    }
    await Promise.allSettled(handles.map((handle) => handle.final));
  }

  /**
   * 订阅任务结束（completed/error/cancelled）。
   *
   * Args:
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - 返回 `onSettled` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onSettled(listener: (job: BackgroundJob) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  private settle(
    id: string,
    patch: {
      readonly status: BackgroundJob['status'];
      readonly output?: string;
      readonly error?: string;
    },
  ): void {
    const current = this.jobs.get(id);
    if (current === undefined || current.status !== 'running') {
      return;
    }
    const settled: BackgroundJob = {
      ...current,
      status: patch.status,
      completedAt: new Date().toISOString(),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    };
    this.jobs.set(id, settled);
    this.handles.delete(id);
    for (const listener of this.settledListeners) {
      listener(settled);
    }
  }
}
