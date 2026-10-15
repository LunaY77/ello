export const MIN_INTERVAL_SAMPLES = 3;

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export function wilsonInterval(
  passed: number,
  total: number,
  confidence = 0.95,
): Interval {
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error('Wilson interval requires at least one observation.');
  }
  if (!Number.isInteger(passed) || passed < 0 || passed > total) {
    throw new Error(`Invalid pass count: ${passed} of ${total}.`);
  }
  if (confidence !== 0.95) {
    throw new Error('Only the pre-registered 95% interval is supported.');
  }
  const z = 1.959963984540054;
  const proportion = passed / total;
  const denominator = 1 + z ** 2 / total;
  const center = (proportion + z ** 2 / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / total + z ** 2 / (4 * total ** 2),
    );
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function intervalOrNull(passed: number, total: number): Interval | null {
  return total < MIN_INTERVAL_SAMPLES ? null : wilsonInterval(passed, total);
}
