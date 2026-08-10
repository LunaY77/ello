import { describe, expect, it } from 'vitest';

import { classifyDeliveryOutcome } from '../src/domain/scoring/attempt-outcome.js';

describe('delivery outcome', () => {
  it('does not accept a normal stop with an empty patch when verification fails', () => {
    expect(
      classifyDeliveryOutcome({
        process: processResult(),
        reward: 0,
        patch: { bytes: 0 },
      }),
    ).toBe('failed');
  });

  it('allows an empty patch only when the verifier proves the repository already passes', () => {
    expect(
      classifyDeliveryOutcome({
        process: processResult(),
        reward: 1,
        patch: { bytes: 0 },
      }),
    ).toBe('passed');
  });
});

function processResult() {
  return {
    command: ['ello'],
    cwd: '/workspace',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
  };
}
