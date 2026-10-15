/**
 * 本文件验证 MCP 配置、stdio 工具调用、资源读取和连接关闭行为。
 *
 * 测试使用真实 MCP 子进程，不用 mock 代替协议握手和传输生命周期。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandRegistrySnapshot,
  createCommandRunRuntime,
  defineCommandModule,
  type CommandContext,
  type CommandDefinition,
  type CommandRunResult,
} from '../../src/features/command/index.js';
import {
  McpManager,
  resolveMcpConfigPath,
} from '../../src/features/mcp/index.js';
import type { CommandResult } from '../../src/features/tool/index.js';
import { createTestEnvironmentHandle } from '../support/environment.js';

const temporaryDirectories: string[] = [];
const managers: McpManager[] = [];
const fixturePath = fileURLToPath(
  new URL('./fixtures/stdio-server.mjs', import.meta.url),
);

afterEach(async () => {
  await Promise.allSettled(
    managers.splice(0).map((manager) => manager.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('MCP 运行时', () => {
  it('连接 stdio 服务器并注册工具与资源', async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, 'mcp.json');
    const startFile = path.join(root, 'mcp-starts.log');
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          local: {
            command: process.execPath,
            args: [fixturePath],
            cwd: '.',
            env: { ELLO_MCP_START_FILE: startFile },
            timeout_ms: 10_000,
          },
        },
      }),
      'utf8',
    );
    const manager = new McpManager();
    managers.push(manager);

    const commands = await manager.commandsForConfig({
      cwd: root,
      mcp_config_path: configPath,
    });
    const secondCommands = await manager.commandsForConfig({
      cwd: root,
      mcp_config_path: configPath,
    });
    expect(secondCommands.map((command) => command.name).sort()).toEqual(
      commands.map((command) => command.name).sort(),
    );
    expect((await readFile(startFile, 'utf8')).trim().split('\n')).toEqual([
      'started',
    ]);
    expect(commands.map((command) => command.name).sort()).toEqual([
      'mcp__local__echo',
      'mcp__local__list_resources',
      'mcp__local__mutate',
      'mcp__local__read_resource',
    ]);

    const echo = requiredCommand(commands, 'mcp__local__echo');
    expect(echo.invocation.input.jsonSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
    await expect(
      commandEffects(echo, { message: 'hello' }, commandContext(root)),
    ).resolves.toMatchObject({
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      enabled: true,
    });
    const invalid = await invokeCommand(commands, 'mcp__local__echo', {}, root);
    expect(invalid).toMatchObject({
      status: 'failed',
      commands: [
        {
          name: 'mcp__local__echo',
          status: 'failed',
          error: expect.stringContaining('Invalid arguments for MCP tool'),
        },
      ],
    });
    const echoed = commandOutput(
      await invokeCommand(
        commands,
        'mcp__local__echo',
        { message: 'hello' },
        root,
      ),
    );
    expect(echoed).toMatchObject({
      kind: 'command-result',
      output: `echo:hello:${root}`,
      metadata: {
        kind: 'network',
        server: 'local',
        remoteTool: 'echo',
      },
    });

    const mutate = requiredCommand(commands, 'mcp__local__mutate');
    await expect(
      commandEffects(mutate, { value: 'x' }, commandContext(root)),
    ).resolves.toMatchObject({
      concurrencySafe: false,
      readOnly: false,
      destructive: true,
    });

    const listed = commandOutput(
      await invokeCommand(commands, 'mcp__local__list_resources', {}, root),
    );
    expect(listed.output).toContain('memo://guide');

    const resource = commandOutput(
      await invokeCommand(
        commands,
        'mcp__local__read_resource',
        { uri: 'memo://guide' },
        root,
      ),
    );
    expect(resource.output).toContain('MCP integration guide.');

    await manager.close();
    await expect(
      commandEffects(echo, { message: 'hello' }, commandContext(root)),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('按项目目录解析相对配置路径，且不启动禁用服务器', async () => {
    const root = await temporaryDirectory();
    const relativePath = path.join('.ello', 'custom-mcp.json');
    const configPath = path.join(root, relativePath);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          disabled: {
            enabled: false,
            command: '/path/that/does/not/exist',
          },
        },
      }),
      'utf8',
    );
    expect(
      resolveMcpConfigPath({ cwd: root, mcp_config_path: relativePath }),
    ).toBe(configPath);
    const manager = new McpManager();
    managers.push(manager);
    await expect(
      manager.commandsForConfig({
        cwd: root,
        mcp_config_path: relativePath,
      }),
    ).resolves.toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ello-mcp-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requiredCommand(
  commands: Awaited<ReturnType<McpManager['commandsForConfig']>>,
  name: string,
): CommandDefinition {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) throw new Error(`Missing MCP Command '${name}'.`);
  return command;
}

function commandContext(root: string): CommandContext {
  return {
    runId: 'mcp-run',
    turnIndex: 0,
    commandId: 'mcp-command',
    environment: createTestEnvironmentHandle(),
    metadata: { cwd: root, sessionId: 'mcp-session' },
    signal: new AbortController().signal,
  };
}

async function commandEffects(
  command: CommandDefinition,
  input: unknown,
  context: CommandContext,
) {
  return typeof command.effects === 'function'
    ? command.effects(input, context)
    : command.effects;
}

async function invokeCommand(
  commands: readonly CommandDefinition[],
  name: string,
  argumentsValue: Record<string, unknown>,
  root: string,
): Promise<CommandRunResult> {
  const runtime = createCommandRunRuntime(
    createCommandRegistrySnapshot({
      modules: [defineCommandModule({ id: 'mcp-test', commands })],
      search: { resultLimit: 10, maxResultBytes: 64_000 },
    }),
  );
  const execution = runtime.start({
    providerToolCallId: `mcp-${name}`,
    input: {
      commands: [
        {
          step: 1,
          command: 'command_invoke',
          input: { name, arguments: argumentsValue },
        },
      ],
    },
    context: {
      runId: 'mcp-run',
      turnIndex: 0,
      environment: createTestEnvironmentHandle(),
      metadata: { cwd: root, sessionId: 'mcp-session' },
      signal: new AbortController().signal,
    },
  });
  for await (const _event of execution) {
    // Drain the execution so the result settles.
  }
  const transition = await execution.result;
  if (transition.type !== 'completed') {
    throw new Error(`MCP Command '${name}' unexpectedly suspended.`);
  }
  return transition.result;
}

function commandOutput(result: CommandRunResult): CommandResult {
  const output = result.commands[0]?.output;
  if (!isCommandResult(output)) {
    throw new Error('MCP Command did not return a CommandResult.');
  }
  return output;
}

function isCommandResult(value: unknown): value is CommandResult {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = Reflect.get(value, 'metadata');
  return (
    Reflect.get(value, 'kind') === 'command-result' &&
    typeof Reflect.get(value, 'title') === 'string' &&
    typeof Reflect.get(value, 'output') === 'string' &&
    typeof metadata === 'object' &&
    metadata !== null
  );
}
