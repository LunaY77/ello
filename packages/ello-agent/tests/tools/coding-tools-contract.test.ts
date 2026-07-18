import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineTool,
  type AgentFileSystem,
  type AgentToolContext,
} from '../../src/agent/engine/index.js';
import { createPlanTools } from '../../src/agent/plans/tools.js';
import {
  parseApplyPatch,
  prepareApplyPatch,
} from '../../src/agent/tools/apply-patch.js';
import { projectToolEvent } from '../../src/agent/tools/event-projection.js';
import {
  createCallTool,
  createMetaToolRuntime,
  createToolSearchTool,
} from '../../src/agent/tools/meta-tools.js';
import type { CodingToolContext } from '../../src/agent/tools/runtime/coding-tool.js';
import { createToolSearchIndex } from '../../src/agent/tools/search-index.js';
import { createSearchTools } from '../../src/agent/tools/search.js';
import type { CodingAgentConfig } from '../../src/config/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('Apply Patch 契约', () => {
  it('解析新增、删除、更新和移动操作', () => {
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: new.txt
+new
*** Delete File: old.txt
*** Update File: src/a.txt
*** Move to: src/b.txt
@@ heading
-old
+updated
*** End Patch`);

    expect(patch.operations).toEqual([
      { kind: 'add', path: 'new.txt', content: 'new\n' },
      { kind: 'delete', path: 'old.txt' },
      {
        kind: 'update',
        path: 'src/a.txt',
        movePath: 'src/b.txt',
        chunks: [
          {
            changeContext: 'heading',
            oldLines: ['old'],
            newLines: ['updated'],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  it('拒绝传统 unified diff、空操作和空路径并返回可操作错误', () => {
    expect(() =>
      parseApplyPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new'),
    ).toThrow("first line must be '*** Begin Patch'");
    expect(() => parseApplyPatch('*** Begin Patch\n*** End Patch')).toThrow(
      'contains no file operations',
    );
    expect(() =>
      parseApplyPatch('*** Begin Patch\n*** Delete File:   \n*** End Patch'),
    ).toThrow("expected '*** Add File:'");
  });

  it('接受带空白的标记、EOF 标记和末尾换行', () => {
    const patch = parseApplyPatch(` *** Begin Patch
 *** Update File: a.txt
 @@
-old
+new
 *** End of File

 *** End Patch
`);

    expect(patch.operations[0]).toMatchObject({
      kind: 'update',
      path: 'a.txt',
      chunks: [{ isEndOfFile: true }],
    });
  });

  it('完整预览后一次应用多文件新增、删除、更新与移动', async () => {
    const root = await temporaryDirectory('ello-apply-contract-');
    await writeFile(path.join(root, 'delete.txt'), 'remove me\n');
    await writeFile(
      path.join(root, 'source.txt'),
      'heading\nold value   \ntail\n',
    );
    const fileSystem = testFileSystem(root);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: source.txt
*** Move to: moved/result.txt
@@ heading
-old value
+new value
*** End Patch`);

    const prepared = await prepareApplyPatch(fileSystem, patch);
    expect(prepared.fileChanges.map((change) => change.kind)).toEqual([
      'added',
      'deleted',
      'modified',
    ]);
    expect(prepared.fileChanges[2]).toMatchObject({
      path: 'source.txt',
      movePath: 'moved/result.txt',
    });

    await prepared.apply();
    await expect(
      readFile(path.join(root, 'delete.txt'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, 'source.txt'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, 'nested/new.txt'), 'utf8'),
    ).resolves.toBe('created\n');
    await expect(
      readFile(path.join(root, 'moved/result.txt'), 'utf8'),
    ).resolves.toBe('heading\nnew value\ntail\n');
  });

  it('任一预览失败时不写入其他已解析文件', async () => {
    const root = await temporaryDirectory('ello-apply-failure-');
    await writeFile(path.join(root, 'keep.txt'), 'original\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: created.txt
+created
*** Update File: keep.txt
@@
-missing
+replacement
*** End Patch`);

    await expect(
      prepareApplyPatch(testFileSystem(root), patch),
    ).rejects.toThrow('Failed to find expected lines');
    await expect(readFile(path.join(root, 'keep.txt'), 'utf8')).resolves.toBe(
      'original\n',
    );
    await expect(
      readFile(path.join(root, 'created.txt'), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('搜索工具契约', () => {
  it('grep 以 Unicode 正则匹配、限制结果数并将无匹配视为成功', async () => {
    const root = await temporaryDirectory('ello-search-contract-');
    await writeFile(
      path.join(root, 'a.txt'),
      ['abc-123', 'abc-456', 'abc-xyz'].join('\n'),
      'utf8',
    );
    const grep = searchTool('grep');

    const limited = await grep.execute(
      { pattern: 'abc-\\d+', path: '.', limit: 1 },
      searchContext(root),
    );
    expect(limited.output).toBe('a.txt:1:abc-123');
    expect(limited.metadata.matchCount).toBe(1);

    const empty = await grep.execute(
      { pattern: 'missing', path: '.', limit: 10 },
      searchContext(root),
    );
    expect(empty.output).toBe('');
    expect(empty.metadata.matchCount).toBe(0);
  });

  it('grep 拒绝非法正则并跳过二进制文件和忽略目录', async () => {
    const root = await temporaryDirectory('ello-search-boundary-');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'binary.bin'), 'hit\u0000binary', 'utf8');
    await writeFile(
      path.join(root, 'node_modules', 'ignored.txt'),
      'hit',
      'utf8',
    );
    await writeFile(path.join(root, 'visible.txt'), 'hit', 'utf8');
    const grep = searchTool('grep');

    await expect(
      grep.execute({ pattern: '[', path: '.', limit: 10 }, searchContext(root)),
    ).rejects.toThrow('Invalid grep regular expression');
    const result = await grep.execute(
      { pattern: 'hit', path: '.', limit: 10 },
      searchContext(root),
    );
    expect(result.output).toBe('visible.txt:1:hit');
  });

  it('glob 稳定排序、限制数量并支持双星递归', async () => {
    const root = await temporaryDirectory('ello-glob-contract-');
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'z.ts'), '', 'utf8');
    await writeFile(path.join(root, 'src', 'a.ts'), '', 'utf8');
    await writeFile(path.join(root, 'src', 'nested', 'b.ts'), '', 'utf8');
    const glob = searchTool('glob');

    const result = await glob.execute(
      { pattern: '**/*.ts', path: '.', limit: 2 },
      searchContext(root),
    );
    expect(result.output.split('\n')).toEqual(['src/a.ts', 'src/nested/b.ts']);
    expect(result.metadata.matchCount).toBe(2);
  });
});

describe('Meta Tool 路由契约', () => {
  const tools = [
    targetTool('read', 'Read a file or directory.', 'cat file'),
    targetTool('grep', 'Search file contents with a regex.', 'search text'),
    targetTool('write', 'Write a complete file.', 'create file'),
  ];
  const config = {
    routing_enabled: true,
    search: { result_limit: 6, max_result_bytes: 24_000 },
  };

  it('路由关闭时直接暴露目标，开启时模型只看到两个 meta tools', () => {
    const direct = createMetaToolRuntime(tools, [], {
      ...config,
      routing_enabled: false,
    });
    expect(direct.usesToolRouting).toBe(false);
    expect(direct.modelTools.map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'write',
    ]);

    const routed = createMetaToolRuntime(tools, [], config);
    expect(routed.usesToolRouting).toBe(true);
    expect(routed.executionTools.map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'write',
      'tool_search',
      'call_tool',
    ]);
    expect(routed.modelTools.map((tool) => tool.name)).toEqual([
      'tool_search',
      'call_tool',
    ]);
  });

  it('库存分页不泄露 schema，精确搜索可返回当前模式的 Plan 工具', async () => {
    const planTools = createPlanTools({
      write: async () => 'written',
      requestExit: async () => 'requested',
    });
    const runtime = createMetaToolRuntime([...tools, ...planTools], [], config);
    const search = runtime.modelTools.find(
      (tool) => tool.name === 'tool_search',
    );
    if (search === undefined || search.execution !== 'immediate') {
      throw new Error('tool_search missing');
    }

    const inventory = (await search.execute(
      { limit: 2 },
      agentToolContext,
    )) as {
      readonly results: readonly Record<string, unknown>[];
      readonly truncated: boolean;
      readonly nextOffset?: number;
    };
    expect(inventory.truncated).toBe(true);
    expect(inventory.nextOffset).toBe(2);
    expect(
      inventory.results.every((result) => !('inputSchema' in result)),
    ).toBe(true);

    const planSearch = (await search.execute(
      { query: 'plan', limit: 6 },
      agentToolContext,
    )) as { readonly results: readonly { readonly name: string }[] };
    expect(planSearch.results.map((result) => result.name)).toEqual(
      expect.arrayContaining(['write_plan', 'request_plan_exit']),
    );
  });

  it('搜索支持 exact、prefix、fuzzy、多词且结果排序稳定', () => {
    const index = createToolSearchIndex(tools);

    expect(index.search('read', 8)[0]?.name).toBe('read');
    expect(index.search('rea', 8)[0]?.name).toBe('read');
    expect(index.search('reed', 8)[0]?.name).toBe('read');
    expect(index.search('search regex', 8)[0]?.name).toBe('grep');
    expect(index.search('unrelated-capability', 8)).toEqual([]);
    expect(index.search('file', 8)).toEqual(index.search('file', 8));
  });

  it('搜索拒绝空查询、非法 limit、非法 offset 和超大结果', async () => {
    const index = createToolSearchIndex(tools);
    expect(() => index.search(' ', 2)).toThrow('searchable text');
    expect(() => index.search('read', 9)).toThrow('1 to 8');
    expect(() => index.list(1, -1)).toThrow('non-negative integer');

    const search = createToolSearchTool({
      index,
      resultLimit: 6,
      maxResultBytes: 10,
    });
    expect(() =>
      search.execute({ query: 'read', limit: 1 }, agentToolContext),
    ).toThrow('exceeding');
  });

  it('call_tool 复用目标 schema 与审批策略并原样保留输出', async () => {
    const output = { value: 42 };
    const execute = vi.fn(() => output);
    const approval = vi.fn(() => ({
      action: 'required' as const,
      metadata: {
        permission: 'edit',
        patterns: ['a.txt'],
        always: ['a.txt'],
      },
    }));
    const write = defineTool({
      name: 'write',
      description: 'Write a file.',
      discovery: { aliases: ['save file'], risk: 'workspace-write' },
      input: z.object({ path: z.string() }).strict(),
      approval,
      execute,
    });
    const proxy = createCallTool([write]);
    const input = { name: 'write', arguments: { path: 'a.txt' } };

    await expect(
      proxy.approval?.(input, agentToolContext),
    ).resolves.toMatchObject({
      action: 'required',
      metadata: { proxiedTool: 'write' },
    });
    await expect(proxy.execute(input, agentToolContext)).resolves.toBe(output);
    expect(approval).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('call_tool 拒绝未知、递归、重复和 schema 非法的目标调用', async () => {
    const proxy = createCallTool([
      targetTool('read', 'Read a file.', 'cat file'),
    ]);
    await expect(
      proxy.execute({ name: 'missing', arguments: {} }, agentToolContext),
    ).rejects.toThrow('Unknown or disabled');
    await expect(
      proxy.execute({ name: 'call_tool', arguments: {} }, agentToolContext),
    ).rejects.toThrow('recursively');
    await expect(
      proxy.execute({ name: 'read', arguments: {} }, agentToolContext),
    ).rejects.toThrow("Invalid arguments for tool 'read': path");
    expect(() => createCallTool([tools[0]!, tools[0]!])).toThrow(
      'Duplicate call_tool target',
    );
  });

  it('事件投影向观察者呈现真实目标而非 wrapper', () => {
    expect(
      projectToolEvent({
        type: 'tool.started',
        runId: 'run-1',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        turnIndex: 0,
        toolCallId: 'call-1',
        name: 'call_tool',
        input: { name: 'read', arguments: { path: 'a.txt' } },
      }),
    ).toMatchObject({ name: 'read', input: { path: 'a.txt' } });
  });
});

const agentToolContext: AgentToolContext = {
  runId: 'run-1',
  turnIndex: 0,
  toolCallId: 'call-1',
  environment: {},
  metadata: {},
  signal: new AbortController().signal,
};

function targetTool(name: string, description: string, alias: string) {
  return defineTool({
    name,
    description,
    discovery: { aliases: [alias], risk: 'readonly' },
    input: z
      .object({ path: z.string().describe('Workspace file path') })
      .strict(),
    execute: ({ path: targetPath }) => ({ name, path: targetPath }),
  });
}

function searchTool(name: 'grep' | 'glob') {
  const tool = createSearchTools({} as CodingAgentConfig, () => 'auto').find(
    (candidate) => candidate.name === name,
  );
  if (tool === undefined) {
    throw new Error(`${name} tool missing`);
  }
  return tool;
}

function searchContext(root: string): CodingToolContext {
  const fileSystem = testFileSystem(root);
  return {
    cwd: root,
    allowedPaths: [root],
    sessionId: 'session',
    runId: 'run',
    callId: 'call',
    agent: {
      runId: 'run',
      turnIndex: 0,
      toolCallId: 'call',
      environment: { fileSystem },
      metadata: {},
      signal: new AbortController().signal,
    },
  };
}

function testFileSystem(root: string): AgentFileSystem & {
  resolvePath(targetPath: string): string;
  stat(targetPath: string): ReturnType<typeof stat>;
} {
  const resolvePath = (targetPath: string): string =>
    path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(root, targetPath);
  return {
    resolvePath,
    readText: (targetPath) => readFile(resolvePath(targetPath), 'utf8'),
    async writeText(targetPath, content) {
      const resolved = resolvePath(targetPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    listDir: (targetPath) => readdir(resolvePath(targetPath)),
    stat: (targetPath) => stat(resolvePath(targetPath)),
  };
}
