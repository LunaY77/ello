import { randomUUID } from 'node:crypto';

import type { ModelAdapter } from '@ello/agent';

import type { AgentRegistry } from '../agents/registry.js';
import type { CodingAgentConfig } from '../config/index.js';
import { createProviderRegistry } from '../provider/index.js';
import type { JsonlSessionRepository } from '../session/repository.js';
import type { CodingStorage } from '../storage/index.js';

import { runDreamJob } from './dream-job.js';
import type { MemoryEvent } from './events.js';
import { runMemoryExtractionJob } from './extraction-job.js';
import { MemoryIndexLoader } from './index-loader.js';
import { memoryRoots } from './paths.js';
import { MemoryRepository } from './repository.js';
import type { MemoryToolPort } from './tools.js';

export type MemoryJobKind = 'extract' | 'dream';
export type MemoryJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface MemoryJob {
  readonly id: string;
  readonly kind: MemoryJobKind;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly sourceLeafId: string | null;
  readonly status: MemoryJobStatus;
  readonly attempts: number;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface MemoryStatus {
  readonly enabled: true;
  readonly privateRoot: string;
  readonly teamRoot: string;
  readonly privateEntries: number;
  readonly teamEntries: number;
  readonly queuedJobs: number;
  readonly runningJobs: number;
  readonly failedJobs: number;
  readonly activeDream: MemoryJob | null;
}

export class MemoryJobCoordinator implements MemoryToolPort {
  readonly repository: MemoryRepository;
  readonly indexLoader: MemoryIndexLoader;

  private readonly jobs: MemoryJobRepository;
  private readonly providerRegistry;
  private writerTail: Promise<void> = Promise.resolve();
  private workerTask: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly deps: {
      readonly config: CodingAgentConfig;
      readonly storage: CodingStorage;
      readonly sessionRepository: JsonlSessionRepository;
      readonly registry: AgentRegistry;
      readonly modelAdapter?: ModelAdapter;
      readonly emit: (event: MemoryEvent) => void;
    },
  ) {
    this.repository = new MemoryRepository(memoryRoots(deps.config));
    this.indexLoader = new MemoryIndexLoader(this.repository);
    this.jobs = new MemoryJobRepository(deps.storage);
    this.providerRegistry = createProviderRegistry(deps.config);
  }

  async start(): Promise<void> {
    await this.repository.initialize();
    this.jobs.recoverInterrupted(this.deps.config.cwd);
    this.scheduleWorker();
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.writerTail;
    this.writerTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async enqueueExtraction(input: {
    readonly sessionId: string;
    readonly sourceLeafId: string;
  }): Promise<MemoryJob> {
    const job = this.jobs.enqueueExtraction({
      ...input,
      cwd: this.deps.config.cwd,
    });
    this.scheduleWorker();
    return job;
  }

  async enqueueDream(): Promise<{
    readonly job: MemoryJob;
    readonly created: boolean;
  }> {
    const result = this.jobs.enqueueDream(this.deps.config.cwd);
    this.scheduleWorker();
    return result;
  }

  async status(): Promise<MemoryStatus> {
    const entries = await this.repository.status();
    const jobs = this.jobs.status(this.deps.config.cwd);
    return {
      enabled: true,
      privateRoot: this.repository.roots.private,
      teamRoot: this.repository.roots.team,
      ...entries,
      ...jobs,
    };
  }

  reload(): void {
    this.indexLoader.invalidate();
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.workerTask;
    await this.writerTail;
  }

  private scheduleWorker(): void {
    if (this.stopped || this.workerTask !== undefined) {
      return;
    }
    this.workerTask = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        this.pump().then(resolve, reject);
      });
    }).finally(() => {
      this.workerTask = undefined;
      if (!this.stopped && this.jobs.hasQueued(this.deps.config.cwd)) {
        this.scheduleWorker();
      }
    });
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const job = this.jobs.claimNext(this.deps.config.cwd);
      if (job === null) {
        return;
      }
      await this.runJob(job);
    }
  }

  private async runJob(job: MemoryJob): Promise<void> {
    if (job.kind === 'extract') {
      this.deps.emit({
        type: 'memory.extraction.started',
        jobId: job.id,
        sessionId: required(job.sessionId, 'sessionId', job.id),
      });
    } else {
      this.deps.emit({ type: 'memory.dream.started', jobId: job.id });
    }
    try {
      const result = await this.mutate(() =>
        job.kind === 'extract'
          ? runMemoryExtractionJob({
              sessionId: required(job.sessionId, 'sessionId', job.id),
              sourceLeafId: required(job.sourceLeafId, 'sourceLeafId', job.id),
              recentMessages:
                this.deps.config.context.memory.extraction.recent_messages,
              config: this.deps.config,
              registry: this.deps.registry,
              providerRegistry: this.providerRegistry,
              sessionRepository: this.deps.sessionRepository,
              memory: directMemoryPort(this.repository),
              indexLoader: this.indexLoader,
              ...(this.deps.modelAdapter !== undefined
                ? { modelAdapter: this.deps.modelAdapter }
                : {}),
            })
          : runDreamJob({
              config: this.deps.config,
              registry: this.deps.registry,
              providerRegistry: this.providerRegistry,
              sessionRepository: this.deps.sessionRepository,
              memory: directMemoryPort(this.repository),
              indexLoader: this.indexLoader,
              ...(this.deps.modelAdapter !== undefined
                ? { modelAdapter: this.deps.modelAdapter }
                : {}),
            }),
      );
      this.jobs.markCompleted(job.id);
      if (job.kind === 'extract') {
        this.deps.emit({
          type: 'memory.extraction.completed',
          jobId: job.id,
          changes: result.changes,
        });
      } else {
        this.deps.emit({
          type: 'memory.dream.completed',
          jobId: job.id,
          changes: result.changes,
          summary: result.summary,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal =
        job.attempts >= this.deps.config.context.memory.extraction.max_attempts;
      this.jobs.markFailed(job.id, message, terminal);
      if (!terminal) {
        return;
      }
      if (job.kind === 'extract') {
        this.deps.emit({
          type: 'memory.extraction.failed',
          jobId: job.id,
          error: message,
        });
      } else {
        this.deps.emit({
          type: 'memory.dream.failed',
          jobId: job.id,
          error: message,
        });
      }
    }
  }
}

class MemoryJobRepository {
  constructor(private readonly storage: CodingStorage) {}

  recoverInterrupted(cwd: string): void {
    this.storage.db.$client
      .prepare(
        `update memory_jobs
         set status = 'queued', started_at = null,
             error_message = 'worker interrupted before completion'
         where cwd = ? and status = 'running'`,
      )
      .run(cwd);
  }

  enqueueExtraction(input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly sourceLeafId: string;
  }): MemoryJob {
    const id = randomUUID();
    this.storage.db.$client
      .prepare(
        `insert into memory_jobs(
           id, kind, cwd, session_id, source_leaf_id,
           status, attempts, created_at
         ) values (?, 'extract', ?, ?, ?, 'queued', 0, ?)
         on conflict(kind, cwd, session_id, source_leaf_id)
         where kind = 'extract'
         do nothing`,
      )
      .run(id, input.cwd, input.sessionId, input.sourceLeafId, now());
    return this.requireBySource(input.cwd, input.sessionId, input.sourceLeafId);
  }

  enqueueDream(cwd: string): {
    readonly job: MemoryJob;
    readonly created: boolean;
  } {
    return this.storage.db.$client
      .transaction(() => {
        const active = this.activeDream(cwd);
        if (active !== null) {
          return { job: active, created: false };
        }
        const id = randomUUID();
        this.storage.db.$client
          .prepare(
            `insert into memory_jobs(
             id, kind, cwd, status, attempts, created_at
           ) values (?, 'dream', ?, 'queued', 0, ?)`,
          )
          .run(id, cwd, now());
        return { job: this.require(id), created: true };
      })
      .immediate();
  }

  hasQueued(cwd: string): boolean {
    return (
      this.storage.db.$client
        .prepare(
          `select 1 from memory_jobs
           where cwd = ? and status = 'queued'
           limit 1`,
        )
        .get(cwd) !== undefined
    );
  }

  claimNext(cwd: string): MemoryJob | null {
    return this.storage.db.$client
      .transaction(() => {
        const queued = mapJob(
          this.storage.db.$client
            .prepare(
              `select * from memory_jobs
             where cwd = ? and status = 'queued'
             order by created_at, id
             limit 1`,
            )
            .get(cwd),
        );
        if (queued === null) {
          return null;
        }
        const result = this.storage.db.$client
          .prepare(
            `update memory_jobs
           set status = 'running', attempts = attempts + 1,
               started_at = ?, completed_at = null, error_message = null
           where id = ? and status = 'queued'`,
          )
          .run(now(), queued.id);
        if (result.changes !== 1) {
          throw new Error(`Memory job claim lost: ${queued.id}`);
        }
        return this.require(queued.id);
      })
      .immediate();
  }

  markCompleted(id: string): void {
    this.updateTerminal(id, 'completed', null);
  }

  markFailed(id: string, error: string, terminal: boolean): void {
    if (!terminal) {
      const result = this.storage.db.$client
        .prepare(
          `update memory_jobs
           set status = 'queued', started_at = null, error_message = ?
           where id = ? and status = 'running'`,
        )
        .run(error, id);
      if (result.changes !== 1) {
        throw new Error(`Memory job is not running: ${id}`);
      }
      return;
    }
    this.updateTerminal(id, 'failed', error);
  }

  status(
    cwd: string,
  ): Pick<
    MemoryStatus,
    'queuedJobs' | 'runningJobs' | 'failedJobs' | 'activeDream'
  > {
    const rows = this.storage.db.$client
      .prepare(
        `select status, count(*) as count
         from memory_jobs
         where cwd = ?
           and status in ('queued', 'running', 'failed')
         group by status`,
      )
      .all(cwd) as Array<{
      readonly status: MemoryJobStatus;
      readonly count: number;
    }>;
    const counts = new Map(rows.map((row) => [row.status, row.count]));
    return {
      queuedJobs: counts.get('queued') ?? 0,
      runningJobs: counts.get('running') ?? 0,
      failedJobs: counts.get('failed') ?? 0,
      activeDream: this.activeDream(cwd),
    };
  }

  private activeDream(cwd: string): MemoryJob | null {
    return mapJob(
      this.storage.db.$client
        .prepare(
          `select * from memory_jobs
           where kind = 'dream' and cwd = ?
             and status in ('queued', 'running')
           order by created_at
           limit 1`,
        )
        .get(cwd),
    );
  }

  private requireBySource(
    cwd: string,
    sessionId: string,
    sourceLeafId: string,
  ): MemoryJob {
    const job = mapJob(
      this.storage.db.$client
        .prepare(
          `select * from memory_jobs
           where kind = 'extract' and cwd = ?
             and session_id = ? and source_leaf_id = ?`,
        )
        .get(cwd, sessionId, sourceLeafId),
    );
    if (job === null) {
      throw new Error(
        `Memory extraction job was not persisted for ${sessionId}/${sourceLeafId}.`,
      );
    }
    return job;
  }

  private require(id: string): MemoryJob {
    const job = mapJob(
      this.storage.db.$client
        .prepare('select * from memory_jobs where id = ?')
        .get(id),
    );
    if (job === null) {
      throw new Error(`Unknown memory job: ${id}`);
    }
    return job;
  }

  private updateTerminal(
    id: string,
    status: 'completed' | 'failed',
    error: string | null,
  ): void {
    const result = this.storage.db.$client
      .prepare(
        `update memory_jobs
         set status = ?, error_message = ?, completed_at = ?
         where id = ? and status = 'running'`,
      )
      .run(status, error, now(), id);
    if (result.changes !== 1) {
      throw new Error(`Memory job is not running: ${id}`);
    }
  }
}

function directMemoryPort(repository: MemoryRepository): MemoryToolPort {
  return {
    repository,
    mutate: (operation) => operation(),
  };
}

function required(value: string | null, field: string, jobId: string): string {
  if (value === null) {
    throw new Error(`Memory job ${jobId} is missing ${field}.`);
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function mapJob(row: unknown): MemoryJob | null {
  if (row === undefined) {
    return null;
  }
  const value = row as Record<string, unknown>;
  return {
    id: value['id'] as string,
    kind: value['kind'] as MemoryJobKind,
    cwd: value['cwd'] as string,
    sessionId: (value['session_id'] as string | null) ?? null,
    sourceLeafId: (value['source_leaf_id'] as string | null) ?? null,
    status: value['status'] as MemoryJobStatus,
    attempts: value['attempts'] as number,
    errorMessage: (value['error_message'] as string | null) ?? null,
    createdAt: value['created_at'] as string,
    startedAt: (value['started_at'] as string | null) ?? null,
    completedAt: (value['completed_at'] as string | null) ?? null,
  };
}
