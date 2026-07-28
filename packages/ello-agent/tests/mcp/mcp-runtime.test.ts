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
  McpManager,
  resolveMcpConfigPath,
} from '../../src/features/mcp/index.js';
import type { CodingToolContext } from '../../src/features/tool/index.js';

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

    const tools = await manager.toolsForConfig({
      cwd: root,
      mcp_config_path: configPath,
    });
    const secondTools = await manager.toolsForConfig({
      cwd: root,
      mcp_config_path: configPath,
    });
    expect(secondTools.map((tool) => tool.name).sort()).toEqual(
      tools.map((tool) => tool.name).sort(),
    );
    expect((await readFile(startFile, 'utf8')).trim().split('\n')).toEqual([
      'started',
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'mcp__local__echo',
      'mcp__local__list_resources',
      'mcp__local__mutate',
      'mcp__local__read_resource',
    ]);

    const echo = requiredTool(tools, 'mcp__local__echo');
    expect(echo.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
    await expect(
      invoke(() =>
        echo.validateInput?.({ message: 'hello' }, toolContext(root)),
      ),
    ).resolves.toBeUndefined();
    await expect(
      invoke(() => echo.validateInput?.({}, toolContext(root))),
    ).rejects.toThrow('Invalid arguments for MCP tool');
    await expect(
      invoke(() =>
        echo.capabilities?.({ message: 'hello' }, toolContext(root)),
      ),
    ).resolves.toMatchObject({
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      enabled: true,
    });
    await expect(
      echo.execute({ message: 'hello' }, toolContext(root)),
    ).resolves.toMatchObject({
      kind: 'coding-tool-result',
      output: `echo:hello:${root}`,
      metadata: {
        kind: 'network',
        server: 'local',
        remoteTool: 'echo',
      },
    });

    const mutate = requiredTool(tools, 'mcp__local__mutate');
    await expect(
      invoke(() => mutate.capabilities?.({ value: 'x' }, toolContext(root))),
    ).resolves.toMatchObject({
      concurrencySafe: false,
      readOnly: false,
      destructive: true,
    });

    const listResources = requiredTool(tools, 'mcp__local__list_resources');
    const listed = await listResources.execute({}, toolContext(root));
    expect(listed.output).toContain('memo://guide');

    const readResource = requiredTool(tools, 'mcp__local__read_resource');
    const resource = await readResource.execute(
      { uri: 'memo://guide' },
      toolContext(root),
    );
    expect(resource.output).toContain('MCP integration guide.');

    await manager.close();
    await expect(
      invoke(() =>
        echo.capabilities?.({ message: 'hello' }, toolContext(root)),
      ),
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
      manager.toolsForConfig({
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

function requiredTool(
  tools: Awaited<ReturnType<McpManager['toolsForConfig']>>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing MCP tool '${name}'.`);
  return tool;
}

function toolContext(root: string): CodingToolContext {
  return {
    cwd: root,
    allowedPaths: [root],
    sessionId: 'mcp-session',
    runId: 'mcp-run',
    callId: 'mcp-call',
    agent: {
      runId: 'mcp-run',
      turnIndex: 0,
      toolCallId: 'mcp-call',
      environment: {},
      metadata: {},
      signal: new AbortController().signal,
    },
  };
}

function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(operation);
}
