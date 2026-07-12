import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { createFileChange } from '../tools/file-change.js';
import { AppShell } from '../tui/component/AppShell.js';
import { OverlayHost } from '../tui/component/OverlayHost.js';
import { TerminalHistoryOutput } from '../tui/component/TerminalHistoryOutput.js';
import { presenterFor } from '../tui/presenters/index.js';

describe('TerminalHistoryOutput', () => {
  it('renders the session header as committed history', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        resetKey={0}
        entries={[
          {
            kind: 'session_header',
            id: 'header',
            cwd: '/tmp/ello-workspace',
            profile: 'main',
            model: 'openai-chat:test',
            approvalMode: 'ask',
          },
        ]}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Ello Coding Agent');
    expect(output).toContain('profile: main');
    expect(output).toContain('directory: /tmp/ello-workspace');
    expect(output).toContain('model: openai-chat:test');
    expect(output).toContain('permissions: ask');
  });

  it('renders user, assistant and tool history outside AppShell', () => {
    const output = renderToString(
      <TerminalHistoryOutput
        resetKey={0}
        entries={[
          { kind: 'user', id: 'u1', text: 'hello' },
          { kind: 'assistant', id: 'a1', text: 'hi' },
          {
            kind: 'tool',
            id: 'tool-1',
            tool: {
              id: 'tool-1',
              name: 'edit',
              input: { path: 'tmp.txt' },
              status: 'ok',
              output: {
                metadata: {
                  kind: 'edit',
                  path: 'tmp.txt',
                  fileChanges: [createFileChange('tmp.txt', 'old\n', 'new\n')],
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
                output: '> @ello/coding-agent build\n> tsc -p tsconfig.json',
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
    expect(output).toContain('> @ello/coding-agent build');
    expect(output).toContain('─ Worked for 1m 2s');
    expect(output).toContain('1   - old');
    expect(output).toContain('  1 + new');
    expect(output.split('\n').find((line) => line.includes('M tmp.txt'))).toBe(
      '  M tmp.txt',
    );
  });
});

describe('AppShell', () => {
  it('renders only live viewport and bottom dock', () => {
    const output = renderToString(
      <AppShell
        profile="main"
        approvalMode="bypass"
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

  it('shows running status in the live viewport', () => {
    const output = renderToString(
      <AppShell
        profile="main"
        approvalMode="default"
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

  it('does not render blank assistant stream chunks as empty message lines', () => {
    const output = renderToString(
      <AppShell
        profile="main"
        approvalMode="default"
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
        profile="main"
        approvalMode="default"
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
        profile="main"
        approvalMode="default"
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
        profile="main"
        approvalMode="default"
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[
          {
            runId: 'task-1',
            agentName: 'explore',
            description: 'inspect loader',
            background: false,
            status: 'running',
            startedAt: '2026-07-01T00:00:00.000Z',
            tools: [
              {
                id: 'read-1',
                name: 'read',
                input: { path: 'src/config.ts' },
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
    expect(output).toContain('foreground');
    expect(output).toContain('inspect loader');
    expect(output).toContain('Read');
    expect(output).toContain('src/config.ts');
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
        profile="main"
        approvalMode="default"
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[
          {
            runId: 'task-1',
            agentName: 'explore',
            description: 'inspect loader',
            background: false,
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

    expect(output).toContain('+2 earlier tool calls');
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
        overlay={{
          type: 'agents',
          agents: [
            {
              name: 'explore',
              description: 'Search and read code',
              mode: 'subagent',
              role: 'small',
              source: 'bundled',
              tools: ['read', 'grep', 'glob'],
            },
          ],
        }}
        onApprove={() => {}}
        onSelectModel={() => {}}
        onSelectProfile={() => {}}
        onCreateProfile={() => {}}
        onRequestDeleteProfile={() => {}}
        onConfirmDeleteProfile={() => {}}
        onActivateProfile={() => {}}
        onSubmitNewProfile={() => {}}
        onSelectProfileRole={() => {}}
        onBindProfileRoleModel={() => {}}
        onOpenProfiles={() => {}}
        onSaveProfile={() => {}}
        onSelectSession={() => {}}
        onSelectRewind={() => {}}
        onSelectTheme={() => {}}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Subagents');
    expect(output).toContain('explore');
    expect(output).toContain('bundled');
    expect(output).toContain('small');
    expect(output).toContain('read, grep, glob');
  });
});
