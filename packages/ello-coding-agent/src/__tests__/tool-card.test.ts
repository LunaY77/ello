import { describe, expect, it } from 'vitest';

import { createFileChange } from '../tools/file-change.js';
import type { ToolCallView } from '../tui/store/history-entry.js';
import {
  buildToolCardModel as createToolCardModel,
  formatArtifactPath,
  formatDuration,
  formatToolPath,
  readToolMetadata,
} from '../tui/store/tool-card.js';

function call(over: Partial<ToolCallView>): ToolCallView {
  return { id: 't1', name: 'read', input: {}, status: 'ok', ...over };
}

function buildToolCardModel(
  toolCall: ToolCallView,
  options = { cwd: '/workspace', homeDir: '/home/alice' },
) {
  return createToolCardModel(toolCall, options);
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

describe('formatToolPath', () => {
  const options = { cwd: '/home/alice/project', homeDir: '/home/alice' };

  it('uses workspace-relative paths inside cwd', () => {
    expect(formatToolPath('/home/alice/project/src/index.ts', options)).toBe(
      'src/index.ts',
    );
    expect(formatToolPath('/home/alice/project', options)).toBe('.');
  });

  it('uses tilde paths for Ello artifacts and other home files', () => {
    expect(
      formatToolPath(
        '/home/alice/.ello/sessions/s1/artifacts/read.txt',
        options,
      ),
    ).toBe('~/.ello/sessions/s1/artifacts/read.txt');
    expect(formatToolPath('/home/alice/notes/todo.md', options)).toBe(
      '~/notes/todo.md',
    );
  });

  it('keeps relative and external absolute paths unchanged', () => {
    expect(formatToolPath('src/index.ts', options)).toBe('src/index.ts');
    expect(formatToolPath('/var/log/ello.log', options)).toBe(
      '/var/log/ello.log',
    );
    expect(formatToolPath('/home/alice/project-copy/a.ts', options)).toBe(
      '~/project-copy/a.ts',
    );
  });

  it('keeps leading directories and the final directory and file', () => {
    expect(
      formatToolPath('src/modules/agent/runtime/provider/config/schema.ts', {
        ...options,
        maxPathLength: 40,
      }),
    ).toBe('src/modules/agent/…/config/schema.ts');
  });
});

describe('formatArtifactPath', () => {
  it('keeps only a compact artifact id and file name', () => {
    expect(
      formatArtifactPath(
        '/home/alice/.ello/sessions/session/artifacts/run/877233fd-fb27-4dcb-adc3-5918b6a9f7b2/read.txt',
      ),
    ).toBe('877233fd…f7b2/read.txt');
  });
});

describe('buildToolCardModel', () => {
  it('humanizes tool name and picks a summary from metadata', () => {
    const model = buildToolCardModel(
      call({
        name: 'fetch',
        output: { metadata: { kind: 'network', url: 'https://x' } },
      }),
    );
    expect(model.name).toBe('Fetch');
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

  it('collects metrics and exposes a compact artifact view', () => {
    const outputPath =
      '/home/alice/.ello/sessions/session/artifacts/run/877233fd-fb27-4dcb-adc3-5918b6a9f7b2/read.txt';
    const model = buildToolCardModel(
      call({
        output: {
          metadata: {
            kind: 'read',
            totalLines: 12,
            matchCount: 3,
            truncated: true,
            outputPath,
          },
        },
      }),
      { cwd: '/home/alice/project', homeDir: '/home/alice' },
    );
    expect(model.metrics).toContain('12 lines');
    expect(model.metrics).toContain('3 matches');
    expect(model.details).toContain('12 lines');
    expect(model.details).toContain('3 matches');
    expect(model.details).toContain('truncated');
    expect(model.details).not.toContain('id t1');
    expect(model.details).not.toContain('kind read');
    expect(model.details.some((detail) => detail.includes('artifact'))).toBe(
      false,
    );
    expect(model.artifact).toEqual({
      displayPath: '877233fd…f7b2/read.txt',
      fullPath: outputPath,
    });
  });

  it('shortens absolute paths in headlines, summaries and diffs', () => {
    const targetPath = '/home/alice/project/src/a.ts';
    const model = buildToolCardModel(
      call({
        name: 'edit',
        input: { path: targetPath },
        output: {
          metadata: {
            kind: 'edit',
            path: targetPath,
            fileChanges: [createFileChange(targetPath, 'old\n', 'new\n')],
          },
        },
      }),
      { cwd: '/home/alice/project', homeDir: '/home/alice' },
    );

    expect(model.headline).toBe('Edited src/a.ts (+1 -1)');
    expect(model.summary).toBe('src/a.ts');
    expect(model.fileChanges?.[0]?.path).toBe('src/a.ts');
  });

  it('builds concise headlines and shell output previews', () => {
    const edited = buildToolCardModel(
      call({
        name: 'edit',
        input: { path: 'src/a.ts' },
        output: {
          metadata: {
            kind: 'edit',
            path: 'src/a.ts',
            fileChanges: [createFileChange('src/a.ts', 'old\n', 'new\n')],
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
        output: {
          metadata: {
            kind: 'edit',
            fileChanges: [createFileChange('a.ts', '', 'x\n')],
          },
        },
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
