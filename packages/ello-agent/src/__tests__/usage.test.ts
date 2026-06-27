import { describe, expect, it } from 'vitest';

import { UsageSnapshot, addUsage, coerceRunUsage } from '../index.js';

describe('usage helpers', () => {
  it('coerces partial and callable usage', () => {
    expect(
      coerceRunUsage({
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        toolCalls: 6,
      }),
    ).toEqual({
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      toolCalls: 6,
    });

    expect(
      coerceRunUsage(() => ({
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        toolCalls: 6,
      })),
    ).toEqual({
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      toolCalls: 6,
    });
  });

  it('adds usage from partial shapes', () => {
    expect(
      addUsage(
        { requests: 1, inputTokens: 2 },
        { requests: 3, inputTokens: 4, toolCalls: 5 },
      ),
    ).toEqual({
      requests: 4,
      inputTokens: 6,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 5,
    });
  });
});

describe('UsageSnapshot', () => {
  it('records entries and exposes totals', () => {
    const snapshot = new UsageSnapshot('run-1');

    snapshot.record({
      agentId: 'main',
      agentName: 'Main',
      modelId: 'model-a',
      usage: { requests: 1, inputTokens: 2, outputTokens: 3 },
      source: 'model_request',
    });
    snapshot.record({
      agentId: 'main',
      agentName: 'Main',
      modelId: 'model-a',
      usage: { requests: 2, inputTokens: 4, toolCalls: 1 },
      source: 'tool',
    });

    expect(snapshot.runId).toBe('run-1');
    expect(snapshot.totalUsage).toEqual({
      requests: 3,
      inputTokens: 6,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 1,
    });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      agentId: 'main',
      agentName: 'Main',
      modelId: 'model-a',
      source: 'model_request',
    });
    expect(snapshot.agentUsageTotals.main.usage.requests).toBe(3);
    expect(snapshot.modelUsageTotals['model-a']?.inputTokens).toBe(6);
  });
});
