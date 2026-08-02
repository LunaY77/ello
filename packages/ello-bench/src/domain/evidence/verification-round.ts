import type { BenchmarkRound } from '../contract/index.js';

export function lastVerificationRound(
  rounds: readonly BenchmarkRound[],
): number | null {
  const matched = [...rounds]
    .reverse()
    .find((round) =>
      round.toolCalls.some(
        (tool) =>
          tool.category === 'shell' &&
          tool.command !== null &&
          /(?:^|\s)(?:test|pytest|vitest|jest|mocha|cargo\s+(?:test|check)|go\s+test|typecheck|lint|build|check|tsc)(?:\s|$)/iu.test(
            tool.command,
          ),
      ),
    );
  return matched?.round ?? null;
}
