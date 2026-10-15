import type { Clock } from '../../ports/clock.js';

export const systemClock: Clock = {
  now: () => new Date(),
};
