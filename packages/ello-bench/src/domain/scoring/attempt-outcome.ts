import type { HarnessReport } from '../contract/index.js';

export type AttemptOutcome =
  | {
      readonly kind: 'invalid';
      readonly reason: 'baseline-unhealthy';
      readonly exitCode: number;
    }
  | { readonly kind: 'scored'; readonly reward: 0 | 1 };

export function classifyAttempt(harness: HarnessReport): AttemptOutcome {
  if (harness.baselineTestExitCode !== 0) {
    return {
      kind: 'invalid',
      reason: 'baseline-unhealthy',
      exitCode: harness.baselineTestExitCode,
    };
  }
  return {
    kind: 'scored',
    reward: harness.newTestsExitCode === 0 ? 1 : 0,
  };
}
