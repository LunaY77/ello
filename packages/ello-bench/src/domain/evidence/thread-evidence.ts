import type { BenchmarkRound } from '../contract/index.js';

export function combineThreadRounds(
  rounds: readonly BenchmarkRound[],
): readonly BenchmarkRound[] {
  return [...rounds]
    .sort((left, right) => {
      const leftTime =
        left.startedAt === null
          ? Number.MAX_SAFE_INTEGER
          : Date.parse(left.startedAt);
      const rightTime =
        right.startedAt === null
          ? Number.MAX_SAFE_INTEGER
          : Date.parse(right.startedAt);
      return (
        leftTime - rightTime || left.requestId.localeCompare(right.requestId)
      );
    })
    .map((round, index) => ({ ...round, round: index + 1 }));
}
