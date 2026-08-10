/**
 * 验证各生产 provider adapter 发出的 Command Run wire contract。
 *
 * 测试只替换最终网络请求，schema 与历史消息均经过实际 AI SDK provider 转换。
 */
import type { JSONSchema7 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAiSdkLanguageModel } from '../../src/features/model/providers/ai-sdk/ai-sdk-provider.js';

const commandRunSchema = {
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          step: { type: 'integer', minimum: 1 },
          command: { type: 'string' },
        },
        required: ['step', 'command'],
        additionalProperties: false,
      },
    },
  },
  required: ['commands'],
  additionalProperties: false,
} satisfies JSONSchema7;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider Command Run contract', () => {
  it.each([
    {
      name: 'OpenAI Responses',
      descriptor: {
        protocol: 'openai' as const,
        endpoint: 'responses' as const,
        modelId: 'gpt-test',
        baseURL: 'https://provider.example.test/v1',
        apiKey: 'test-key',
      },
      path: '/responses',
      providerOptions: { openai: { parallelToolCalls: false } },
      toolNames: (body: Record<string, unknown>) =>
        readArray(body.tools).map((tool) => readString(readObject(tool).name)),
      paired: responsesHistoryIsPaired,
      parallelCallDisabled: (body: Record<string, unknown>) =>
        body.parallel_tool_calls === false,
    },
    {
      name: 'OpenAI Chat',
      descriptor: {
        protocol: 'openai' as const,
        endpoint: 'chat' as const,
        modelId: 'gpt-test',
        baseURL: 'https://provider.example.test/v1',
        apiKey: 'test-key',
      },
      path: '/chat/completions',
      providerOptions: { openai: { parallelToolCalls: false } },
      toolNames: (body: Record<string, unknown>) =>
        readArray(body.tools).map((tool) =>
          readString(readObject(readObject(tool).function).name),
        ),
      paired: chatHistoryIsPaired,
      parallelCallDisabled: (body: Record<string, unknown>) =>
        body.parallel_tool_calls === false,
    },
    {
      name: 'Anthropic',
      descriptor: {
        protocol: 'anthropic' as const,
        authScheme: 'api-key' as const,
        modelId: 'claude-test',
        baseURL: 'https://provider.example.test/v1',
        apiKey: 'test-key',
      },
      path: '/messages',
      providerOptions: { anthropic: { disableParallelToolUse: true } },
      toolNames: (body: Record<string, unknown>) =>
        readArray(body.tools).map((tool) => readString(readObject(tool).name)),
      paired: anthropicHistoryIsPaired,
      parallelCallDisabled: (body: Record<string, unknown>) =>
        readObject(body.tool_choice).disable_parallel_tool_use === true,
    },
    {
      name: 'OpenAI-compatible Chat',
      descriptor: {
        protocol: 'openai-compatible' as const,
        endpoint: 'chat' as const,
        modelId: 'vendor-test',
        baseURL: 'https://provider.example.test/v1',
        apiKey: 'test-key',
      },
      path: '/chat/completions',
      providerOptions: { openai: { parallelToolCalls: false } },
      toolNames: (body: Record<string, unknown>) =>
        readArray(body.tools).map((tool) =>
          readString(readObject(readObject(tool).function).name),
        ),
      paired: chatHistoryIsPaired,
      parallelCallDisabled: (body: Record<string, unknown>) =>
        body.parallel_tool_calls === false,
    },
    {
      name: 'OpenAI-compatible Responses',
      descriptor: {
        protocol: 'openai-compatible' as const,
        endpoint: 'responses' as const,
        modelId: 'vendor-test',
        baseURL: 'https://provider.example.test/v1',
        apiKey: 'test-key',
      },
      path: '/responses',
      providerOptions: { openai: { parallelToolCalls: false } },
      toolNames: (body: Record<string, unknown>) =>
        readArray(body.tools).map((tool) => readString(readObject(tool).name)),
      paired: responsesHistoryIsPaired,
      parallelCallDisabled: (body: Record<string, unknown>) =>
        body.parallel_tool_calls === false,
    },
  ])(
    '$name only exposes command_run with a paired outer history',
    async (entry) => {
      let requestUrl: string | undefined;
      let requestBody: Record<string, unknown> | undefined;
      vi.stubGlobal(
        'fetch',
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          requestUrl = String(input);
          requestBody = JSON.parse(readRequestBody(init?.body)) as Record<
            string,
            unknown
          >;
          return new Response('contract capture complete', { status: 418 });
        },
      );
      const model = createAiSdkLanguageModel(entry.descriptor);
      if (typeof model === 'string' || !('doGenerate' in model)) {
        throw new Error('Expected a concrete AI SDK language model.');
      }

      await expect(
        model.doGenerate({
          prompt: pairedPrompt(),
          providerOptions: entry.providerOptions,
          tools: [
            {
              type: 'function',
              name: 'command_run',
              description: 'Execute a Command Run.',
              inputSchema: commandRunSchema,
            },
          ],
        }),
      ).rejects.toThrow();

      expect(requestUrl).toBe(`https://provider.example.test/v1${entry.path}`);
      if (requestBody === undefined)
        throw new Error('Provider sent no request.');
      expect(entry.toolNames(requestBody)).toEqual(['command_run']);
      expect(entry.paired(requestBody)).toBe(true);
      expect(entry.parallelCallDisabled(requestBody)).toBe(true);
    },
  );
});

function pairedPrompt() {
  return [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Inspect.' }],
    },
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: 'outer_1',
          toolName: 'command_run',
          input: {
            commands: [{ step: 1, command: 'read', args: ['README.md'] }],
          },
        },
      ],
    },
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'outer_1',
          toolName: 'command_run',
          output: {
            type: 'json' as const,
            value: { status: 'completed', commands: [] },
          },
        },
      ],
    },
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Continue.' }],
    },
  ];
}

function responsesHistoryIsPaired(body: Record<string, unknown>): boolean {
  const input = readArray(body.input).map(readObject);
  return (
    input.some(
      (item) =>
        item.type === 'function_call' &&
        item.call_id === 'outer_1' &&
        item.name === 'command_run',
    ) &&
    input.some(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'outer_1',
    )
  );
}

function chatHistoryIsPaired(body: Record<string, unknown>): boolean {
  const messages = readArray(body.messages).map(readObject);
  const assistant = messages.find((message) => message.role === 'assistant');
  const tool = messages.find((message) => message.role === 'tool');
  return (
    readArray(assistant?.tool_calls).some((callValue) => {
      const call = readObject(callValue);
      return (
        call.id === 'outer_1' &&
        readObject(call.function).name === 'command_run'
      );
    }) && tool?.tool_call_id === 'outer_1'
  );
}

function anthropicHistoryIsPaired(body: Record<string, unknown>): boolean {
  const messages = readArray(body.messages).map(readObject);
  const content = messages.flatMap((message) => readArray(message.content));
  return (
    content.some((partValue) => {
      const part = readObject(partValue);
      return (
        part.type === 'tool_use' &&
        part.id === 'outer_1' &&
        part.name === 'command_run'
      );
    }) &&
    content.some((partValue) => {
      const part = readObject(partValue);
      return part.type === 'tool_result' && part.tool_use_id === 'outer_1';
    })
  );
}

function readRequestBody(body: RequestInit['body']): string {
  if (typeof body !== 'string')
    throw new Error('Provider request body is not JSON text.');
  return body;
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string.');
  return value;
}
