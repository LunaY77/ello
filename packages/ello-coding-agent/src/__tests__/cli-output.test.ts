import { describe, expect, it } from 'vitest';

import { formatCodingAgentEventOutput } from '../index.js';

describe('formatCodingAgentEventOutput', () => {
  it('formats JSON events with newline', () => {
    expect(
      formatCodingAgentEventOutput(
        { type: 'run_finished', runId: 'r1', success: true },
        true,
      ),
    ).toBe(`${JSON.stringify({ type: 'run_finished', runId: 'r1', success: true })}\n`);
  });

  it('formats tool display JSON snapshots for non-interactive runs', () => {
    const event = {
      type: 'tool_display',
      status: 'finished',
      toolCallId: 'tool_1',
      toolName: 'read_file',
      result: 'ok',
      durationMs: 12,
      finishedAt: '2026-06-27T00:00:00.012Z',
    } as const;

    expect(formatCodingAgentEventOutput(event, true)).toBe(`${JSON.stringify(event)}\n`);
  });

  it('formats streamed text in human mode', () => {
    expect(
      formatCodingAgentEventOutput(
        {
          type: 'core_event',
          event: {
            type: 'message.delta',
            messageId: 'm1',
            text: 'hello',
          },
        } as const,
        false,
      ),
    ).toBe('hello');
  });
});
