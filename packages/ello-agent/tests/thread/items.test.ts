/**
 * 验证 Thread item 终态投影保留工具执行的真实结果。
 */
import { describe, expect, it } from 'vitest';

import { failItem } from '../../src/features/thread/items.js';
import type { ThreadItem } from '../../src/protocol/v1/index.js';

describe('thread items', () => {
  it('preserves a tool failure message in the protocol item', () => {
    const item: ThreadItem = {
      type: 'toolCall',
      id: 'call_glob',
      turnId: 'turn_1',
      createdAt: '2026-07-28T00:00:00.000Z',
      toolName: 'glob',
      headline: 'Glob packages',
      status: 'inProgress',
      metadata: {
        input: { filePath: '/outside/packages', pattern: '**/*context*' },
      },
    };

    expect(failItem(item, 'Path not allowed: /outside/packages')).toEqual({
      ...item,
      status: 'failed',
      error: 'Path not allowed: /outside/packages',
    });
  });
});
