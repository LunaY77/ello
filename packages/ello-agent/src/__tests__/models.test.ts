import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BaseTool,
  createAgent,
  normalizeModelName,
  resolveModel,
  splitProviderAndModel,
  type ToolArgs,
  type ToolRunContext,
} from '../index.js';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
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
        responseMessages: [{ role: 'assistant', content: 'mocked' }],
        options,
      };
    }),
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

  it('requires enter before run', async () => {
    const runtime = createAgent();

    await expect(runtime.run('hello')).rejects.toThrow('must be entered');
  });

  it('rejects non string prompt before model call', async () => {
    const { generateText } = await import('ai');
    const runtime = createAgent();

    await runtime.enter();
    try {
      await expect(runtime.run(123 as never)).rejects.toThrow(
        'input must be a prompt string',
      );
      expect(generateText).not.toHaveBeenCalled();
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
      expect(result.options.messages).toEqual([
        { role: 'user', content: 'hello' },
      ]);
      expect(result.options).not.toHaveProperty('prompt');
    } finally {
      await runtime.exit();
    }
  });

  it('adds Python-compatible output and allMessages to run result', async () => {
    const runtime = createAgent();

    await runtime.enter();
    try {
      const result = await runtime.run('hello');

      expect(result.output).toBe('mocked');
      expect(result.allMessages()).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'mocked' },
      ]);
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
        prompt: 'hello',
        maxRetries: 0,
        temperature: 0.2,
      });
      expect(result.options).not.toHaveProperty('messages');
    } finally {
      await runtime.exit();
    }
  });

  it('uses messages when message history is provided', async () => {
    const runtime = createAgent({ systemPrompt: 'You are concise.' });

    await runtime.enter();
    try {
      const result = (await runtime.run({
        prompt: 'hello',
        messageHistory: [{ role: 'user', content: 'history' }],
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options).toMatchObject({
        system: 'You are concise.',
      });
      expect(result.options).toHaveProperty('messages');
      expect(result.options.messages).toEqual([
        { role: 'user', content: 'history' },
        { role: 'user', content: 'hello' },
      ]);
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
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce(
      async (options: Record<string, unknown>) => {
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
          text: '',
          responseMessages: [
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
          ],
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
    const runtime = createAgent({ tools: [RuntimeApprovalTool] });
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
    ];

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages,
        deferredToolResults: {
          approvals: { 'call-1': true },
          calls: {},
        },
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options.messages).toEqual([
        ...messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'dangerous_action',
              output: 'executed on prod',
            },
          ],
        },
      ]);
    } finally {
      await runtime.exit();
    }
  });

  it('keeps denied deferred approval as denied tool result', async () => {
    const runtime = createAgent({ tools: [RuntimeApprovalTool] });
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
    ];

    await runtime.enter();
    try {
      const result = (await runtime.run({
        messages,
        deferredToolResults: {
          approvals: {
            'call-1': { approved: false, reason: 'not allowed' },
          },
          calls: {},
        },
      })) as unknown as { options: Record<string, unknown> };

      expect(result.options.messages).toEqual([
        ...messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'dangerous_action',
              output: 'denied: not allowed',
            },
          ],
        },
      ]);
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
});
