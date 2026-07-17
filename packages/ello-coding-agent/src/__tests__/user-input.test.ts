import type { AgentMessage } from '@ello/agent';
import { describe, expect, it } from 'vitest';

import { messagesToHistoryEntries } from '../tui/store/history-replay.js';
import {
  recoverPendingUserInput,
  UserInputRequestSchema,
  validateUserInputResolution,
} from '../user-input/index.js';

const request = UserInputRequestSchema.parse({
  questions: [
    {
      id: 'storage',
      header: 'Storage',
      question: 'Which storage should be used?',
      options: [
        { label: 'SQLite', description: 'Local and transactional.' },
        { label: 'JSONL', description: 'Simple append-only records.' },
      ],
      multiSelect: false,
    },
  ],
});

describe('user input protocol', () => {
  it('rejects duplicate ids, labels, and incomplete resolutions', () => {
    expect(() =>
      UserInputRequestSchema.parse({
        questions: [
          request.questions[0],
          { ...request.questions[0], header: 'Other' },
        ],
      }),
    ).toThrow();
    expect(() =>
      UserInputRequestSchema.parse({
        questions: [
          {
            ...request.questions[0],
            options: [
              { label: 'Same', description: 'First.' },
              { label: 'Same', description: 'Second.' },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateUserInputResolution(request, {
        status: 'submitted',
        answers: [],
      }),
    ).toThrow();
    expect(() =>
      validateUserInputResolution(request, {
        status: 'submitted',
        answers: [{ questionId: 'storage', selected: ['Unknown'] }],
      }),
    ).toThrow('unknown selections');
  });

  it('accepts submitted, Other, chat, and denied results', () => {
    expect(
      validateUserInputResolution(request, {
        status: 'submitted',
        answers: [{ questionId: 'storage', selected: ['SQLite'] }],
      }),
    ).toMatchObject({ status: 'submitted' });
    expect(
      validateUserInputResolution(request, {
        status: 'submitted',
        answers: [
          {
            questionId: 'storage',
            selected: ['Other'],
            otherText: 'Postgres',
          },
        ],
      }),
    ).toMatchObject({ status: 'submitted' });
    expect(
      validateUserInputResolution(request, { status: 'chat', message: 'Why?' }),
    ).toEqual({
      status: 'chat',
      message: 'Why?',
    });
    expect(validateUserInputResolution(request, { status: 'denied' })).toEqual({
      status: 'denied',
    });
  });

  it('recovers exactly one unmatched request from transcript', () => {
    const call = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'request_user_input',
          input: request,
        },
      ],
    } as AgentMessage;
    expect(recoverPendingUserInput([call], 'session-1')).toEqual({
      toolCallId: 'call-1',
      request,
    });
    const result = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'request_user_input',
          output: { type: 'json', value: { status: 'denied' } },
        },
      ],
    } as AgentMessage;
    expect(recoverPendingUserInput([call, result], 'session-1')).toBeNull();
    expect(messagesToHistoryEntries([call, result], undefined)).toEqual([
      expect.objectContaining({
        kind: 'user_input',
        resolution: { status: 'denied' },
      }),
    ]);
    const failedResult = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'request_user_input',
          output: { type: 'error-text', value: 'invalid request' },
        },
      ],
    } as AgentMessage;
    expect(messagesToHistoryEntries([call, failedResult], undefined)).toEqual([
      expect.objectContaining({ kind: 'tool' }),
    ]);
    expect(() =>
      recoverPendingUserInput([call, { ...call }], 'session-1'),
    ).toThrow('duplicate');
  });
});
