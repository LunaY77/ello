/**
 * 本文件验证 coding-tools-contract 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineTool,
  type AgentFileSystem,
  type AgentShell,
  type AgentToolContext,
} from '../../src/features/agent/engine/index.js';
import type { CodingAgentConfig } from '../../src/features/config/index.js';
import {
  AgentWorkflowState,
  CodingToolExecutionError,
  createCodingToolResult,
  ToolFailureTracker,
} from '../../src/features/tool/index.js';
import {
  parseApplyPatch,
  prepareApplyPatch,
} from '../../src/features/tool/internal/apply-patch.js';
import { projectToolEvent } from '../../src/features/tool/internal/event-projection.js';
import { createFsTools } from '../../src/features/tool/internal/fs.js';
import {
  createCallTool,
  createMetaToolRuntime,
  createToolSearchTool,
} from '../../src/features/tool/internal/meta-tools.js';
import type { CodingToolContext } from '../../src/features/tool/internal/runtime/coding-tool.js';
import { SessionFileState } from '../../src/features/tool/internal/runtime/file-state.js';
import { createToolSearchIndex } from '../../src/features/tool/internal/search-index.js';
import type { SearchProvider } from '../../src/features/tool/internal/search-provider.js';
import { createSearchTools } from '../../src/features/tool/internal/search.js';
import { createShellTools } from '../../src/features/tool/internal/shell.js';
import { createWorkspaceSnapshotTools } from '../../src/features/tool/internal/workspace-snapshot.js';

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
      { pattern: 'abc-\\d+', filePath: '.', limit: 1 },
      searchContext(root),
    );
    expect(limited.output).toBe(
      'a.txt:1:abc-123\n[More matches available. Retry with offset 1.]',
    );
    expect(limited.metadata.matchCount).toBe(1);
    expect(limited.metadata).toMatchObject({
      truncated: true,
      nextOffset: 1,
    });

    const next = await grep.execute(
      {
        pattern: 'abc-\\d+',
        filePath: '.',
        limit: 1,
        offset: 1,
        context: 1,
      },
      searchContext(root),
    );
    expect(next.output).toContain('a.txt-1-abc-123');
    expect(next.output).toContain('a.txt:2:abc-456');
    expect(next.output).toContain('a.txt-3-abc-xyz');

    const empty = await grep.execute(
      { pattern: 'missing', filePath: '.', limit: 10 },
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
      grep.execute(
        { pattern: '[', filePath: '.', limit: 10 },
        searchContext(root),
      ),
    ).rejects.toThrow('Invalid grep regular expression');
    const result = await grep.execute(
      { pattern: 'hit', filePath: '.', limit: 10 },
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
      { pattern: '**/*.ts', filePath: '.', limit: 2 },
      searchContext(root),
    );
    expect(result.output.split('\n')).toEqual([
      'src/a.ts',
      'src/nested/b.ts',
      '[More paths available. Retry with offset 2.]',
    ]);
    expect(result.metadata.matchCount).toBe(2);

    const next = await glob.execute(
      { pattern: '**/*.ts', filePath: '.', limit: 2, offset: 2 },
      searchContext(root),
    );
    expect(next.output).toBe('src/z.ts');
    expect(next.metadata.truncated).toBe(false);
  });

  it('原生 provider 安全处理空格和 shell 元字符，且可回退 JS 遍历', async () => {
    const root = await temporaryDirectory('ello-native-search-');
    await writeFile(
      path.join(root, 'a b.txt'),
      'needle;touch injected\n',
      'utf8',
    );
    const native = searchTool('grep');

    const nativeResult = await native.execute(
      { pattern: 'needle;touch injected', filePath: '.', limit: 10 },
      searchContext(root),
    );
    expect(nativeResult.output).toBe('a b.txt:1:needle;touch injected');
    await expect(stat(path.join(root, 'injected'))).rejects.toThrow();

    const fallback: SearchProvider = {
      grep: vi.fn(async () => null),
      listFiles: vi.fn(async () => null),
    };
    const fallbackGrep = searchTool('grep', fallback);
    const fallbackGlob = searchTool('glob', fallback);
    await expect(
      fallbackGrep.execute(
        { pattern: 'needle', filePath: '.', limit: 10 },
        searchContext(root),
      ),
    ).resolves.toMatchObject({ metadata: { matchCount: 1 } });
    await expect(
      fallbackGlob.execute(
        { pattern: '**/*.txt', filePath: '.', limit: 10 },
        searchContext(root),
      ),
    ).resolves.toMatchObject({ metadata: { matchCount: 1 } });
    expect(fallback.grep).toHaveBeenCalledOnce();
    expect(fallback.listFiles).toHaveBeenCalledOnce();
  });
});

