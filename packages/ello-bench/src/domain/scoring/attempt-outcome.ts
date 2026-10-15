import type {
  HarnessReport,
  PatchArtifact,
  ProcessResult,
  RunManifest,
} from '../contract/index.js';

export type AttemptOutcome = {
  readonly kind: 'scored';
  readonly reward: 0 | 1;
};

export function classifyAttempt(harness: HarnessReport): AttemptOutcome {
  return { kind: 'scored', reward: harness.reward };
}

export function classifyDeliveryOutcome(options: {
  readonly process: ProcessResult;
  readonly reward: 0 | 1;
  readonly patch: Pick<PatchArtifact, 'bytes'>;
}): NonNullable<RunManifest['outcome']> {
  if (options.patch.bytes === 0 && options.reward === 0) return 'failed';
  if (options.process.timedOut) {
    return options.reward === 1 ? 'timeout_passed' : 'timeout_failed';
  }
  if (options.process.exitCode === 0) {
    return options.reward === 1 ? 'passed' : 'failed';
  }
  return options.reward === 1 ? 'agent_error_passed' : 'agent_error_failed';
}
