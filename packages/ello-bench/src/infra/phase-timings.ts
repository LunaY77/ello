import { PhaseTimingsArtifactSchema } from '../domain/contract/index.js';

import { writeJsonAtomic } from './io.js';

export class PhaseTimingsRecorder {
  readonly path: string;
  private readonly phases: Array<{
    readonly phase: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
    readonly status: 'completed' | 'failed';
  }> = [];
  private active:
    | {
        readonly phase: string;
        readonly startedAt: string;
        readonly startedMs: number;
      }
    | undefined;

  constructor(filePath: string) {
    this.path = filePath;
  }

  async run<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    this.start(phase);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      try {
        await this.finish(phase, 'failed');
      } catch (timingError) {
        throw new AggregateError(
          [error, timingError],
          `Benchmark phase and timing persistence failed: ${phase}.`,
          { cause: timingError },
        );
      }
      throw error;
    }
    await this.finish(phase, 'completed');
    return result;
  }

  private start(phase: string): void {
    if (phase === '') throw new Error('Benchmark phase must not be empty.');
    if (this.active !== undefined) {
      throw new Error(
        `Benchmark phase is already running: ${this.active.phase}.`,
      );
    }
    if (this.phases.some((timing) => timing.phase === phase)) {
      throw new Error(`Benchmark phase already recorded: ${phase}.`);
    }
    this.active = {
      phase,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
    };
  }

  private async finish(
    phase: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    const active = this.active;
    if (active === undefined || active.phase !== phase) {
      throw new Error(`Benchmark phase is not running: ${phase}.`);
    }
    this.active = undefined;
    this.phases.push({
      phase,
      startedAt: active.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - active.startedMs,
      status,
    });
    await writeJsonAtomic(
      this.path,
      PhaseTimingsArtifactSchema.parse({
        schema: 'ello.benchmark.phase-timings.v1',
        phases: this.phases,
      }),
    );
  }
}
