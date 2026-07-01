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
  /** 主动中断 child 运行（cancel 时调用）。 */
  readonly abort: (reason?: unknown) => void;
}

/** 进程内后台任务存储。 */
export class BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly handles = new Map<string, BackgroundJobHandle>();
  private readonly settledListeners = new Set<(job: BackgroundJob) => void>();

  /** 登记并启动一个后台任务，立即返回 running 快照。 */
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

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  list(parentSessionId?: string): readonly BackgroundJob[] {
    const all = [...this.jobs.values()];
    return parentSessionId === undefined
      ? all
      : all.filter((job) => job.parentSessionId === parentSessionId);
  }

  /** 标记 cancelled 并中断 child stream；已结束的任务忽略。 */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== 'running') {
      return;
    }
    this.handles.get(id)?.abort('background job cancelled');
    this.settle(id, { status: 'cancelled' });
  }

  /** 订阅任务结束（completed/error/cancelled）。 */
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
