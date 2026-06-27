import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BaseTool,
  createAgent,
  createMessageEntry,
  InMemorySessionStorage,
  getModelSettings,
  normalizeModelName,
  resolveModel,
  splitProviderAndModel,
  type ToolArgs,
  type ToolRunContext,
} from '../index.js';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const defaultUsage = {
    requests: 1,
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
  function makeStreamResult(options: Record<string, unknown>) {
    if (typeof options.onStepEnd === 'function') {
      options.onStepEnd({
        toolCalls: [],
      });
    }
    const responseMessages = [{ role: 'assistant', content: 'mocked' }];
    return {
      text: Promise.resolve('mocked'),
      usage: Promise.resolve(defaultUsage),
      responseMessages: Promise.resolve(responseMessages),
      steps: Promise.resolve([{ toolCalls: [] }]),
      options,
      stream: (async function* () {
        yield { type: 'text-start', id: 'text-1' };
        yield { type: 'text-delta', id: 'text-1', text: 'mocked' };
        yield { type: 'text-end', id: 'text-1' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: defaultUsage,
        };
      })(),
    };
  }
  return {
    ...actual,
    generateText: vi.fn(async (options: Record<string, unknown>) => {
      if (typeof options.onStepEnd === 'function') {
        options.onStepEnd({
          toolCalls: [],
        });
      }
      return {
        text: 'mocked',
        usage: {
          requests: 1,
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCalls: 0,
        },
        responseMessages: [{ role: 'assistant', content: 'mocked' }],
        options,
      };
    }),
    streamText: vi.fn((options: Record<string, unknown>) =>
      makeStreamResult(options),
    ),
  };
});

class RuntimeEchoTool extends BaseTool {
  static override toolName = 'runtime_echo';
  static override description = 'Echo runtime input.';

  async call(_ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    return `echo:${String(args.value ?? '')}`;
  }
}

class RuntimeApprovalTool extends BaseTool {
  static override toolName = 'dangerous_action';
  static override description = 'Dangerous action.';
  static override requiresApproval = true;

