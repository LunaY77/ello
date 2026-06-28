import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { TranscriptItem } from '../product/event-store.js';
import type { ToolCallView } from '../product/events.js';
import { AppShell } from '../tui/components/AppShell.js';
import { OverlayHost } from '../tui/overlays/OverlayHost.js';

const footer = { cwd: '/repo', model: 'fake:test', mode: 'default', context: 'ctx 12%' };

describe('Ink TUI render states', () => {
  it('renders transcript, live run, composer and footer in the vertical workbench', () => {
    const { lastFrame } = render(
      <AppShell
        transcript={transcript()}
        currentAssistantText="working"
        runningTools={[bashTool()]}
        footer={footer}
        composerValue="next instruction"
        composerHints={['/model', '@package.json']}
        queueHint="steering: 1 queued"
        running
        overlay={null}
        onComposerChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Live run');
    expect(frame).toContain('stdout');
    expect(frame).toContain('hello');
    expect(frame).toContain('next instruction');
    expect(frame).toContain('ctx 12%');
  });

  it('renders approval overlays without hiding the underlying app shell', () => {
    const overlay = (
      <OverlayHost
        overlay={{
          type: 'approval',
          request: {
            id: 'call_bash',
            toolCallId: 'call_bash',
            toolName: 'bash',
            input: { command: 'pnpm test' },
            reason: 'Tool bash requires approval.',
            risk: 'medium',
            createdAt: new Date().toISOString(),
          },
        }}
      />
    );
    const { lastFrame } = render(
      <AppShell
        transcript={transcript()}
        currentAssistantText=""
        runningTools={[]}
        footer={footer}
        composerValue=""
        composerHints={[]}
        queueHint="ready"
        running={false}
        overlay={overlay}
        onComposerChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('approval');
    expect(frame).toContain('bash');
    expect(frame).toContain('[a] approve once');
    expect(frame).toContain('assistant');
  });

  it('renders diff tool cards for completed write/edit tools', () => {
    const { lastFrame } = render(
      <AppShell
        transcript={[{ id: 'write', role: 'tool', tool: writeTool() }]}
        currentAssistantText=""
        runningTools={[]}
        footer={footer}
        composerValue=""
        composerHints={[]}
        queueHint="ready"
        running={false}
        overlay={null}
        onComposerChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('tool write');
    expect(frame).toContain('success');
  });
});

function transcript(): TranscriptItem[] {
  return [
    { id: 'user', role: 'user', text: 'hello' },
    { id: 'assistant', role: 'assistant', text: 'hi' },
  ];
}

function bashTool(): ToolCallView {
  return {
    id: 'bash',
    name: 'bash',
    status: 'success',
    summary: 'bash printf hello',
    durationMs: 12,
    render: { kind: 'bash', stdout: 'hello', stderr: '', exitCode: 0 },
  };
}

function writeTool(): ToolCallView {
  return {
    id: 'write',
    name: 'write',
    status: 'success',
    summary: 'write note.txt',
    render: { kind: 'diff', target: 'note.txt', diff: '--- /dev/null\n+++ note.txt\n+ hello' },
  };
}
