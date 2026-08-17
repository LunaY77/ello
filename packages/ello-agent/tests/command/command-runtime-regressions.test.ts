/**
 * Command invocation、Catalog 枚举与失败策略的独立回归测试。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  COMMAND_OBSERVATION_MAX_BYTES,
  COMMAND_RUN_RESULT_MAX_BYTES,
  cliInput,
  commandInput,
  createCommandRegistrySnapshot,
  createCommandRunRuntime,
  defineCommand,
  defineCommandModule,
  projectCommandRunResult,
  structuredInput,
  type CommandDefinition,
  type CommandRunEvent,
  type CommandRunExecution,
} from '../../src/features/command/index.js';
import { createTestEnvironmentHandle } from '../support/environment.js';

interface CoreHooks {
  readonly read?: () => unknown;
  readonly bash?: () => unknown;
}

function runtimeFor(
  hooks: CoreHooks = {},
  additional: readonly CommandDefinition[] = [],
) {
  const readInput = z
    .object({
      filePath: z.string().describe('File path'),
      offset: z.number().optional().describe('Starting offset'),
      limit: z.number().optional().describe('Maximum lines'),
    })
    .strict();
  const bashInput = z
    .object({
      command: z.string().describe('Shell program'),
      timeoutMs: z.number().default(120_000).describe('Timeout'),
      cwd: z.string().optional().describe('Working directory'),
    })
    .strict();
  const read = defineCommand({
    name: 'read',
    summary: 'Read a file.',
    aliases: [],
    risk: 'readonly',
    invocation: cliInput(commandInput(readInput), {
      positionals: [{ field: 'filePath', metavar: 'path' }],
      options: ['offset', 'limit'],
    }),
    effects: {
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      interruptible: true,
      telemetryTag: 'test.read',
    },
    execution: { kind: 'immediate', run: async () => hooks.read?.() },
  });
  const bash = defineCommand({
    name: 'bash',
    summary: 'Run a shell program.',
    aliases: [],
    risk: 'external',
    invocation: cliInput(commandInput(bashInput), {
      options: ['timeoutMs', 'cwd'],
      body: 'command',
    }),
    effects: {
      concurrencySafe: false,
      readOnly: false,
      destructive: true,
      interruptible: true,
      telemetryTag: 'test.bash',
    },
    execution: {
      kind: 'immediate',
      run: async () =>
        hooks.bash?.() ?? { metadata: { kind: 'shell', exitCode: 0 } },
    },
  });
  return createCommandRunRuntime(
    createCommandRegistrySnapshot({
      modules: [
        defineCommandModule({
          id: 'command-regressions',
          commands: [read, bash, ...additional],
        }),
      ],
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    }),
  );
}

function discoverableCommand(name: string): CommandDefinition {
  return defineCommand({
    name,
    summary: `${name} capability`,
    aliases: [],
    risk: 'readonly',
    exposure: 'discoverable',
    invocation: structuredInput(commandInput(z.object({}).strict())),
    execution: { kind: 'immediate', run: async () => undefined },
  });
}

async function execute(
  runtime: ReturnType<typeof runtimeFor>,
  providerToolCallId: string,
  commands: readonly Record<string, unknown>[],
) {
  return consume(
    runtime.start({
      providerToolCallId,
      context: {
        runId: 'run-regressions',
        turnIndex: 0,
        environment: createTestEnvironmentHandle(),
        metadata: {},
        signal: new AbortController().signal,
      },
      input: { commands },
    }),
  );
}

async function consume(execution: CommandRunExecution) {
  const events: CommandRunEvent[] = [];
  for await (const event of execution) events.push(event);
  return { events, transition: await execution.result };
}

describe('Command runtime regressions', () => {
  it('rejects repeated scalar options with the exact usage', async () => {
    const { transition } = await execute(
      runtimeFor(),
      'outer-duplicate-option',
      [
        {
          step: 1,
          command: 'read',
          args: ['file.ts', '--offset', '1', '--offset', '2'],
        },
      ],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        error: {
          frameIndex: 0,
          command: 'read',
          message:
            "option '--offset' cannot be repeated for 'read'; usage: read <path> [--offset <number>] [--limit <number>]",
        },
      },
    });
  });

  it('reports the extra positional value, Command name, and usage', async () => {
    const { transition } = await execute(
      runtimeFor(),
      'outer-extra-positional',
      [{ step: 1, command: 'bash', args: ['true'], body: 'pwd' }],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        error: {
          frameIndex: 0,
          command: 'bash',
          message:
            "unexpected positional argument 'true' for 'bash'; usage: bash [--timeout-ms <number>] [--cwd <string>] with body; options shown as --name in Usage must be separate flag/value entries in args",
        },
      },
    });
  });

  it('explains that command_search options require named flag/value args', async () => {
    const { transition } = await execute(
      runtimeFor({}, [discoverableCommand('spawn_agent')]),
      'outer-search-positionals',
      [
        {
          step: 1,
          command: 'command_search',
          args: ['', '6', '0'],
        },
      ],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: { status: 'failed', error: { frameIndex: 0 } },
    });
    if (transition.type !== 'completed') {
      throw new Error('Expected a completed compile failure.');
    }
    expect(transition.result.error?.message).toContain(
      'options shown as --name in Usage must be separate flag/value entries in args',
    );
  });

  it('explains the Frame field whitelist for command-specific keys', async () => {
    const { transition } = await execute(
      runtimeFor(),
      'outer-unknown-frame-key',
      [
        {
          step: 1,
          command: 'bash',
          body: 'pwd',
          'timeout-ms': 30_000,
        },
      ],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: { status: 'failed', error: { frameIndex: 0 } },
    });
    if (transition.type !== 'completed') {
      throw new Error('Expected a completed compile failure.');
    }
    expect(transition.result.error?.message).toContain(
      'Command Frame keys are step, command, args, body, input, and onFailure.',
    );
    expect(transition.result.error?.message).toContain(
      'Put CLI options such as --timeout-ms and their values in args.',
    );
  });

  it('accepts repeated array options and preserves their order', async () => {
    const input = z
      .object({ tag: z.array(z.string()).describe('Tag value to collect.') })
      .strict();
    let received: z.infer<typeof input> | undefined;
    const collectTags = defineCommand({
      name: 'collect_tags',
      summary: 'Collect repeated tag values.',
      aliases: [],
      risk: 'readonly',
      invocation: cliInput(commandInput(input), { options: ['tag'] }),
      execution: {
        kind: 'immediate',
        run: async (value) => {
          received = value;
          return value;
        },
      },
    });

    const { transition } = await execute(
      runtimeFor({}, [collectTags]),
      'outer-repeatable-option',
      [
        {
          step: 1,
          command: 'collect_tags',
          args: ['--tag', 'first', '--tag', 'second'],
        },
      ],
    );

    expect(received).toEqual({ tag: ['first', 'second'] });
    expect(transition).toMatchObject({
      type: 'completed',
      result: { status: 'completed' },
    });
  });

  it('rejects exponent notation for CLI number options', async () => {
    const { transition } = await execute(
      runtimeFor(),
      'outer-exponent-option',
      [
        {
          step: 1,
          command: 'read',
          args: ['file.ts', '--offset', '1e3'],
        },
      ],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        error: {
          frameIndex: 0,
          command: 'read',
          message: "'offset' for 'read' must be a number",
        },
      },
    });
  });

  it('records a continue failure and still executes later frames', async () => {
    const calls: string[] = [];
    const runtime = runtimeFor({
      bash: () => {
        calls.push('bash');
        return { metadata: { kind: 'shell', exitCode: 1 } };
      },
      read: () => {
        calls.push('read');
        return 'observed';
      },
    });

    const { transition } = await execute(runtime, 'outer-continue', [
      {
        step: 1,
        command: 'bash',
        body: 'exit 1',
        onFailure: 'continue',
      },
      { step: 2, command: 'read', args: ['result.log'] },
    ]);

    expect(calls).toEqual(['bash', 'read']);
    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        commands: [
          { name: 'bash', status: 'failed' },
          { name: 'read', status: 'completed' },
        ],
      },
    });
  });

  it('finishes later waves in the same step before blocking a later step', async () => {
    const calls: string[] = [];
    const runtime = runtimeFor({
      bash: () => {
        calls.push('bash');
        return { metadata: { kind: 'shell', exitCode: 1 } };
      },
      read: () => {
        calls.push('read');
        return 'observed';
      },
    });

    const { transition } = await execute(runtime, 'outer-step-barrier', [
      { step: 1, command: 'bash', body: 'exit 1' },
      { step: 1, command: 'read', args: ['same-step.log'] },
      { step: 2, command: 'read', args: ['later-step.log'] },
    ]);

    expect(calls).toEqual(['bash', 'read']);
    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'failed',
        commands: [
          { name: 'bash', status: 'failed' },
          { name: 'read', status: 'completed' },
          { name: 'read', status: 'blocked' },
        ],
      },
    });
  });

  it('lists every discoverable Command for an empty search query', async () => {
    const runtime = runtimeFor({}, [
      discoverableCommand('first_discoverable'),
      discoverableCommand('second_discoverable'),
    ]);

    const { transition } = await execute(runtime, 'outer-empty-search', [
      {
        step: 1,
        command: 'command_search',
        args: ['--query', ''],
      },
    ]);

    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        status: 'completed',
        commands: [
          {
            status: 'completed',
            output: {
              results: [
                { name: 'first_discoverable' },
                { name: 'second_discoverable' },
              ],
              totalAvailableCommands: 2,
              truncated: false,
            },
          },
        ],
      },
    });
  });

  it('projects a large Command result into a bounded model observation', async () => {
    const { transition } = await execute(
      runtimeFor({
        read: () => ({
          kind: 'command-result',
          title: 'read large.log',
          output: 'x'.repeat(256 * 1024),
          metadata: {
            commandId: 'internal-command-id',
            receivedAt: '2026-08-08T00:00:00.000Z',
            truncated: true,
            outputPath: '/workspace/.ello/artifacts/large.log.txt',
          },
        }),
      }),
      'outer-large-observation',
      [{ step: 1, command: 'read', args: ['large.log'] }],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: { status: 'completed' },
    });
    if (transition.type !== 'completed') {
      throw new Error('Expected completed Command Run.');
    }
    const observation = projectCommandRunResult(transition.result);
    expect(transition.observation).toEqual(observation);

    expect(
      Buffer.byteLength(JSON.stringify(observation), 'utf8'),
    ).toBeLessThanOrEqual(COMMAND_RUN_RESULT_MAX_BYTES);
    expect(
      Buffer.byteLength(JSON.stringify(observation.commands[0]), 'utf8'),
    ).toBeLessThanOrEqual(COMMAND_OBSERVATION_MAX_BYTES);
    expect(observation.commands[0]).not.toHaveProperty('input');
    expect(observation.commands[0]).not.toHaveProperty('inputDigest');
    expect(observation.commands[0]).not.toHaveProperty('startedAt');
    expect(observation.commands[0]).not.toHaveProperty('completedAt');
    expect(observation.commands[0]).not.toHaveProperty('metadata');
    expect(observation.commands[0]?.output).toMatchObject({
      truncated: true,
      artifact: { path: '/workspace/.ello/artifacts/large.log.txt' },
    });
    expect(observation.commands[0]?.output).not.toHaveProperty('metadata');
  });

  it('removes display metadata from a small native Command result', async () => {
    const { transition } = await execute(
      runtimeFor({
        read: () => ({
          kind: 'command-result',
          title: 'read small.log',
          output: 'useful observation',
          metadata: {
            kind: 'read',
            durationMs: 5,
            physicalName: 'read',
          },
          attachments: [
            {
              type: 'image',
              mime: 'image/png',
              name: 'preview.png',
              bytes: 1_024,
              content: 'base64-payload-must-not-enter-context',
            },
          ],
        }),
      }),
      'outer-small-observation',
      [{ step: 1, command: 'read', args: ['small.log'] }],
    );

    expect(transition).toMatchObject({
      type: 'completed',
      result: {
        commands: [
          {
            output: {
              output: 'useful observation',
              attachments: [
                {
                  type: 'image',
                  mime: 'image/png',
                  name: 'preview.png',
                  bytes: 1_024,
                },
              ],
            },
          },
        ],
      },
    });
    if (transition.type !== 'completed') {
      throw new Error('Expected completed Command Run.');
    }
    expect(transition.result.commands[0]?.output).toMatchObject({
      kind: 'command-result',
      title: 'read small.log',
      metadata: { kind: 'read', durationMs: 5 },
    });
    expect(transition.observation.commands[0]?.output).toMatchObject({
      output: 'useful observation',
      attachments: [
        { type: 'image', mime: 'image/png', name: 'preview.png', bytes: 1_024 },
      ],
    });
    const observation = transition.observation;
    expect(observation.commands[0]?.output).not.toHaveProperty('metadata');
    expect(observation.commands[0]?.output).not.toHaveProperty('title');
    expect(JSON.stringify(observation.commands[0]?.output)).not.toContain(
      'base64-payload',
    );
  });

  it('keeps every failed receipt when a full batch exceeds the result budget', async () => {
    const failLong = defineCommand({
      name: 'fail_long',
      summary: 'Fail with a large diagnostic.',
      aliases: [],
      risk: 'readonly',
      invocation: structuredInput(commandInput(z.object({}).strict())),
      effects: {
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
        interruptible: true,
        telemetryTag: 'test.fail_long',
      },
      execution: {
        kind: 'immediate',
        run: async () => {
          throw new Error(`diagnostic:${'x'.repeat(24 * 1024)}`);
        },
      },
    });
    const commands = Array.from({ length: 32 }, (_, index) => ({
      step: index + 1,
      command: 'fail_long',
      input: {},
      onFailure: 'continue' as const,
    }));

    const { transition } = await execute(
      runtimeFor({}, [failLong]),
      'outer-many-large-failures',
      commands,
    );

    expect(transition.type).toBe('completed');
    if (transition.type !== 'completed') {
      throw new Error('Expected completed Command Run.');
    }
    const observation = projectCommandRunResult(transition.result);

    expect(
      Buffer.byteLength(JSON.stringify(observation), 'utf8'),
    ).toBeLessThanOrEqual(COMMAND_RUN_RESULT_MAX_BYTES);
    expect(observation.commands).toHaveLength(32);
    expect(observation.commands).toEqual(
      expect.arrayContaining(
        commands.map((_, index) =>
          expect.objectContaining({
            index,
            name: 'fail_long',
            status: 'failed',
            error: expect.stringContaining('diagnostic:'),
          }),
        ),
      ),
    );
  });
});
