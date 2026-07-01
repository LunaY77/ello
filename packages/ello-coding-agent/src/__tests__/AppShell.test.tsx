import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { AppShell } from '../tui/components/AppShell.js';
import { OverlayHost } from '../tui/overlays/OverlayHost.js';
import { presenterFor } from '../tui/presenters/index.js';

describe('AppShell', () => {
  it('renders the initial coding-agent panel', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="bypass"
        transcript={[]}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running={false}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Ello Coding Agent');
    expect(output).toContain('profile:');
    expect(output).toContain('main');
    expect(output).toContain('directory:');
    expect(output).toContain('permissions:');
    expect(output).toContain('YOLO mode');
  });

  it('keeps the hero visible with transcript and shows working state', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[
          { kind: 'user', id: 'u1', text: 'hello' },
          { kind: 'assistant', id: 'a1', text: 'hi' },
        ]}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running
        workingSeconds={12}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Ello Coding Agent');
    expect(output).toContain('hello');
    expect(output).toContain('hi');
    expect(output).not.toContain('› you');
    expect(output).not.toContain('✦ ello');
    expect(output).toContain('working... 12s');
  });

  it('shows an interrupt notice when idle after abort', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[]}
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

  it('shows completed turn duration when not running', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[]}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running={false}
        workedFor="1m 2s"
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('worked for 1m 2s');
  });

  it('shows queued steering above the composer instead of transcript', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[]}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running
        pendingSteers={['停止']}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Messages to be submitted after next tool call');
    expect(output).toContain('↳ 停止');
    expect(output).not.toContain('› you     停止');
  });

  it('renders write/edit diffs with plus and minus prefixes', () => {
    const diff = presenterFor('write').renderResult(
      { path: 'tmp.txt' },
      {
        metadata: {
          diff: ['--- tmp.txt', '+++ tmp.txt', '- old', '+ new'].join('\n'),
        },
      },
    );
    const output = renderToString(<>{diff}</>, { columns: 100 });

    expect(output).toContain('- old');
    expect(output).toContain('+ new');
  });

  it('expands write/edit diffs in transcript history', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[
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
                  path: 'tmp.txt',
                  diff: ['--- tmp.txt', '+++ tmp.txt', '- old', '+ new'].join(
                    '\n',
                  ),
                },
              },
            },
          },
        ]}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running={false}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Edit');
    expect(output).toContain('tmp.txt');
    expect(output).toContain('- old');
    expect(output).toContain('+ new');
  });

  it('renders running subagent status with nested tools', () => {
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[]}
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

  it('limits subagent tool history to the latest four calls', () => {
    const tools = Array.from({ length: 6 }, (_, index) => ({
      id: `tool-${index}`,
      name: 'read',
      input: { path: `src/file-${index}.ts` },
      status: 'ok' as const,
      output: { metadata: { totalLines: index + 1 } },
    }));
    const output = renderToString(
      <AppShell
        cwd="/tmp/ello-workspace"
        profile="main"
        approvalMode="default"
        transcript={[]}
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