  async call(_ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    return `executed on ${String(args.target ?? 'default')}`;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('model parsing', () => {
  it('uses the default model name', () => {
    expect(normalizeModelName()).toBe('openai-chat:gpt-4o-mini');
  });

  it('rejects ambiguous openai provider', () => {
    expect(() => normalizeModelName('openai:gpt-4o')).toThrow(
      /openai-chat.*openai-responses/,
    );
  });

  it('splits provider and model', () => {
    expect(splitProviderAndModel('openai-chat:gpt-4o-mini')).toEqual([
      'openai-chat',
      'gpt-4o-mini',
    ]);
    expect(splitProviderAndModel('gpt-4o-mini')).toEqual([null, 'gpt-4o-mini']);
  });

  it('resolves openai base url', () => {
    const selection = resolveModel({
      modelName: 'openai-chat:gpt-4.1-mini',
      baseUrl: 'https://gateway.example.com/v1',
    });

    expect(selection.modelName).toBe('openai-chat:gpt-4.1-mini');
    expect(selection.baseUrl).toBe('https://gateway.example.com/v1');
  });

  it('normalizes anthropic base url from env', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://anthropic.example.com/v1');

    const selection = resolveModel({
      modelName: 'anthropic:claude-sonnet-4-5',
    });

    expect(selection.modelName).toBe('anthropic:claude-sonnet-4-5');
    expect(selection.baseUrl).toBe('https://anthropic.example.com');
  });

  it('rejects unsupported provider base url overrides', () => {
    expect(() =>
      resolveModel({
        modelName: 'google:gemini-2.5-flash',
        baseUrl: 'https://gateway.example.com/v1',
      }),
    ).toThrow('base_url is not supported');
  });

  it('reads gateway credentials', () => {
    vi.stubEnv('MYGATEWAY_API_KEY', 'test-key');
    vi.stubEnv('MYGATEWAY_BASE_URL', 'https://gateway.example.com/v1');

    const selection = resolveModel({
      modelName: 'gateway@mygateway:openai-chat:gpt-4o-mini',
    });

    expect(selection.modelName).toBe('openai-chat:gpt-4o-mini');
    expect(selection.baseUrl).toBe('https://gateway.example.com/v1');
  });

  it('requires gateway environment', () => {
    expect(() =>
      resolveModel({ modelName: 'gateway@missing:openai-chat:gpt-4o-mini' }),
    ).toThrow('Gateway API key not found');
  });
});

describe('createAgent', () => {
  it('creates runtime with default configuration', () => {
    const runtime = createAgent();

    expect(runtime.modelName).toBe('openai-chat:gpt-4o-mini');
    expect(runtime.baseUrl).toBeNull();
    expect(runtime.env.constructor.name).toBe('LocalEnvironment');
    expect(runtime.systemPrompt).toContain('You are ello');
  });

  it('preserves explicit model base url and system prompt', () => {
    const runtime = createAgent({
      modelName: 'openai-chat:gpt-4.1-mini',
      baseUrl: 'https://gateway.example.com/v1',
      systemPrompt: 'You are concise.',
    });

    expect(runtime.modelName).toBe('openai-chat:gpt-4.1-mini');
    expect(runtime.baseUrl).toBe('https://gateway.example.com/v1');
    expect(runtime.systemPrompt).toBe('You are concise.');
  });

  it('renders system prompt template variables', () => {
    const runtime = createAgent({
      systemPrompt: 'Hello {{ name }}. {{ missing }}',
      systemPromptTemplateVars: { name: 'ello' },
    });

    expect(runtime.systemPrompt).toBe('Hello ello. ');
  });

  it('renders default additional instructions block', () => {
    const runtime = createAgent({
      systemPromptTemplateVars: { instructions: 'Always inspect files first.' },
    });

    expect(runtime.systemPrompt).toContain('## Additional Instructions');
    expect(runtime.systemPrompt).toContain('Always inspect files first.');
  });

  it('keeps blank system prompt blank', () => {
    const runtime = createAgent({ systemPrompt: '  ' });

    expect(runtime.systemPrompt).toBe('');
  });

  it('passes model settings into generateText', async () => {
    const runtime = createAgent({
      modelSettings: 'openai_responses_high',
    });

    await runtime.enter();
    try {
      const result = (await runtime.run('hello')) as unknown as {
        options: Record<string, unknown>;
      };

      expect(result.options).toMatchObject(
        getModelSettings('openai_responses_high'),
      );
    } finally {
      await runtime.exit();
    }
  });

  it('keeps compact configuration on runtime', () => {
    const runtime = createAgent({ compact: true });

    expect(runtime.compact).toBe(true);
  });

  it('applies compact filter when compact is enabled', async () => {
    const runtime = createAgent({
      compact: true,
      modelConfig: { contextWindow: 1_000, compactThreshold: 0.9 },
      systemPrompt: 'You are concise.',
    });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages: Array.from({ length: 20 }, (_, index) => [
          { role: 'user', content: `question ${index} `.repeat(50) },
          { role: 'assistant', content: `answer ${index} `.repeat(50) },
        ])
          .flatMap((pair) => pair)
          .concat({
            role: 'assistant',
            content: 'latest answer',
            usage: { totalTokens: 950 },
          } as never),
      })) as unknown as { options: Record<string, unknown> };

      expect(JSON.stringify(result.options.messages)).toContain(
        'Context was compacted',
      );
      expect(JSON.stringify(result.options.messages)).toContain('mocked');
    } finally {
      await runtime.exit();
    }
  });

  it('requires enter before run', async () => {
    const runtime = createAgent();

    await expect(runtime.run('hello')).rejects.toThrow('must be entered');
  });

  it('rejects non string prompt before model call', async () => {
    const { streamText } = await import('ai');
    const runtime = createAgent();

    await runtime.enter();
    try {
      await expect(runtime.run(123 as never)).rejects.toThrow(
        'input must be a prompt string',
      );
      expect(streamText).not.toHaveBeenCalled();
    } finally {
      await runtime.exit();
    }
  });

  it('accepts AI SDK generateText messages object', async () => {
    const runtime = createAgent({ systemPrompt: 'You are concise.' });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages: [{ role: 'user', content: 'hello' }],
        maxRetries: 0,
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options).toMatchObject({
        system: 'You are concise.',
        maxRetries: 0,
      });
      expect(JSON.stringify(result.options.messages)).toContain('hello');
    } finally {
      await runtime.exit();
    }
  });

  it('returns output and allMessages from run result', async () => {
    const runtime = createAgent();

    await runtime.enter();
    try {
      const result = await runtime.run('hello');

      expect(result.output).toBe('mocked');
      expect(result.allMessages()).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'mocked' },
      ]);
      expect(runtime.ctx?.usageSnapshot.entries).toHaveLength(1);
      expect(runtime.ctx?.usageSnapshot.totalUsage).toEqual(
        expect.objectContaining({
          requests: 1,
          inputTokens: 11,
          outputTokens: 7,
        }),
      );
    } finally {
      await runtime.exit();
    }
  });

  it('accepts AI SDK generateText prompt object', async () => {
    const runtime = createAgent({ systemPrompt: 'You are concise.' });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        prompt: 'hello',
        maxRetries: 0,
        temperature: 0.2,
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options).toMatchObject({
        system: 'You are concise.',
        maxRetries: 0,
        temperature: 0.2,
      });
      expect(JSON.stringify(result.options.messages)).toContain('hello');
    } finally {
      await runtime.exit();
    }
  });

  it('uses explicit messages as context', async () => {
    const runtime = createAgent({ systemPrompt: 'You are concise.' });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages: [
          { role: 'user', content: 'history' },
          { role: 'user', content: 'hello' },
        ],
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options).toMatchObject({
        system: 'You are concise.',
      });
      expect(result.options).toHaveProperty('messages');
      expect(JSON.stringify(result.options.messages)).toContain('history');
      expect(JSON.stringify(result.options.messages)).toContain('hello');
      expect(result.options).not.toHaveProperty('prompt');
    } finally {
      await runtime.exit();
    }
  });

  it('keeps runtime-owned model and tools when options include them', async () => {
    const runtime = createAgent({ tools: [RuntimeEchoTool] });
    const externalModel = { provider: 'external', modelId: 'external' };

    await runtime.enter();
    try {
      const result = (await runtime.run({
        prompt: 'hello',
        model: externalModel as never,
        tools: {} as never,
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options.model).not.toBe(externalModel);
      expect(result.options.tools).toHaveProperty('runtime_echo');
    } finally {
      await runtime.exit();
    }
  });

  it('runs provider hooks around model calls', async () => {
    const beforeRequest = vi.fn(async (request) => request);
    const beforePayload = vi.fn(async (payload) => payload);
    const afterResponse = vi.fn(async () => undefined);
    const runtime = createAgent({
      providerHooks: {
        beforeRequest,
        beforePayload,
        afterResponse,
      },
    });

    await runtime.enter();
    try {
      await runtime.run('hello');

      expect(beforeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          modelName: 'openai-chat:gpt-4o-mini',
          payload: expect.objectContaining({
            messages: expect.any(Array),
          }),
        }),
      );
      expect(beforePayload).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.any(Array),
        }),
      );
      expect(afterResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          modelName: 'openai-chat:gpt-4o-mini',
          body: [{ role: 'assistant', content: 'mocked' }],
        }),
      );
    } finally {
      await runtime.exit();
    }
  });

  it('bridges Toolset tools into AI SDK tools', async () => {
    const runtime = createAgent({ tools: [RuntimeEchoTool] });

    await runtime.enter();
    try {
      const result = (await runtime.run('hello')) as unknown as {
        options: {
          tools: Record<
            string,
            { execute: (args: Record<string, unknown>) => Promise<unknown> }
          >;
        };
      };

      expect(result.options.tools).toHaveProperty('runtime_echo');
      await expect(
        result.options.tools.runtime_echo.execute({ value: 'x' }),
      ).resolves.toBe('echo:x');
    } finally {
      await runtime.exit();
    }
  });

  it('marks approval tools as deferred without executing them', async () => {
    const runtime = createAgent({ tools: [RuntimeApprovalTool] });

    await runtime.enter();
    try {
      const result = (await runtime.run('hello')) as unknown as {
        options: {
          tools: Record<
            string,
            { execute: (args: Record<string, unknown>) => Promise<unknown> }
          >;
        };
      };

      await expect(
        result.options.tools.dangerous_action.execute({ target: 'prod' }),
      ).resolves.toEqual({
        status: 'deferred',
        reason: 'Tool execution requires approval.',
      });
    } finally {
      await runtime.exit();
    }
  });

  it('returns DeferredToolRequests when approval tools are called', async () => {
    const { streamText } = await import('ai');
    vi.mocked(streamText).mockImplementationOnce(
      (options: Record<string, unknown>) => {
        if (typeof options.onStepEnd === 'function') {
          options.onStepEnd({
            toolCalls: [
              {
                toolCallId: 'call-1',
                toolName: 'dangerous_action',
                input: { target: 'prod' },
              },
            ],
          });
        }
        return {
          text: Promise.resolve(''),
          usage: Promise.resolve({
            requests: 1,
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 1,
          }),
          responseMessages: Promise.resolve([
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'dangerous_action',
                  input: { target: 'prod' },
                },
              ],
            },
          ]),
          steps: Promise.resolve([
            {
              toolCalls: [
                {
                  toolCallId: 'call-1',
                  toolName: 'dangerous_action',
                  input: { target: 'prod' },
                },
              ],
            },
          ]),
          stream: (async function* () {
            yield {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'dangerous_action',
              input: { target: 'prod' },
            };
          })(),
          options,
        } as never;
      },
    );
    const runtime = createAgent({ tools: [RuntimeApprovalTool] });

    await runtime.enter();
    try {
      const result = await runtime.run('approve it');

      expect(result.output).toEqual({
        approvals: [
          {
            toolCallId: 'call-1',
            toolName: 'dangerous_action',
            input: { target: 'prod' },
          },
        ],
        calls: [],
      });
    } finally {
      await runtime.exit();
    }
  });

  it('executes approved deferred approval tool on resume', async () => {
    const messages = [
      { role: 'user' as const, content: 'approve it' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'dangerous_action',
            input: { target: 'prod' },
          },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call-1',
            toolName: 'dangerous_action',
            output: 'executed on prod',
          },
        ],
      },
    ];
    const runtime = createAgent({ tools: [RuntimeApprovalTool] });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages,
      })) as unknown as { options: Record<string, unknown> };

      expect(JSON.stringify(result.options.messages)).toContain('approve it');
      expect(JSON.stringify(result.options.messages)).toContain(
        'executed on prod',
      );
    } finally {
      await runtime.exit();
    }
  });

  it('keeps denied deferred approval as denied tool result', async () => {
    const messages = [
      { role: 'user' as const, content: 'approve it' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'dangerous_action',
            input: { target: 'prod' },
          },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call-1',
            toolName: 'dangerous_action',
            output: 'denied: not allowed',
          },
        ],
      },
    ];
    const runtime = createAgent({ tools: [RuntimeApprovalTool] });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages,
      })) as unknown as { options: Record<string, unknown> };

      expect(JSON.stringify(result.options.messages)).toContain('approve it');
      expect(JSON.stringify(result.options.messages)).toContain(
        'denied: not allowed',
      );
    } finally {
      await runtime.exit();
    }
  });

  it('enter creates context and exit clears it', async () => {
    const runtime = createAgent();

    expect(runtime.ctx).toBeNull();
    await runtime.enter();
    try {
      expect(runtime.ctx).not.toBeNull();
      expect(runtime.ctx?.env).toBe(runtime.env);
    } finally {
      await runtime.exit();
    }
    expect(runtime.ctx).toBeNull();
  });

  it('uses session history when no explicit messages are provided', async () => {
    const session = new InMemorySessionStorage({
      entries: [
        createMessageEntry({
          message: { role: 'user', content: 'session hello' },
        }),
      ],
    });
    const runtime = createAgent({ session });

    await runtime.enter();
    try {
      const result = (await runtime.run('follow up')) as unknown as {
        options: Record<string, unknown>;
      };

      expect(JSON.stringify(result.options.messages)).toContain(
        'session hello',
      );
      expect(JSON.stringify(result.options.messages)).toContain('follow up');
    } finally {
      await runtime.exit();
    }
  });

  it('persists run messages into session storage', async () => {
    const session = new InMemorySessionStorage();
    const runtime = createAgent({ session });

    await runtime.enter();
    try {
      await runtime.run('hello');

      const entries = await session.getEntries();
      expect(entries.some((entry) => entry.type === 'model_change')).toBe(true);
      expect(entries.some((entry) => entry.type === 'message')).toBe(true);
      expect(entries.at(-1)?.type).toBe('message');
    } finally {
      await runtime.exit();
    }
  });

  it('records compaction entries when compacting session-backed runs', async () => {
    const session = new InMemorySessionStorage({
      entries: [
        createMessageEntry({
          message: { role: 'user', content: 'session hello' },
        }),
      ],
    });
    const runtime = createAgent({
      session,
      compact: true,
      modelConfig: { contextWindow: 1_000, compactThreshold: 0.9 },
      systemPrompt: 'You are concise.',
    });

    await runtime.enter();
    try {
      await runtime.run({
        messages: Array.from({ length: 20 }, (_, index) => [
          { role: 'user', content: `question ${index} `.repeat(50) },
          { role: 'assistant', content: `answer ${index} `.repeat(50) },
        ])
          .flatMap((pair) => pair)
          .concat({
            role: 'assistant',
            content: 'latest answer',
            usage: { totalTokens: 950 },
          } as never),
      });

      const entries = await session.getEntries();
      expect(entries.some((entry) => entry.type === 'compaction')).toBe(true);
      expect(entries.some((entry) => entry.type === 'model_change')).toBe(true);
    } finally {
      await runtime.exit();
    }
  });
});
