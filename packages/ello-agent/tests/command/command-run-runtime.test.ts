/**
 * Command Run 深模块的 interface 级行为测试。
 *
 * 测试只穿过 `CommandRunRuntime.start/resume`，不观察 catalog、codec 或 wave
 * scheduler 的内部结构。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cliInput,
  commandInput,
  createCommandRegistrySnapshot,
  createCommandRunRuntime as createRuntimeFromRegistry,
  deferred,
  defineCommand,
  defineCommandModule,
  structuredInput,
  type CommandApprovalDecision,
  type CommandCapabilities,
  type CommandContext,
  type CommandInputContract,
  type CommandInvocation,
  type CommandRunContext,
  type CommandRunEvent,
  type CommandRunExecution,
  type CommandDefinition,
  type MaybePromise,
} from '../../src/features/command/index.js';
import { CodingAgentConfigSchema } from '../../src/features/config/index.js';
import { createProductionCommandRuntime } from '../../src/features/tool/index.js';
import { createTestCommandRun } from '../support/command.js';
import { createTestEnvironmentHandle } from '../support/environment.js';
import { createTestStores } from '../support/stores.js';

function createCommandRunRuntime(options: {
  readonly commands: readonly CommandDefinition[];
  readonly search: {
    readonly resultLimit: number;
    readonly maxResultBytes: number;
  };
}) {
  return createRuntimeFromRegistry(
    createCommandRegistrySnapshot({
      modules: [
        defineCommandModule({ id: 'runtime-test', commands: options.commands }),
      ],
      search: options.search,
    }),
  );
}

function immediateCommand<
  TInput extends Record<string, unknown>,
  TOutput,
>(options: {
  readonly name: string;
  readonly schema: z.ZodType<TInput>;
  readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  readonly readOnly?: boolean;
  readonly effects?:
    | Partial<CommandCapabilities>
    | ((
        input: TInput,
        context: CommandContext,
      ) => MaybePromise<Partial<CommandCapabilities>>);
  readonly validate?: (
    input: TInput,
    context: CommandContext,
  ) => MaybePromise<void>;
  readonly approval?: (
    input: TInput,
    context: CommandContext,
  ) => MaybePromise<CommandApprovalDecision>;
  readonly run: (
    input: TInput,
    context: CommandContext,
  ) => MaybePromise<TOutput>;
}): CommandDefinition {
  const readOnly = options.readOnly === true;
  const invocation = testInvocation(
    options.name,
    options.schema,
    options.inputJsonSchema,
  );
  return defineCommand({
    name: options.name,
    summary: `${options.name} test capability`,
    aliases: [],
    risk: readOnly ? 'readonly' : 'workspace-write',
    exposure: isInlineTestCommand(options.name) ? 'inline' : 'discoverable',
    invocation,
    effects:
      options.effects ??
      (() => ({
        concurrencySafe: readOnly,
        readOnly,
        destructive: !readOnly,
        interruptible: true,
        enabled: true,
        telemetryTag: options.name,
      })),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    execution: { kind: 'immediate', run: options.run },
  });
}

function testInvocation<TInput extends Record<string, unknown>>(
  name: string,
  schema: z.ZodType<TInput>,
  suppliedJsonSchema?: Readonly<Record<string, unknown>>,
): CommandInvocation<TInput> {
  const rawInput: CommandInputContract<TInput> =
    suppliedJsonSchema === undefined
      ? commandInput(schema)
      : { schema, jsonSchema: suppliedJsonSchema };
  if (!isInlineTestCommand(name)) return structuredInput(rawInput);
  const input = describeTestInput(rawInput);
  const jsonSchema = input.jsonSchema as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const fields = new Set(Object.keys(jsonSchema.properties ?? {}));
  const field = (value: string) => value as Extract<keyof TInput, string>;
  const present = (values: readonly string[]) =>
    values.filter((value) => fields.has(value)).map(field);
  if (name === 'read') {
    return cliInput(input, {
      positionals: [{ field: field('filePath'), metavar: 'path' }],
      options: present(['offset', 'limit']),
    });
  }
  if (name === 'write') {
    return cliInput(input, {
      positionals: [{ field: field('filePath'), metavar: 'path' }],
      options: present(['expectedDigest', 'reason']),
      body: field('content'),
    });
  }
  if (name === 'apply_patch') {
    return cliInput(input, {
      options: present(['reason']),
      body: field('patch'),
    });
  }
  if (name === 'bash') {
    return cliInput(input, {
      options: present(['timeoutMs', 'cwd']),
      body: field('command'),
    });
  }
  if (name === 'internal_complete' && fields.has('output')) {
    return cliInput(input, { body: field('output') });
  }
  return cliInput(input);
}

function describeTestInput<TInput>(
  input: CommandInputContract<TInput>,
): CommandInputContract<TInput> {
  const root = input.jsonSchema as {
    readonly properties?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
  };
  const properties = Object.fromEntries(
    Object.entries(root.properties ?? {}).map(([field, property]) => [
      field,
      {
        ...property,
        description:
          typeof property.description === 'string' &&
          property.description.trim() !== ''
            ? property.description
            : `${field} test value`,
      },
    ]),
  );
  return {
    schema: input.schema,
    jsonSchema: { ...input.jsonSchema, properties },
  };
}

function isInlineTestCommand(name: string): boolean {
  return ['read', 'write', 'apply_patch', 'bash', 'internal_complete'].includes(
    name,
  );
}

function coreCommands(
  overrides: readonly CommandDefinition[] = [],
): CommandDefinition[] {
  const calls = new Map(overrides.map((command) => [command.name, command]));
  const fallback = <TInput extends Record<string, unknown>>(
    name: string,
    schema: z.ZodType<TInput>,
    readOnly = false,
  ) =>
    immediateCommand({
      name,
      schema,
      readOnly,
      run: async (input) => ({ name, input }),
    });
  return [
    calls.get('read') ??
      fallback(
        'read',
        z
          .object({
            filePath: z.string(),
            offset: z.number().optional(),
            limit: z.number().optional(),
          })
          .strict(),
        true,
      ),
    calls.get('write') ??
      fallback(
        'write',
        z
          .object({
            filePath: z.string(),
            content: z.string(),
            expectedDigest: z.string().optional(),
            reason: z.string().optional(),
          })
          .strict(),
      ),
    calls.get('apply_patch') ??
      fallback(
        'apply_patch',
        z.object({ patch: z.string(), reason: z.string().optional() }).strict(),
      ),
    calls.get('bash') ??
      fallback(
        'bash',
        z
          .object({
            command: z.string(),
            timeoutMs: z.number().default(120_000),
            cwd: z.string().optional(),
          })
          .strict(),
      ),
    calls.get('grep') ??
      fallback(
        'grep',
        z
          .object({
            pattern: z.string(),
            filePath: z.string(),
            glob: z.string().optional(),
            limit: z.number(),
            offset: z.number(),
            context: z.number(),
          })
          .strict(),
        true,
      ),
    calls.get('glob') ??
      fallback(
        'glob',
        z
          .object({
            pattern: z.string(),
            filePath: z.string(),
            limit: z.number(),
            offset: z.number(),
          })
          .strict(),
        true,
      ),
    ...overrides.filter(
      (tool) =>
        !['read', 'write', 'apply_patch', 'bash', 'grep', 'glob'].includes(
          tool.name,
        ),
    ),
  ];
}

function createContext(
  signal = new AbortController().signal,
): CommandRunContext {
  return {
    runId: 'run-1',
    turnIndex: 0,
    environment: createTestEnvironmentHandle(),
    metadata: {},
    signal,
  };
}

async function consume(execution: CommandRunExecution): Promise<{
  readonly events: readonly CommandRunEvent[];
  readonly transition: Awaited<CommandRunExecution['result']>;
}> {
  const events: CommandRunEvent[] = [];
  for await (const event of execution) events.push(event);
  return { events, transition: await execution.result };
}

describe('CommandRunRuntime', () => {
  it('reports command_invoke frame exclusivity with the exact usage', async () => {
    const runtime = createCommandRunRuntime({
      commands: coreCommands([
        immediateCommand({
          name: 'request_user_input',
          schema: z.object({ question: z.string() }).strict(),
          readOnly: true,
          run: async (input) => input,
        }),
      ]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    const { transition } = await consume(
      runtime.start({
        providerToolCallId: 'outer-call-tool-shape',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'command_invoke',
              args: ['request_user_input'],
              input: {
                name: 'request_user_input',
                arguments: { question: 'Continue?' },
              },
            },
          ],
        },
      }),
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        error: {
          frameIndex: 0,
          command: 'command_invoke',
          message: expect.stringContaining(
            'input is mutually exclusive with args and body',
          ),
          usage:
            'command_invoke with input { name, arguments }; do not use args or body',
        },
      },
    });
  });

  it('contains apply_patch validation failures inside the Command Run', async () => {
    const config = CodingAgentConfigSchema.parse({
      cwd: '/workspace',
      session_dir: '/workspace/.ello/sessions',
      initial_mode: 'ask-before-changes',
      models: {
        test: {
          protocol: 'openai',
          endpoint: 'responses',
          api_model: 'test-model',
          base_url: 'https://api.example.test/v1',
          api_key_env: 'TEST_API_KEY',
          context_window: 128_000,
          max_output_tokens: 16_000,
        },
      },
      primary_model: 'test',
      auxiliary_model: 'test',
    });
    const stores = createTestStores({ databasePath: ':memory:' });
    const production = createProductionCommandRuntime({
      config,
      taskBoards: stores.taskBoards,
      taskBoardScope: { type: 'session', sessionId: 'invalid-patch' },
      mode: () => ({
        mode: 'ask-before-changes',
        previousMode: null,
        source: 'config',
        changedAt: '2026-08-04T00:00:00.000Z',
      }),
    });
    const runtime = createTestCommandRun(production.module.commands);

    try {
      const { events, transition } = await consume(
        runtime.start({
          providerToolCallId: 'outer-invalid-patch',
          context: createContext(),
          input: {
            commands: [
              {
                step: 1,
                command: 'apply_patch',
                body: '--- a/source.ts\n+++ b/source.ts',
              },
            ],
          },
        }),
      );

      expect(transition).toMatchObject({
        type: 'completed',
        result: {
          status: 'failed',
          commands: [
            {
              name: 'apply_patch',
              status: 'failed',
              error: expect.stringContaining(
                "first line must be '*** Begin Patch'",
              ),
            },
          ],
        },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'command.failed',
            record: expect.objectContaining({
              name: 'apply_patch',
              status: 'failed',
            }),
          }),
        ]),
      );
    } finally {
      stores.close();
    }
  });

  it('keeps same-step siblings runnable when preflight validation fails', async () => {
    const calls: string[] = [];
    const invalidWrite = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      validate: () => {
        throw new Error('stale write');
      },
      run: async () => {
        calls.push('write');
      },
    });
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      run: async () => {
        calls.push('read');
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([invalidWrite, read]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    const { transition } = await consume(
      runtime.start({
        providerToolCallId: 'outer-preflight-tail',
        context: createContext(),
        input: {
          commands: [
            { step: 1, command: 'write', args: ['a.ts'], body: 'next' },
            { step: 1, command: 'read', args: ['a.ts'] },
            { step: 2, command: 'read', args: ['later.ts'] },
          ],
        },
      }),
    );

    expect(calls).toEqual(['read']);
    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        commands: [
          { name: 'write', status: 'failed', error: 'stale write' },
          { name: 'read', status: 'completed' },
          {
            name: 'read',
            status: 'blocked',
            error: expect.stringContaining(
              "Blocked by failed step 1 Command 'write'",
            ),
          },
        ],
      },
    });
  });

  it('runs compatible reads concurrently behind strict phase barriers', async () => {
    const order: string[] = [];
    let releaseReads: (() => void) | undefined;
    const readsMayFinish = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let startedReads = 0;
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      run: async (input) => {
        const filePath = Reflect.get(input as object, 'filePath') as string;
        order.push(`start:${filePath}`);
        startedReads += 1;
        if (startedReads === 2) releaseReads?.();
        await readsMayFinish;
        order.push(`end:${filePath}`);
        return filePath;
      },
    });
    const patch = immediateCommand({
      name: 'apply_patch',
      schema: z
        .object({ patch: z.string(), reason: z.string().optional() })
        .strict(),
      run: async () => {
        order.push('patch');
        return 'patched';
      },
    });
    const bash = immediateCommand({
      name: 'bash',
      schema: z
        .object({
          command: z.string(),
          timeoutMs: z.number().default(120_000),
          cwd: z.string().optional(),
        })
        .strict(),
      run: async () => {
        order.push('test');
        return { metadata: { kind: 'shell', exitCode: 0 } };
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([read, patch, bash]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    const { transition } = await consume(
      runtime.start({
        providerToolCallId: 'outer-1',
        context: createContext(),
        input: {
          commands: [
            { step: 1, command: 'read', args: ['a.ts'] },
            { step: 1, command: 'read', args: ['b.ts'] },
            {
              step: 2,
              command: 'apply_patch',
              body: '*** Begin Patch\n*** End Patch',
            },
            { step: 3, command: 'bash', body: 'pnpm test' },
          ],
        },
      }),
    );

    expect(transition.type).toBe('completed');
    expect(order.slice(0, 2)).toEqual(['start:a.ts', 'start:b.ts']);
    expect(order.indexOf('patch')).toBeGreaterThan(order.indexOf('end:b.ts'));
    expect(order.indexOf('test')).toBeGreaterThan(order.indexOf('patch'));
  });

  it('serializes mutations across Handles of one Environment generation', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let starts = 0;
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      run: async () => {
        active += 1;
        starts += 1;
        maxActive = Math.max(maxActive, active);
        if (starts === 1) await firstMayFinish;
        active -= 1;
        return { written: true };
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const firstEnvironment = createTestEnvironmentHandle();
    const secondEnvironment = createTestEnvironmentHandle();
    const first = consume(
      runtime.start({
        providerToolCallId: 'outer-gate-1',
        context: { ...createContext(), environment: firstEnvironment },
        input: {
          commands: [{ step: 1, command: 'write', args: ['a'], body: 'a' }],
        },
      }),
    );
    const second = consume(
      runtime.start({
        providerToolCallId: 'outer-gate-2',
        context: { ...createContext(), environment: secondEnvironment },
        input: {
          commands: [{ step: 1, command: 'write', args: ['b'], body: 'b' }],
        },
      }),
    );

    await expect.poll(() => starts).toBe(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  it('gates validation, approval and execution across Handles while resolving capabilities outside the gate', async () => {
    let active = 0;
    let maxActive = 0;
    let resolvingCapabilities = 0;
    let maxResolvingCapabilities = 0;
    const visit = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    };
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      effects: async () => {
        resolvingCapabilities += 1;
        maxResolvingCapabilities = Math.max(
          maxResolvingCapabilities,
          resolvingCapabilities,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        resolvingCapabilities -= 1;
        return {
          logicalName: 'write',
          usesEnvironment: true,
          concurrencySafe: false,
          readOnly: false,
          destructive: true,
          interruptible: true,
          enabled: true,
          telemetryTag: 'write',
        };
      },
      validate: visit,
      approval: async () => {
        await visit();
        return 'auto' as const;
      },
      run: async () => {
        await visit();
        return { written: true };
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    await Promise.all([
      consume(
        runtime.start({
          providerToolCallId: 'outer-dynamic-gate-1',
          context: createContext(),
          input: {
            commands: [{ step: 1, command: 'write', args: ['a'], body: 'a' }],
          },
        }),
      ),
      consume(
        runtime.start({
          providerToolCallId: 'outer-dynamic-gate-2',
          context: createContext(),
          input: {
            commands: [{ step: 1, command: 'write', args: ['b'], body: 'b' }],
          },
        }),
      ),
    ]);

    expect(maxActive).toBe(1);
    // 能力声明是纯元数据；在 gate 内解析会让每次准备都成为全局写屏障并饿死并行 Agent。
    expect(maxResolvingCapabilities).toBe(2);
  });

  it('keeps a barrier Command that declares no Environment use from blocking other Handles', async () => {
    let releaseBarrier: (() => void) | undefined;
    const barrierMayFinish = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierStarted = false;
    let writes = 0;
    const waitBarrier = immediateCommand({
      name: 'read',
      readOnly: true,
      schema: z.object({ filePath: z.string() }).strict(),
      effects: () => ({
        usesEnvironment: false,
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
        interruptible: true,
        telemetryTag: 'agent.wait',
      }),
      run: async () => {
        barrierStarted = true;
        await barrierMayFinish;
        return { waitStatus: 'completed' };
      },
    });
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      run: async () => {
        writes += 1;
        return { written: true };
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([waitBarrier, write]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const barrier = consume(
      runtime.start({
        providerToolCallId: 'outer-barrier',
        context: createContext(),
        input: {
          commands: [{ step: 1, command: 'read', args: ['job_1'] }],
        },
      }),
    );
    await expect.poll(() => barrierStarted).toBe(true);

    // Subagent 在 Primary 的屏障期间必须继续推进，包括独占的写入。
    const child = await consume(
      runtime.start({
        providerToolCallId: 'inner-write',
        context: createContext(),
        input: {
          commands: [{ step: 1, command: 'write', args: ['a'], body: 'a' }],
        },
      }),
    );

    expect(child.transition.type).toBe('completed');
    expect(writes).toBe(1);
    releaseBarrier?.();
    expect((await barrier).transition.type).toBe('completed');
  });

  it('rejects the whole batch before side effects when any frame fails compilation', async () => {
    let writes = 0;
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      run: async () => {
        writes += 1;
        return 'written';
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const { transition, events } = await consume(
      runtime.start({
        providerToolCallId: 'outer-2',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'write',
              args: ['created.txt'],
              body: 'created',
            },
            {
              step: 2,
              command: 'bash',
              args: ['--unknown', 'x'],
              body: 'true',
            },
          ],
        },
      }),
    );

    expect(writes).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'command_run.failed',
        commandRunId: 'command-run:outer-2',
        error: expect.objectContaining({ frameIndex: 1, command: 'bash' }),
      }),
    ]);
    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        commands: [],
        error: { frameIndex: 1, command: 'bash' },
      },
    });
  });

  it('blocks later normal steps without preparing them and allows a safe diagnostic', async () => {
    const calls: string[] = [];
    const prepared: string[] = [];
    const bash = immediateCommand({
      name: 'bash',
      schema: z
        .object({
          command: z.string(),
          timeoutMs: z.number().default(120_000),
          cwd: z.string().optional(),
        })
        .strict(),
      run: async () => {
        calls.push('bash');
        return { metadata: { kind: 'shell', exitCode: 1 } };
      },
    });
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      validate: (input) => {
        prepared.push(String(Reflect.get(input as object, 'filePath')));
      },
      run: async (input) => {
        calls.push(String(Reflect.get(input as object, 'filePath')));
        return 'observed';
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([bash, read]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const { transition } = await consume(
      runtime.start({
        providerToolCallId: 'outer-3',
        context: createContext(),
        input: {
          commands: [
            { step: 1, command: 'bash', body: 'exit 1' },
            { step: 2, command: 'read', args: ['ordinary.log'] },
            {
              step: 3,
              command: 'read',
              args: ['diagnostic.log'],
              onFailure: 'diagnose',
            },
          ],
        },
      }),
    );

    expect(calls).toEqual(['bash', 'diagnostic.log']);
    expect(prepared).toEqual(['diagnostic.log']);
    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        commands: [
          { name: 'bash', status: 'failed' },
          { name: 'read', status: 'blocked' },
          { name: 'read', status: 'completed' },
        ],
      },
    });
  });

  it('resumes an approved phase without replaying completed commands', async () => {
    const calls: string[] = [];
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      approval: () => ({ action: 'required', reason: 'approve patch' }),
      run: async () => {
        calls.push('write');
        return 'written';
      },
    });
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      run: async () => {
        calls.push('read');
        return 'read';
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write, read]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const first = await consume(
      runtime.start({
        providerToolCallId: 'outer-4',
        context: createContext(),
        input: {
          commands: [
            { step: 1, command: 'read', args: ['source.ts'] },
            { step: 2, command: 'write', args: ['source.ts'], body: 'next' },
          ],
        },
      }),
    );
    expect(first.transition.type).toBe('suspended');
    expect(calls).toEqual(['read']);
    if (first.transition.type !== 'suspended')
      throw new Error('Expected suspension.');
    const commandId = first.transition.interactions[0]?.commandId;
    if (commandId === undefined) throw new Error('Expected approval command.');

    const resumed = await consume(
      runtime.resume({
        checkpoint: first.transition.checkpoint,
        approvals: { [commandId]: true },
        context: createContext(),
      }),
    );
    expect(resumed.transition.type).toBe('completed');
    expect(calls).toEqual(['read', 'write']);
    expect(resumed.transition).toMatchObject({
      type: 'completed',
      result: {
        commands: [
          { name: 'read', status: 'completed' },
          {
            name: 'write',
            status: 'completed',
            approval: { status: 'approved' },
          },
        ],
      },
    });
    expect(resumed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'command.completed',
          record: expect.objectContaining({
            commandId,
            approval: { status: 'approved' },
          }),
        }),
      ]),
    );
  });

  it('persists approval denial and reason on the denied command record', async () => {
    const calls: string[] = [];
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      approval: () => ({ action: 'required', reason: 'approve write' }),
      run: async () => {
        calls.push('write');
        return 'written';
      },
    });
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      run: async () => {
        calls.push('read');
        return 'read';
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write, read]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const first = await consume(
      runtime.start({
        providerToolCallId: 'outer-denied',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'write',
              args: ['source.ts'],
              body: 'next',
              onFailure: 'continue',
            },
            { step: 1, command: 'read', args: ['source.ts'] },
            { step: 2, command: 'read', args: ['after.ts'] },
          ],
        },
      }),
    );
    if (first.transition.type !== 'suspended') {
      throw new Error('Expected approval suspension.');
    }
    const commandId = first.transition.interactions[0]?.commandId;
    if (commandId === undefined) throw new Error('Expected approval command.');

    const resumed = await consume(
      runtime.resume({
        checkpoint: first.transition.checkpoint,
        approvals: {
          [commandId]: {
            approved: false,
            reason: 'Declined by client.',
          },
        },
        context: createContext(),
      }),
    );

    expect(calls).toEqual(['read']);
    expect(resumed.transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'denied',
        commands: [
          {
            commandId,
            status: 'denied',
            approval: {
              status: 'denied',
              reason: 'Declined by client.',
            },
          },
          { name: 'read', status: 'completed' },
          {
            name: 'read',
            status: 'blocked',
            blockedBy: commandId,
            error: expect.stringContaining(
              "Blocked by denied step 1 Command 'write'",
            ),
          },
        ],
      },
    });
    expect(resumed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'command.denied',
          record: expect.objectContaining({
            commandId,
            status: 'denied',
            approval: {
              status: 'denied',
              reason: 'Declined by client.',
            },
          }),
        }),
      ]),
    );
  });

  it('stops later same-step waves when a command is interrupted', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const bash = immediateCommand({
      name: 'bash',
      schema: z
        .object({
          command: z.string(),
          timeoutMs: z.number().default(120_000),
          cwd: z.string().optional(),
        })
        .strict(),
      run: async (_input, context) => {
        calls.push('bash');
        controller.abort(new Error('cancelled'));
        context.signal.throwIfAborted();
      },
    });
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      run: async () => {
        calls.push('tail');
        return 'tail';
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([bash, read]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    const { transition } = await consume(
      runtime.start({
        providerToolCallId: 'outer-interrupt',
        context: createContext(controller.signal),
        input: {
          commands: [
            { step: 1, command: 'bash', body: 'long command' },
            { step: 1, command: 'read', args: ['tail.txt'] },
          ],
        },
      }),
    );

    expect(calls).toEqual(['bash']);
    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'interrupted',
        commands: [
          { name: 'bash', status: 'interrupted' },
          { name: 'read', status: 'blocked' },
        ],
      },
    });
  });

  it('suspends a deferred capability and blocks the generated tail of the batch', async () => {
    const calls: string[] = [];
    const deferredCommand = defineCommand({
      name: 'request_user_input',
      summary: 'Ask the user',
      aliases: [],
      risk: 'external',
      exposure: 'discoverable',
      invocation: structuredInput(
        commandInput(z.object({ question: z.string() }).strict()),
      ),
      execution: deferred(),
    });
    const read = immediateCommand({
      name: 'read',
      schema: z
        .object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
        .strict(),
      readOnly: true,
      run: async () => {
        calls.push('tail');
        return 'tail';
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([deferredCommand, read]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const first = await consume(
      runtime.start({
        providerToolCallId: 'outer-5',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'command_invoke',
              input: {
                name: 'request_user_input',
                arguments: { question: 'Continue?' },
              },
            },
            { step: 2, command: 'read', args: ['stale-tail.ts'] },
          ],
        },
      }),
    );
    expect(first.transition.type).toBe('suspended');
    expect(calls).toEqual([]);
    if (first.transition.type !== 'suspended')
      throw new Error('Expected suspension.');
    expect(first.transition.interactions[0]).toMatchObject({
      commandName: 'request_user_input',
      input: { question: 'Continue?' },
    });
    const commandId = first.transition.interactions[0]?.commandId;
    if (commandId === undefined) throw new Error('Expected deferred command.');

    const resumed = await consume(
      runtime.resume({
        checkpoint: first.transition.checkpoint,
        toolResults: { [commandId]: { answer: 'yes' } },
        context: createContext(),
      }),
    );
    expect(resumed.transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'completed',
        commands: [
          { name: 'request_user_input', status: 'completed' },
          { name: 'read', status: 'blocked' },
        ],
      },
    });
    expect(calls).toEqual([]);
  });

  it('discovers and calls an MCP capability with nested object and array input', async () => {
    const nestedInput = {
      repository: { owner: 'ello', labels: ['runtime', 'mcp'] },
      queries: [
        { terms: ['command', 'run'], filters: { language: 'typescript' } },
      ],
    };
    let received: unknown;
    const inputJsonSchema = {
      type: 'object',
      properties: {
        repository: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['owner', 'labels'],
          additionalProperties: false,
        },
        queries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              terms: { type: 'array', items: { type: 'string' } },
              filters: {
                type: 'object',
                properties: { language: { type: 'string' } },
                required: ['language'],
                additionalProperties: false,
              },
            },
            required: ['terms', 'filters'],
            additionalProperties: false,
          },
        },
      },
      required: ['repository', 'queries'],
      additionalProperties: false,
    };
    const mcp = immediateCommand({
      name: 'mcp__fixture__nested_search',
      schema: z
        .object({
          repository: z
            .object({ owner: z.string(), labels: z.array(z.string()) })
            .strict(),
          queries: z.array(
            z
              .object({
                terms: z.array(z.string()),
                filters: z.object({ language: z.string() }).strict(),
              })
              .strict(),
          ),
        })
        .strict(),
      inputJsonSchema,
      readOnly: true,
      run: async (input) => {
        received = input;
        return { matches: 3 };
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([mcp]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    const discovered = await consume(
      runtime.start({
        providerToolCallId: 'outer-mcp-search',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'command_search',
              args: ['--query', 'nested'],
            },
          ],
        },
      }),
    );
    expect(discovered.transition).toMatchObject({
      type: 'completed',
      result: {
        commands: [
          {
            status: 'completed',
            output: {
              results: [
                {
                  name: 'mcp__fixture__nested_search',
                  inputSchema: inputJsonSchema,
                },
              ],
            },
          },
        ],
      },
    });

    const called = await consume(
      runtime.start({
        providerToolCallId: 'outer-mcp-call',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'command_invoke',
              input: {
                name: 'mcp__fixture__nested_search',
                arguments: nestedInput,
              },
            },
          ],
        },
      }),
    );
    expect(received).toEqual(nestedInput);
    expect(called.transition).toMatchObject({
      type: 'completed',
      result: {
        commands: [
          {
            name: 'mcp__fixture__nested_search',
            status: 'completed',
            output: { matches: 3 },
          },
        ],
      },
    });
  });

  it('routes Memory, Skill, Goal, Task, and Subagent capabilities through the catalog', async () => {
    const names = [
      'memory_read',
      'activate_skill',
      'get_goal',
      'task_create',
      'spawn_agent',
    ] as const;
    const calls: string[] = [];
    const tools = names.map((name) =>
      immediateCommand({
        name,
        schema: z.object({ value: z.string() }).strict(),
        readOnly: true,
        run: async (input) => {
          calls.push(name);
          return {
            capability: name,
            value: Reflect.get(input as object, 'value'),
          };
        },
      }),
    );
    const runtime = createCommandRunRuntime({
      commands: coreCommands(tools),
      search: { resultLimit: 10, maxResultBytes: 24_000 },
    });

    const search = await consume(
      runtime.start({
        providerToolCallId: 'outer-domain-search',
        context: createContext(),
        input: {
          commands: [
            { step: 1, command: 'command_search', args: ['--limit', '10'] },
          ],
        },
      }),
    );
    if (search.transition.type !== 'completed') {
      throw new Error('Expected capability search to complete.');
    }
    const searchOutput = search.transition.result.commands[0]?.output as {
      readonly results: readonly { readonly name: string }[];
    };
    expect(searchOutput.results.map((result) => result.name).sort()).toEqual(
      [...names, 'glob', 'grep'].sort(),
    );

    const called = await consume(
      runtime.start({
        providerToolCallId: 'outer-domain-call',
        context: createContext(),
        input: {
          commands: names.map((name) => ({
            step: 1,
            command: 'command_invoke',
            input: { name, arguments: { value: `${name}-input` } },
          })),
        },
      }),
    );
    expect(calls.sort()).toEqual([...names].sort());
    expect(called.transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'completed',
        commands: names.map((name) => ({
          name,
          status: 'completed',
          output: { capability: name, value: `${name}-input` },
        })),
      },
    });
  });

  it('does not expose write or bash as recursive command_invoke targets', async () => {
    let executions = 0;
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({ filePath: z.string(), content: z.string() })
        .passthrough(),
      run: async () => {
        executions += 1;
      },
    });
    const bash = immediateCommand({
      name: 'bash',
      schema: z.object({ command: z.string() }).passthrough(),
      run: async () => {
        executions += 1;
      },
    });
    const discoverable = immediateCommand({
      name: 'memory_read',
      schema: z.object({}).strict(),
      readOnly: true,
      run: async () => 'memory',
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write, bash, discoverable]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    for (const name of ['write', 'bash']) {
      const attempt = await consume(
        runtime.start({
          providerToolCallId: `outer-plan-bypass-${name}`,
          context: createContext(),
          input: {
            commands: [
              {
                step: 1,
                command: 'command_invoke',
                input: { name, arguments: {} },
              },
            ],
          },
        }),
      );
      expect(attempt.transition).toMatchObject({
        type: 'completed',
        result: {
          status: 'failed',
          commands: [
            {
              name: 'command_invoke',
              status: 'failed',
              error: expect.stringContaining(
                `unknown or recursive discoverable Command '${name}'`,
              ),
            },
          ],
        },
      });
    }
    expect(executions).toBe(0);
  });

  it('runs a written local program through a later bash phase', async () => {
    const scripts = new Map<string, string>();
    const order: string[] = [];
    const write = immediateCommand({
      name: 'write',
      schema: z
        .object({
          filePath: z.string(),
          content: z.string(),
          expectedDigest: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      run: async (input) => {
        const filePath = Reflect.get(input as object, 'filePath') as string;
        const content = Reflect.get(input as object, 'content') as string;
        scripts.set(filePath, content);
        order.push(`write:${filePath}`);
        return { written: filePath };
      },
    });
    const bash = immediateCommand({
      name: 'bash',
      schema: z
        .object({
          command: z.string(),
          timeoutMs: z.number().default(120_000),
          cwd: z.string().optional(),
        })
        .strict(),
      run: async (input) => {
        const command = Reflect.get(input as object, 'command') as string;
        order.push(`bash:${command}`);
        return {
          text: scripts.get('scripts/analyze.mjs')?.includes('JSON.stringify')
            ? '{"count":3}'
            : 'missing script',
          metadata: { kind: 'shell', exitCode: 0 },
        };
      },
    });
    const runtime = createCommandRunRuntime({
      commands: coreCommands([write, bash]),
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const result = await consume(
      runtime.start({
        providerToolCallId: 'outer-ptc',
        context: createContext(),
        input: {
          commands: [
            {
              step: 1,
              command: 'write',
              args: ['scripts/analyze.mjs'],
              body: 'console.log(JSON.stringify({ count: [1, 2, 3].length }));\n',
            },
            {
              step: 2,
              command: 'bash',
              body: 'node scripts/analyze.mjs',
            },
          ],
        },
      }),
    );

    expect(order).toEqual([
      'write:scripts/analyze.mjs',
      'bash:node scripts/analyze.mjs',
    ]);
    expect(result.transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'completed',
        commands: [
          { name: 'write', status: 'completed' },
          {
            name: 'bash',
            status: 'completed',
            output: { text: '{"count":3}' },
          },
        ],
      },
    });
  });
});
