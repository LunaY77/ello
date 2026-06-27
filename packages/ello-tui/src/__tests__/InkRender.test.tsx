import type { CodingAgentConfig } from '@ello/coding-agent';
import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';


import {
  ModelPicker,
  SessionPicker,
  StatusBar,
  ToolApprovalPanel,
  ToolCards,
  Transcript,
} from '../Components.js';
import { Composer } from '../Composer.js';
import { createInitialState } from '../state/index.js';

const config: CodingAgentConfig = {
  model: 'openai-chat:gpt-4o-mini',
  modelCandidates: ['openai-chat:gpt-4o-mini', 'openai-chat:gpt-4.1'],
  baseUrl: null,
  cwd: '/repo',
  allowedPaths: ['/repo'],
  sessionDir: '/tmp/sessions',
  sessionId: 's1',
  approvalMode: 'on-request',
  permissionRules: [],
  mcpConfigPath: null,
  systemPromptProfile: 'coding',
  theme: 'default',
  tui: true,
  json: false,
};

afterEach(() => {
  cleanup();
});

describe('Ink render output', () => {
  it('renders transcript text and role prefixes', () => {
    const { lastFrame } = render(
      <Transcript
        items={[
          { id: 'user_1', role: 'user', text: 'hello' },
          { id: 'tool_1', role: 'tool', text: 'read_file finished' },
        ]}
      />,
    );

    expect(lastFrame()).toContain('> hello');
    expect(lastFrame()).toContain('[tool] read_file finished');
  });

  it('renders status facts and exit confirmation', () => {
    const state = { ...createInitialState(config), exitPending: true };
    const { lastFrame } = render(<StatusBar state={state} config={config} />);

    expect(lastFrame()).toContain('ready');
    expect(lastFrame()).toContain('model=openai-chat:gpt-4o-mini');
    expect(lastFrame()).toContain('exit?');
  });

  it('renders approval panel and tool cards', () => {
    const approval = render(
      <ToolApprovalPanel
        request={{
          type: 'approval_request',
          toolCallId: 'call_1',
          toolName: 'shell_exec',
          input: { command: 'git status' },
          risk: 'Shell commands can modify workspace.',
        }}
        draft={'{"command":"git status"}'}
        onDraftChange={() => undefined}
        onApprove={() => undefined}
        onReject={() => undefined}
        onEdit={() => undefined}
        editing={false}
      />,
    );
    expect(approval.lastFrame()).toContain('approval shell_exec');
    expect(approval.lastFrame()).toContain('Shell commands can modify workspace.');

    const tools = render(
      <ToolCards
        cards={[
          {
            toolCallId: 'tool_1',
            toolName: 'read_file',
            status: 'finished',
            args: { path: 'README.md' },
            result: 'ok',
            isError: false,
            startedAt: '2026-06-27T00:00:00.000Z',
            finishedAt: '2026-06-27T00:00:00.010Z',
            durationMs: 10,
          },
        ]}
      />,
    );
    expect(tools.lastFrame()).toContain('read_file finished 10ms');
    expect(tools.lastFrame()).toContain('README.md');
  });

  it('renders pickers and multiline composer rows', () => {
    const sessions = render(
      <SessionPicker
        selectedIndex={0}
        sessions={[
          {
            sessionId: 's1',
            filePath: '/tmp/s1.jsonl',
            createdAt: null,
            updatedAt: '2026-06-27T00:00:00.000Z',
            leafId: null,
            entryCount: 2,
            branchOf: null,
          },
        ]}
      />,
    );
    expect(sessions.lastFrame()).toContain('> s1 2 entries');

    const models = render(
      <ModelPicker models={config.modelCandidates} selectedIndex={1} />,
    );
    expect(models.lastFrame()).toContain('> openai-chat:gpt-4.1');

    const composer = render(
      <Composer
        value={'first line\nsecond'}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(composer.lastFrame()).toContain('composer');
    expect(composer.lastFrame()).toContain('first line');
    expect(composer.lastFrame()).toContain('second');
  });
});
