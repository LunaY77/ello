import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentContext,
  LocalEnvironment,
  ModelConfig,
  coldStartTrim,
  createEnvironmentInstructionsFilter,
  injectRuntimeInstructions,
  truncateToolContent,
} from '../index.js';

function user(content: ModelMessage['content']): ModelMessage {
  return { role: 'user', content };
}

function assistant(
  content: ModelMessage['content'],
  timestamp?: Date,
): ModelMessage {
  return {
    role: 'assistant',
    content,
    ...(timestamp ? { timestamp } : {}),
  } as ModelMessage;
}

function toolResult(value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'test',
        output: { type: 'text', value },
      },
    ],
  };
}

function ctx(
  options: {
    forceInjectInstructions?: boolean;
    coldStartTrimSeconds?: number | null;
  } = {},
): AgentContext {
  return new AgentContext({
    env: new LocalEnvironment(),
    modelConfig: new ModelConfig({
      coldStartTrimSeconds:
        options.coldStartTrimSeconds === undefined
          ? 3_600
          : options.coldStartTrimSeconds,
    }),
    forceInjectInstructions: options.forceInjectInstructions ?? false,
  });
}

function toolText(message: ModelMessage): string {
  if (message.role !== 'tool') {
    return '';
  }
  const part = message.content[0];
  if (part?.type !== 'tool-result') {
    return '';
  }
  const output = part.output as { value?: unknown };
  return String(output.value ?? '');
}

describe('coldStartTrim', () => {
  it('keeps short content unchanged', () => {
    expect(truncateToolContent('short')).toBe('short');
  });

  it('truncates long content with head and tail', () => {
    const result = truncateToolContent('A'.repeat(1_000));

    expect(result).toContain('[... 600 chars truncated ...]');
    expect(result.startsWith('A'.repeat(200))).toBe(true);
    expect(result.endsWith('A'.repeat(200))).toBe(true);
  });

  it('returns empty history unchanged', () => {
    expect(coldStartTrim({ deps: ctx() }, [])).toEqual([]);
  });

  it('does not trim when threshold is disabled', () => {
    const history = [toolResult('x'.repeat(1_000))];

    expect(
      coldStartTrim({ deps: ctx({ coldStartTrimSeconds: null }) }, history),
    ).toBe(history);
    expect(toolText(history[0]!)).toBe('x'.repeat(1_000));
  });

  it('does not trim when idle time is below threshold', () => {
    const history = [
      toolResult('x'.repeat(1_000)),
      assistant('ok', new Date(Date.now() - 60_000)),
      user('next'),
    ];

    coldStartTrim({ deps: ctx({ coldStartTrimSeconds: 3_600 }) }, history);

    expect(toolText(history[0]!)).toBe('x'.repeat(1_000));
  });

  it('trims tool results before the last response when idle exceeds threshold', () => {
    const history = [
      toolResult('X'.repeat(1_000)),
      assistant('ok', new Date(Date.now() - 2 * 60 * 60 * 1_000)),
      user('next'),
    ];

    coldStartTrim({ deps: ctx({ coldStartTrimSeconds: 3_600 }) }, history);

    expect(toolText(history[0]!)).toContain('chars truncated');
  });

  it('preserves tool results after the last response', () => {
    const history = [
      assistant('old', new Date(Date.now() - 2 * 60 * 60 * 1_000)),
      toolResult('Y'.repeat(1_000)),
    ];

    coldStartTrim({ deps: ctx({ coldStartTrimSeconds: 3_600 }) }, history);

    expect(toolText(history[1]!)).toBe('Y'.repeat(1_000));
  });
});

describe('environment instructions filter', () => {
  it('injects instructions on user prompt', async () => {
    const env = {
      getContextInstructions: vi.fn(async () => '<env>cwd=/tmp</env>'),
    } as unknown as LocalEnvironment;
    const filter = createEnvironmentInstructionsFilter(env);
    const history = [user('hello')];

    const result = await filter({ deps: ctx() }, history);

    expect(JSON.stringify(result[0])).toContain('<env>cwd=/tmp</env>');
  });

  it('skips tool return unless force inject is enabled', async () => {
    const env = {
      getContextInstructions: vi.fn(async () => '<env>cwd=/tmp</env>'),
    } as unknown as LocalEnvironment;
    const filter = createEnvironmentInstructionsFilter(env);
    const history = [toolResult('result')];

    await filter({ deps: ctx() }, history);
    expect(history[0]!.role).toBe('tool');

    await filter({ deps: ctx({ forceInjectInstructions: true }) }, history);
    expect(history[0]).toEqual({
      role: 'user',
      content: '<env>cwd=/tmp</env>',
    });
  });

  it('does not inject empty instructions', async () => {
    const env = {
      getContextInstructions: vi.fn(async () => ''),
    } as unknown as LocalEnvironment;
    const filter = createEnvironmentInstructionsFilter(env);
    const history = [user('hello')];

    await filter({ deps: ctx() }, history);

    expect(history).toEqual([user('hello')]);
  });
});

describe('runtime instructions filter', () => {
  it('injects runtime context on user prompt', async () => {
    const history = [user('hello')];
    const result = await injectRuntimeInstructions({ deps: ctx() }, history);

    expect(JSON.stringify(result[0])).toContain('<runtime-context>');
    expect(JSON.stringify(result[0])).toContain('<run-id>');
  });

  it('skips tool return unless forced', async () => {
    const history = [toolResult('out')];

    await injectRuntimeInstructions({ deps: ctx() }, history);
    expect(history[0]!.role).toBe('tool');

    await injectRuntimeInstructions(
      { deps: ctx({ forceInjectInstructions: true }) },
      history,
    );
    expect(history[0]!.role).toBe('user');
  });

  it('returns empty history unchanged', async () => {
    await expect(
      injectRuntimeInstructions({ deps: ctx() }, []),
    ).resolves.toEqual([]);
  });
});
