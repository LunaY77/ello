import { describe, expect, it } from 'vitest';

import type { ToolCallView } from '../tui/store/history-entry.js';
import {
  buildToolCardModel,
  formatDuration,
  readToolMetadata,
} from '../tui/store/tool-card.js';

function call(over: Partial<ToolCallView>): ToolCallView {
  return { id: 't1', name: 'read', input: {}, status: 'ok', ...over };
}

describe('formatDuration', () => {
  it('formats sub-second, seconds and minutes', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(90_000)).toBe('1m 30s');
  });
});

describe('readToolMetadata', () => {
  it('returns metadata object or undefined', () => {
    expect(readToolMetadata({ metadata: { kind: 'read' } })).toEqual({
      kind: 'read',
    });
    expect(readToolMetadata('not-an-object')).toBeUndefined();
    expect(readToolMetadata({ metadata: null })).toBeUndefined();
  });
});

describe('buildToolCardModel', () => {
  it('humanizes tool name and picks a summary from metadata', () => {
    const model = buildToolCardModel(
      call({
        name: 'web_fetch',
        output: { metadata: { kind: 'network', url: 'https://x' } },
      }),
    );
    expect(model.name).toBe('Web Fetch');
    expect(model.headline).toBe('Fetched https://x');
    expect(model.summary).toBe('https://x');
    expect(model.icon).toBe('✓');
  });

  it('prioritizes denied/failed over exit code and duration', () => {
    const denied = buildToolCardModel(
      call({
        status: 'fail',
        error: { name: 'E', message: 'permission denied' } as never,
      }),
    );
    expect(denied.metaRight).toBe('denied');

    const failed = buildToolCardModel(
      call({ status: 'fail', error: { name: 'E', message: 'boom' } as never }),
    );
    expect(failed.metaRight).toBe('failed');

    const exit = buildToolCardModel(
      call({
        output: { metadata: { kind: 'shell', exitCode: 2, durationMs: 1000 } },
      }),
    );
    expect(exit.metaRight).toBe('exit 2');

    const timed = buildToolCardModel(
      call({
        output: { metadata: { kind: 'shell', exitCode: 0, durationMs: 1500 } },
      }),
    );
    expect(timed.metaRight).toBe('1.5s');
  });

  it('collects metrics and truncation notice', () => {
    const model = buildToolCardModel(
      call({
        output: {
          metadata: {
            kind: 'read',
            totalLines: 12,
            matchCount: 3,
            truncated: true,
            outputPath: '/tmp/log',
          },
        },
      }),
    );
    expect(model.metrics).toContain('12 lines');
    expect(model.metrics).toContain('3 matches');
    expect(model.details).toContain('12 lines');
    expect(model.details).toContain('3 matches');
    expect(model.details).toContain('truncated');
    expect(model.details).not.toContain('id t1');
    expect(model.details).not.toContain('kind read');
    expect(model.truncationNotice).toContain('/tmp/log');
  });

  it('builds codex-style headlines and shell output previews', () => {
    const edited = buildToolCardModel(
      call({
        name: 'edit',
        input: { path: 'src/a.ts' },
        output: {
          metadata: {
            kind: 'edit',
            path: 'src/a.ts',
            diff: ['--- src/a.ts', '+++ src/a.ts', '-old', '+new'].join('\n'),
          },
        },
      }),
    );
    expect(edited.headline).toBe('Edited src/a.ts (+1 -1)');
    expect(edited.outputPreview).toEqual([]);

    const shell = buildToolCardModel(
      call({
        name: 'bash',
        input: { command: 'pnpm build' },
        output: {
          output: 'first line\nsecond line',
          metadata: { kind: 'shell', command: 'pnpm build', exitCode: 0 },
        },
      }),
    );
    expect(shell.headline).toBe('Ran pnpm build');
    expect(shell.outputPreview).toEqual(['first line', 'second line']);
  });

  it('defaults to collapsed for plain success, expanded for diff or failure', () => {
    const plain = buildToolCardModel(
      call({ output: { metadata: { kind: 'read' } } }),
    );
    expect(plain.defaultCollapsed).toBe(true);
    expect(plain.hasDiff).toBe(false);

    const withDiff = buildToolCardModel(
      call({
        output: { metadata: { kind: 'edit', diff: '@@ -1 +1 @@\n+x\n' } },
      }),
    );
    expect(withDiff.hasDiff).toBe(true);
    expect(withDiff.defaultCollapsed).toBe(false);

    const failed = buildToolCardModel(
      call({ status: 'fail', error: { name: 'E', message: 'x' } as never }),
    );
    expect(failed.defaultCollapsed).toBe(false);
  });
});