describe('读取工具契约', () => {
  it('相同未变更区间只返回短标记，文件变化后重新返回内容', async () => {
    const root = await temporaryDirectory('ello-read-cache-');
    const targetPath = path.join(root, 'a.txt');
    await writeFile(targetPath, 'first\nsecond\n', 'utf8');
    const initialVersion = await stat(targetPath);
    const fileState = new SessionFileState();
    const read = createFsTools(
      {} as CodingAgentConfig,
      () => 'auto',
      fileState,
    ).find((candidate) => candidate.name === 'read');
    if (read === undefined) throw new Error('read tool missing');
    const nextRunRead = createFsTools(
      {} as CodingAgentConfig,
      () => 'auto',
      fileState,
    ).find((candidate) => candidate.name === 'read');
    if (nextRunRead === undefined)
      throw new Error('next run read tool missing');
    const context = searchContext(root);
    const input = { filePath: 'a.txt', offset: 1, limit: 10 };

    const first = await read.execute(input, context);
    expect(first.output).toContain('first');
    expect(first.output).toContain('[Read lines 1-3 of 3.]');
    expect(first.metadata.unchanged).toBeUndefined();

    const duplicate = await nextRunRead.execute(input, context);
    expect(duplicate.output).toContain('File unchanged');
    expect(duplicate.metadata.unchanged).toBe(true);

    // 即使文件大小和修改时间没有变化，主动清除缓存后也必须读到最新内容。
    await writeFile(targetPath, 'third\nfourth\n', 'utf8');
    await utimes(targetPath, initialVersion.atime, initialVersion.mtime);
    fileState.invalidate([targetPath]);
    const changed = await nextRunRead.execute(input, context);
    expect(changed.output).toContain('third');
    expect(changed.metadata.unchanged).toBeUndefined();
  });

  it('返回完整原始结果并由上层 output store 统一限制上下文', async () => {
    const root = await temporaryDirectory('ello-read-output-');
    const source = Array.from(
      { length: 500 },
      (_, index) => `${String(index).padStart(4, '0')} ${'x'.repeat(40)}`,
    ).join('\n');
    await writeFile(path.join(root, 'large.txt'), source, 'utf8');
    const read = createFsTools({} as CodingAgentConfig, () => 'auto').find(
      (candidate) => candidate.name === 'read',
    );
    if (read === undefined) throw new Error('read tool missing');

    const result = await read.execute(
      { filePath: 'large.txt', offset: 1, limit: 500 },
      searchContext(root),
    );

    expect(result.output.length).toBeGreaterThan(12_000);
    expect(result.output).toContain('[Read lines 1-500 of 500.]');
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

  it('保留 core tools 的定义顺序，只把非 core tools 放入懒加载索引', async () => {
    const coreRead = {
      ...tools[0]!,
      discovery: { ...tools[0]!.discovery, core: true },
    };
    const runtime = createMetaToolRuntime(
      [coreRead, tools[1]!, tools[2]!],
      [],
      config,
    );

    expect(runtime.modelTools.map((tool) => tool.name)).toEqual([
      'read',
      'tool_search',
      'call_tool',
    ]);
    const search = runtime.modelTools.find(
      (tool) => tool.name === 'tool_search',
    );
    if (search === undefined || search.execution !== 'immediate') {
      throw new Error('tool_search missing');
    }
    const result = (await search.execute(
      { query: 'file', limit: 6 },
      agentToolContext,
    )) as { readonly results: readonly { readonly name: string }[] };
    expect(result.results.map(({ name }) => name)).not.toContain('read');
  });

  it('全部目标都是 core 时不启用工具路由', () => {
    const coreTools = tools.map((tool) => ({
      ...tool,
      discovery: { ...tool.discovery, core: true },
    }));
    const runtime = createMetaToolRuntime(coreTools, [], config);

    expect(runtime.usesToolRouting).toBe(false);
    expect(runtime.executionTools.map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'write',
    ]);
    expect(runtime.modelTools.map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'write',
    ]);
    expect(
      runtime.modelTools.every((tool) => tool.discovery.core === true),
    ).toBe(true);
  });

  it('库存分页不泄露 schema，精确搜索可返回当前模式的 Plan 工具', async () => {
    const planTools = [
      defineTool({
        name: 'write_plan',
        description: 'Write the complete plan.',
        discovery: { aliases: ['save plan'], risk: 'workspace-write' },
        input: z.object({ content: z.string() }).strict(),
        execute: async () => 'written',
      }),
      defineTool({
        name: 'request_plan_exit',
        description: 'Request approval for the complete plan.',
        discovery: { aliases: ['approve plan'], risk: 'workspace-write' },
        input: z.object({}).strict(),
        execute: async () => 'requested',
      }),
    ];
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
    ).rejects.toThrow(
      "Invalid arguments for tool 'read': 'path' is invalid: Invalid input: expected string, received undefined",
    );
    expect(() => createCallTool([tools[0]!, tools[0]!])).toThrow(
      'Duplicate call_tool target',
    );
  });

  it('call_tool 代理目标的动态能力、启用状态和领域校验', async () => {
    const validateInput = vi.fn((input: { readonly path: string }) => {
      if (input.path.endsWith('.secret')) {
        throw new Error('Secret files are disabled.');
      }
    });
    const read = defineTool({
      name: 'read_extra',
      description: 'Read an extra file.',
      discovery: { aliases: ['extra file'], risk: 'readonly' },
      input: z.object({ path: z.string() }).strict(),
      capabilities: ({ path }) => ({
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
        enabled: path !== 'disabled.txt',
        telemetryTag: 'extension.read',
      }),
      validateInput,
      execute: ({ path }) => path,
    });
    const proxy = createCallTool([read]);
    const input = { name: 'read_extra', arguments: { path: 'a.txt' } };

    await expect(
      proxy.capabilities?.(input, agentToolContext),
    ).resolves.toMatchObject({
      logicalName: 'read_extra',
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      enabled: true,
      telemetryTag: 'extension.read',
    });
    await expect(
      proxy.validateInput?.(input, agentToolContext),
    ).resolves.toBeUndefined();
    await expect(
      proxy.validateInput?.(
        { name: 'read_extra', arguments: { path: 'token.secret' } },
        agentToolContext,
      ),
    ).rejects.toThrow('Secret files are disabled.');
    expect(validateInput).toHaveBeenCalledTimes(2);
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

describe('工具恢复与阶段化验证契约', () => {
  it('相同错误生成稳定指纹，并在第二次失败后要求切换策略', () => {
    const tracker = new ToolFailureTracker();
    const first = tracker.create(
      'read',
      new Error('No such file at line 12: missing-123.txt'),
    );
    const second = tracker.create(
      'read',
      new Error('No such file at line 99: missing-456.txt'),
    );

    expect(first).toBeInstanceOf(CodingToolExecutionError);
    expect(first.diagnostic).toMatchObject({
      code: 'PATH_NOT_FOUND',
      attempt: 1,
      attemptsRemaining: 1,
      retryable: true,
      strategy: 'retry_with_context',
    });
    expect(second.diagnostic).toMatchObject({
      fingerprint: first.diagnostic.fingerprint,
      attempt: 2,
      attemptsRemaining: 0,
      retryable: false,
      strategy: 'switch_strategy',
    });
  });

  it('真实工具结果驱动 explore、implement、verify 和 recover 阶段切换', () => {
    const workflow = new AgentWorkflowState();
    expect(workflow.instructions()).toContain('phase="explore"');

    workflow.observeResult(
      createCodingToolResult({
        title: 'Edit file',
        output: 'updated',
        metadata: { kind: 'edit' },
      }),
    );
    expect(workflow.instructions()).toContain('phase="implement"');

    workflow.observeResult(
      createCodingToolResult({
        title: 'Targeted verification',
        output: 'passed',
        metadata: { kind: 'shell', phase: 'targeted' },
      }),
    );
    expect(workflow.instructions()).toContain('phase="verify"');

    workflow.observeFailure();
    expect(workflow.instructions()).toContain('phase="recover"');
    workflow.observeResult(
      createCodingToolResult({
        title: 'Read evidence',
        output: 'fact',
        metadata: { kind: 'read' },
      }),
    );
    expect(workflow.instructions()).toContain('phase="explore"');
  });

  it('workspace_snapshot 一次返回 Git、根目录、依赖和验证命令', async () => {
    const root = await temporaryDirectory('ello-workspace-snapshot-');
    await Promise.all([
      mkdir(path.join(root, 'src')),
      writeFile(path.join(root, 'package.json'), '{}\n', 'utf8'),
      writeFile(
        path.join(root, 'pnpm-lock.yaml'),
        'lockfileVersion: 9\n',
        'utf8',
      ),
    ]);
    const commands: string[] = [];
    const shell: AgentShell = {
      async run(command) {
        commands.push(command);
        if (command === 'git rev-parse HEAD') {
          return shellResult({ stdout: `${'a'.repeat(40)}\n` });
        }
        if (command === 'git branch --show-current') {
          return shellResult({ stdout: 'main\n' });
        }
        return shellResult({ stdout: '## main\n M src/index.ts\n' });
      },
    };
    const tool = createWorkspaceSnapshotTools(
      { cwd: root } as CodingAgentConfig,
      () => 'auto',
    )[0]!;

    const result = await tool.execute(
      { include_untracked: true },
      toolContext(root, shell),
    );
    const snapshot = JSON.parse(result.output) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schema: 'ello.workspace-snapshot.v1',
      cwd: root,
      git: {
        available: true,
        head: 'a'.repeat(40),
        branch: 'main',
        status: ['## main', ' M src/index.ts'],
      },
      manifests: ['package.json'],
      lockfiles: ['pnpm-lock.yaml'],
      verificationCommands: ['pnpm test', 'pnpm typecheck', 'pnpm lint'],
    });
    expect(commands).toEqual([
      'git rev-parse HEAD',
      'git branch --show-current',
      'git status --short --branch',
    ]);
    expect(result.metadata).toMatchObject({
      kind: 'workspace',
      dirty: true,
    });
  });

  it('test 工具在模型可见输出和元数据中保留验证阶段与退出状态', async () => {
    const root = await temporaryDirectory('ello-test-tool-');
    const testTool = createShellTools(
      { cwd: root } as CodingAgentConfig,
      () => 'auto',
    ).find((tool) => tool.name === 'test');
    if (testTool === undefined) throw new Error('缺少 test 工具。');
    const shell: AgentShell = {
      run: () =>
        Promise.resolve(
          shellResult({
            exitCode: 1,
            stdout: '1 test failed\n',
            stderr: 'assertion error\n',
          }),
        ),
    };

    const result = await testTool.execute(
      {
        phase: 'targeted',
        command: 'pnpm vitest src/example.test.ts',
        timeoutMs: 5_000,
      },
      toolContext(root, shell),
    );
    const summary = JSON.parse(result.output.split('\n')[0]!) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      phase: 'targeted',
      command: 'pnpm vitest src/example.test.ts',
      cwd: root,
      exitCode: 1,
      timedOut: false,
    });
    expect(result.output).toContain('stderr:\nassertion error');
    expect(result.metadata).toMatchObject({
      kind: 'shell',
      phase: 'targeted',
      exitCode: 1,
    });
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

function searchTool(name: 'grep' | 'glob', provider?: SearchProvider) {
  const tool = createSearchTools(
    {} as CodingAgentConfig,
    () => 'auto',
    provider,
  ).find((candidate) => candidate.name === name);
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

function toolContext(root: string, shell: AgentShell): CodingToolContext {
  const context = searchContext(root);
  return {
    ...context,
    agent: {
      ...context.agent,
      environment: { ...context.agent.environment, shell },
    },
  };
}

function shellResult(
  overrides: Partial<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
  }> = {},
) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
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
