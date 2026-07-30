import type {
  BenchmarkConfig,
  BenchmarkJob,
  RunManifest,
  RunProvenance,
  SuiteManifest,
} from '../domain/contract/index.js';
import type { BenchmarkPlan } from '../domain/suite/plan.js';

import type { RunAttemptRequest } from './attempt.js';
import type { ResolvedTaskFiles } from './corpus.js';

export interface AttemptSelection {
  readonly run?: RunManifest;
  readonly skipReason?: 'completed' | 'retry_exhausted';
}

export interface OpenedSuite {
  readonly path: string;
  readonly manifest: SuiteManifest;
}

export interface MatrixRuntime {
  collectProvenance(includeEllo: boolean): Promise<RunProvenance>;
  loadTaskFiles(
    corpusRoot: string,
    config: BenchmarkConfig,
  ): Promise<ReadonlyMap<string, ResolvedTaskFiles>>;
  openSuite(options: {
    readonly runRoot: string;
    readonly config: BenchmarkConfig;
    readonly plan: BenchmarkPlan;
  }): Promise<OpenedSuite>;
  selectAttempt(options: {
    readonly suitePath: string;
    readonly suite: SuiteManifest;
    readonly job: BenchmarkJob;
    readonly maxInfrastructureRetries: number;
  }): Promise<AttemptSelection>;
  runAttempt(request: RunAttemptRequest): Promise<RunManifest>;
}
