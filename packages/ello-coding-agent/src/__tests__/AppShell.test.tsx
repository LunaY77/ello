import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { AppShell } from '../tui/components/AppShell.js';
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
        running
        workingSeconds={12}
        overlay={null}
        composer={null}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Ello Coding Agent');
    expect(output).toContain('› you');
    expect(output).toContain('✦ ello');
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
        diff: ['--- tmp.txt', '+++ tmp.txt', '- old', '+ new'].join('\n'),
      },
    );
    const output = renderToString(<>{diff}</>, { columns: 100 });

    expect(output).toContain('- old');
    expect(output).toContain('+ new');
  });
});
