import type { CodingAgentConfig } from '@ello/coding-agent';
import React from 'react';
import { describe, expect, it } from 'vitest';


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

describe('TUI component smoke', () => {
  it('creates transcript, status, picker and tool card elements', () => {
    expect(Transcript({ items: [{ id: '1', role: 'user', text: 'hello' }] })).toBeTruthy();
    expect(StatusBar({ state: createInitialState(config), config })).toBeTruthy();
    expect(
      SessionPicker({
        selectedIndex: 0,
        sessions: [
          {
            sessionId: 's1',
            filePath: '/tmp/s1.jsonl',
            createdAt: null,
            updatedAt: '2026-06-27T00:00:00.000Z',
            leafId: null,
            entryCount: 1,
            branchOf: null,
          },
        ],
      }),
    ).toBeTruthy();
    expect(ModelPicker({ models: config.modelCandidates, selectedIndex: 1 })).toBeTruthy();
    expect(
      ToolCards({
        cards: [
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
        ],
      }),
    ).toBeTruthy();
  });

  it('creates approval and multiline composer elements', () => {
    expect(
      ToolApprovalPanel({
        request: {
          type: 'approval_request',
          toolCallId: 'call_1',
          toolName: 'shell_exec',
          input: { command: 'git status' },
          risk: 'Shell command',
        },
        draft: '{"command":"git status"}',
        onDraftChange: () => undefined,
        onApprove: () => undefined,
        onReject: () => undefined,
        onEdit: () => undefined,
        editing: false,
      }),
    ).toBeTruthy();
    const composer = Composer({
      value: 'first\nsecond',
      onChange: () => undefined,
      onSubmit: () => undefined,
    });
    expect(React.isValidElement(composer)).toBe(true);
  });
});
