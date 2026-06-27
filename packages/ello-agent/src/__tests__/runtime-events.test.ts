import { describe, expect, it } from 'vitest';

import {
  agentError,
  agentStart,
  createAgent,
  messageDelta,
  toolExecutionStart,
} from '../index.js';

describe('runtime event factories', () => {
  it('creates stable stream events', () => {
    expect(agentStart('run_1')).toEqual({ type: 'agent_start', runId: 'run_1' });
    expect(
      messageDelta(
        { type: 'text', text: 'hi' },
        { role: 'assistant', content: 'hi' },
      ),
    ).toMatchObject({ type: 'message_delta' });
    expect(
      toolExecutionStart({ toolCallId: 'call_1', toolName: 'read_file', args: {} }),
    ).toMatchObject({ type: 'tool_execution_start', toolName: 'read_file' });
    expect(agentError(new Error('boom'), [])).toMatchObject({
      type: 'agent_error',
    });
  });

  it('emits agent_error before failing a runtime stream', async () => {
    const error = new Error('provider hook failed');
    const runtime = createAgent({
      providerHooks: {
        beforeRequest: async () => {
          throw error;
        },
      },
    });
    await runtime.enter();
    try {
      const stream = runtime.stream('hello');
      const events = [];
      await expect(async () => {
        for await (const event of stream) {
          events.push(event);
        }
      }).rejects.toThrow('provider hook failed');

      expect(events.map((event) => event.type)).toContain('agent_error');
      expect(events.at(-1)).toMatchObject({
        type: 'agent_error',
        error,
      });
      await expect(stream.result()).rejects.toThrow('provider hook failed');
    } finally {
      await runtime.exit();
    }
  });
});
