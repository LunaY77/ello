/**
 * 验证 Thread item 终态投影保留工具执行的真实结果。
 */
import { describe, expect, it } from 'vitest';

import {
  failItem,
  projectFileChangeMetadata,
} from '../../src/features/thread/items.js';
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

  it('projects an internal move as a protocol rename with source and target paths', () => {
    expect(
      projectFileChangeMetadata({
        fileChanges: [
          {
            kind: 'modified',
            path: 'old.txt',
            movePath: 'new.txt',
            additions: 1,
            deletions: 1,
            unifiedDiff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      }),
    ).toEqual({
      fileChanges: [
        {
          kind: 'rename',
          oldPath: 'old.txt',
          path: 'new.txt',
          additions: 1,
          deletions: 1,
          diff: '@@ -1 +1 @@\n-old\n+new',
        },
      ],
    });
  });
});
