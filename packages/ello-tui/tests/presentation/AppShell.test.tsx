import { renderToString } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { createFileChange } from '../../src/testing/protocol-fixtures.js';
import { AppShell } from '../../src/tui/component/AppShell.js';
import { OverlayHost } from '../../src/tui/component/OverlayHost.js';
import { TerminalHistoryOutput } from '../../src/tui/component/TerminalHistoryOutput.js';
import { ToolActivityList } from '../../src/tui/component/ToolActivityList.js';
import { presenterFor } from '../../src/tui/presenters/index.js';
import { overlayCallbacks } from '../support/overlay-fixture.js';

const DISPLAY_SETTINGS = {
  agent: 'build',
  mode: 'ask-before-changes',
} as const;

describe('TerminalHistoryOutput', () => {
  it('为 Static 的每个 history child 提供稳定 key', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      renderToString(
        <TerminalHistoryOutput
          cwd="/workspace"
          resetKey={0}
          settings={DISPLAY_SETTINGS}
          entries={[
            {
              kind: 'user',
              id: 'user-key',
              turnId: 'turn-key',
              text: 'hello',
            },
            { kind: 'assistant', id: 'assistant-key', text: 'hi' },
          ]}
        />,
      );
      expect(
        consoleError.mock.calls.some((args) =>
          args.some((arg) => String(arg).includes('unique "key" prop')),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('renders the session header as committed history', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        cwd="/tmp/ello-workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          {
            kind: 'session_header',
            id: 'header',
            threadId: 'thread-header',
            cwd: '/tmp/ello-workspace',
            agent: 'build',
            mode: 'ask',
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Ello Coding Agent');
    expect(output).toContain('directory: /tmp/ello-workspace');
    expect(output).toContain('agent: build');
    expect(output).toContain('mode: ask-before-changes');
  });

  it('keeps committed reasoning muted and above the assistant output', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        cwd="/workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          {
            kind: 'reasoning',
            id: 'reasoning-1',
            text: 'checking the context',
          },
          { kind: 'assistant', id: 'assistant-1', text: 'final output' },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).not.toContain('reasoning:');
    expect(output.indexOf('Thinking: checking the context')).toBeLessThan(
      output.indexOf('* final output'),
    );
  });

  it('indents every committed reasoning line after the Thinking label', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        cwd="/workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          {
            kind: 'reasoning',
            id: 'reasoning-multiline',
            text: 'first line\nsecond line',
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Thinking: first line\n          second line');
  });

  it('renders the complete compact checkpoint as muted history', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        cwd="/workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          {
            kind: 'compaction',
            id: 'compaction-7',
            summary: '## Goal\nPreserve the current implementation state.',
            tokensBefore: 4_096,
            beforeMessageCount: 12,
            afterMessageCount: 3,
            keptMessageCount: 2,
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain(
      'Context compacted · 12 -> 3 messages · 4.1k tokens before',
    );
    expect(output).toContain('## Goal');
    expect(output).toContain('Preserve the current implementation state.');
    expect(output).not.toContain('jobId');
  });

  it('renders user, assistant and tool history outside AppShell', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        cwd="/workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          { kind: 'user', id: 'u1', turnId: 'turn-1', text: 'hello' },
          { kind: 'assistant', id: 'a1', text: 'hi' },
          {
            kind: 'tool',
            id: 'tool-1',
            tool: {
              id: 'tool-1',
              name: 'edit',
              input: { path: '/workspace/tmp.txt' },
              status: 'ok',
              output: {
                metadata: {
                  kind: 'edit',
                  path: '/workspace/tmp.txt',
                  fileChanges: [
                    createFileChange('/workspace/tmp.txt', 'old\n', 'new\n'),
                  ],
                },
              },
            },
          },
          {
            kind: 'tool',
            id: 'tool-2',
            tool: {
              id: 'tool-2',
              name: 'bash',
              input: { command: 'pnpm build' },
              status: 'ok',
              output: {
                output: '> @ello/tui build\n> tsc -p tsconfig.json',
                metadata: {
                  kind: 'shell',
                  command: 'pnpm build',
                  exitCode: 0,
                },
              },
            },
          },
          {
            kind: 'separator',
            id: 'sep-1',
            text: 'Worked for 1m 2s',
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain('> hello');
    expect(output).toContain('* hi');
    expect(output).toContain('Edited tmp.txt (+1 -1)');
    expect(output).not.toContain('kind edit');
    expect(output).toContain('• Ran pnpm build');
    expect(output).toContain('> @ello/tui build');
    expect(output).toContain('─ Worked for 1m 2s');
    expect(output).toContain('1   - old');
    expect(output).toContain('  1 + new');
    expect(output.split('\n').find((line) => line.includes('M tmp.txt'))).toBe(
      '  M tmp.txt',
    );
  });

  it('keeps rendering when legacy Command Run history has invalid file changes', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        cwd="/workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          {
            kind: 'command_run',
            id: 'command-run:legacy-edit',
            run: {
              id: 'command-run:legacy-edit',
              status: 'ok',
              commands: [
                {
                  id: 'command-run:legacy-edit:0',
                  index: 0,
                  step: 1,
                  name: 'apply_patch',
                  input: { patch: '*** Begin Patch' },
                  commandStatus: 'completed',
                  status: 'ok',
                  output: {
                    metadata: {
                      kind: 'edit',
                      path: 'tool-test.txt',
                      fileChanges: [
                        {
                          kind: 'modified',
                          path: 'tool-test.txt',
                          unifiedDiff: '@@ -1 +1 @@\n-old\n+new',
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Command Run · ok');
    expect(output).toContain('Invalid file change metadata; diff unavailable.');
  });

  it('keeps live tool activity rendering when file changes are invalid', () => {
    const output = renderToString(
      <ToolActivityList
        cwd="/workspace"
        expanded
        tools={[
          {
            id: 'legacy-edit',
            name: 'apply_patch',
            input: { patch: '*** Begin Patch' },
            status: 'ok',
            output: {
              metadata: {
                kind: 'edit',
                path: 'tool-test.txt',
                fileChanges: [{ kind: 'modified', path: 'tool-test.txt' }],
              },
            },
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Invalid file change metadata; diff unavailable.');
  });

  it('renders truncated output with one compact artifact line', () => {
    const fullPath =
      '/home/alice/.ello/sessions/31ad2cbd-ebe6-456b-95a0-ae0766c40a2f/artifacts/877233fd-fb27-4dcb-adc3-5918b6a9f7b2/877233fd-fb27-4dcb-adc3-5918b6a9f7b2/read.txt';
    const view = (
      <TerminalHistoryOutput
        cwd="/workspace"
        resetKey={0}
        settings={DISPLAY_SETTINGS}
        entries={[
          {
            kind: 'tool',
            id: 'read-1',
            tool: {
              id: 'read-1',
              name: 'read',
              input: { path: '/workspace/src/config/schema.ts' },
              status: 'ok',
              output: {
                metadata: {
                  kind: 'read',
                  path: '/workspace/src/config/schema.ts',
                  totalLines: 412,
                  truncated: true,
                  outputPath: fullPath,
                },
              },
            },
          },
        ]}
      />
    );
    const output = renderToString(view, { columns: 100 });

    expect(output).toContain('Read src/config/schema.ts');
    expect(output).toContain('412 lines · truncated');
    expect(output).toContain('artifact  877233fd…f7b2/read.txt');
    expect(output).not.toContain('~/.ello');
    expect(output).not.toContain('full log');
    expect(output.match(/877233fd…f7b2\/read\.txt/gu)).toHaveLength(1);

    const narrowOutput = renderToString(view, { columns: 28 });
    const artifactLine = narrowOutput
      .split('\n')
      .find((line) => line.includes('artifact'));
    expect(artifactLine).toMatch(/^\s{2}artifact\s{2}.*…f7b2\/read\.txt$/u);
  });
});

describe('AppShell', () => {
  it('renders only live viewport and bottom dock', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'bypass',
        }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running={false}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).not.toContain('Ello Coding Agent');
    expect(output).toContain('main');
    expect(output).toContain('bypass');
  });

  it('keeps model references separate from runtime status on narrow terminals', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="primary: deepseek-v4-pro · auxiliary: deepseek-v4-flash"
        mode={{ mode: 'bypass' }}
        contextPercent={100}
        contextWindow={1_000_000}
        usage={{
          requests: 0,
          inputTokens: 4_600_000,
          lastInputTokens: 100_000,
          outputTokens: 4_800,
          cacheReadTokens: 4_500_000,
          cacheWriteTokens: 0,
          toolCalls: 0,
        }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running={false}
        overlay={null}
        composer={null}
      />,
      { columns: 60 },
    );

    expect(output).toContain('primary: deepseek-v4-pro');
    expect(output).toContain('auxiliary: deepseek-v4-flash');
    expect(output).toContain('context 100.0k / 1.0m');
    expect(output).not.toContain('session 4.6m tokens');
    expect(output).toContain('98% cached');
    expect(
      output
        .split('\n')
        .some((line) => line.includes('auxiliary:') && line.includes('bypass')),
    ).toBe(false);
  });

  it('shows running status in the live viewport', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'ask-before-changes',
        }}
        liveAssistantText="I am checking the parser"
        runningTools={[]}
        runningSubagents={[]}
        running
        workingSeconds={12}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('* I am checking the parser');
    expect(output).toContain('working 12s');
  });

  it('shows live reasoning separately from assistant output', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{ mode: 'ask-before-changes' }}
        liveAssistantText="final output"
        liveReasoningText="checking the context"
        runningTools={[]}
        runningSubagents={[]}
        running
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Thinking: checking the context');
    expect(output.indexOf('Thinking: checking the context')).toBeLessThan(
      output.indexOf('* final output'),
    );
  });

  it('把多行 reasoning 折叠成单行尾部预览', () => {
    // 设计稿 §5：reasoning 只在 live 区留单行尾部预览，完整内容进静态历史。
    // 多行展开会让 dynamic frame 涨到终端高度，触发 Ink 的整屏重绘（闪屏）。
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{ mode: 'ask-before-changes' }}
        liveAssistantText=""
        liveReasoningText={'first line\nsecond line'}
        runningTools={[]}
        runningSubagents={[]}
        running
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Thinking: first line second line');
    expect(output).not.toContain('\n           second line');
  });

  it('does not render blank assistant stream chunks as empty message lines', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'ask-before-changes',
        }}
        liveAssistantText={'\n\n   \n'}
        runningTools={[]}
        runningSubagents={[]}
        running
        workingSeconds={1}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).not.toContain('*');
    expect(output).toContain('working 1s');
  });

  it('shows an interrupt notice when idle after abort', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'ask-before-changes',
        }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running={false}
        interruptNotice="interrupted: user interrupted from TUI"
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('interrupted: user interrupted from TUI');
  });

  it('shows queued steering above the composer', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'ask-before-changes',
        }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running
        pendingSteers={['stop now']}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Messages queued for the running turn');
    expect(output).toContain('-> stop now');
  });

  it('renders running subagent status with nested tools', () => {
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'ask-before-changes',
        }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[
          {
            runId: 'task-1',
            agentName: 'explore',
            description: 'inspect loader',
            status: 'running',
            startedAt: '2026-07-01T00:00:00.000Z',
            tools: [
              {
                id: 'read-1',
                name: 'read',
                input: { path: '/workspace/src/config.ts' },
                status: 'running',
              },
            ],
          },
        ]}
        running
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('explore');
    expect(output).toContain('inspect loader');
    expect(output).toContain('Read');
    expect(output).toContain('src/config.ts');
    expect(output).not.toContain('/workspace/src/config.ts');
  });

  it('limits subagent tool activity to the latest four calls', () => {
    const tools = Array.from({ length: 6 }, (_, index) => ({
      id: `tool-${index}`,
      name: 'read',
      input: { path: `src/file-${index}.ts` },
      status: 'ok' as const,
      output: { metadata: { totalLines: index + 1 } },
    }));
    const output = renderToString(
      <AppShell
        cwd="/workspace"
        model="main"
        mode={{
          mode: 'ask-before-changes',
        }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[
          {
            runId: 'task-1',
            agentName: 'explore',
            description: 'inspect loader',
            status: 'running',
            startedAt: '2026-07-01T00:00:00.000Z',
            tools,
          },
        ]}
        running
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('+2 tool uses');
    expect(output).not.toContain('src/file-0.ts');
    expect(output).not.toContain('src/file-1.ts');
    expect(output).toContain('src/file-2.ts');
    expect(output).toContain('src/file-5.ts');
  });

  it('renders write/edit diffs with plus and minus prefixes', () => {
    const diff = presenterFor('write').renderResult(
      { path: 'tmp.txt' },
      {
        metadata: {
          fileChanges: [createFileChange('tmp.txt', 'old\n', 'new\n')],
        },
      },
    );
    const output = renderToString(<>{diff}</>, { columns: 100 });

    expect(output).toContain('M tmp.txt');
    expect(output).toContain('1   - old');
    expect(output).toContain('  1 + new');
  });

  it('renders the subagent browser overlay', () => {
    const output = renderToString(
      <OverlayHost
        {...overlayCallbacks()}
        overlay={{
          type: 'agents',
          agents: [
            {
              id: 'explore',
              name: 'explore',
              description: 'Search and read code',
              enabled: true,
              metadata: {
                mode: 'subagent',
                role: 'small',
                source: 'bundled',
                tools: ['read', 'grep', 'glob'],
              },
            },
          ],
        }}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Subagents');
    expect(output).toContain('explore');
  });
});
