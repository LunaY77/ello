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

import {
  createCommandRegistrySnapshot,
  createCommandRunRuntime,
  defineCommandModule,
  type CommandContext,
  type CommandDefinition,
} from '../../src/features/command/index.js';
import {
  CodingAgentConfigSchema,
  type CodingAgentConfig,
} from '../../src/features/config/index.js';
import type {
  EnvironmentFileSystem,
  EnvironmentProcesses,
} from '../../src/features/environment/index.js';
import { createTaskService } from '../../src/features/task/index.js';
import {
  CommandExecutionError,
  CommandFailureTracker,
} from '../../src/features/tool/index.js';
import {
  parseApplyPatch,
  prepareApplyPatch,
} from '../../src/features/tool/internal/apply-patch.js';
import { createFsCommands } from '../../src/features/tool/internal/fs.js';
import { createProductionCommandRuntime } from '../../src/features/tool/internal/production.js';
import type { CommandResult } from '../../src/features/tool/internal/runtime/command-result.js';
import { SessionFileState } from '../../src/features/tool/internal/runtime/file-state.js';
import { persistLargeOutput } from '../../src/features/tool/internal/runtime/output-store.js';
import type { SearchProvider } from '../../src/features/tool/internal/search-provider.js';
import { createSearchCommands } from '../../src/features/tool/internal/search.js';
import { createShellCommands } from '../../src/features/tool/internal/shell.js';
import { createTaskCommands } from '../../src/features/tool/internal/task.js';
import { makeApprovalPolicy } from '../../src/features/tool/permissions/policy.js';
import { createTestEnvironmentHandle } from '../support/environment.js';
import { createTestStores } from '../support/stores.js';

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

describe('Environment 进程能力边界', () => {
  it('保留内部进程 interface，但不注册模型可见 process 工具', async () => {
    const root = await temporaryDirectory('ello-process-boundary-');
    const environment = createTestEnvironmentHandle(root);
    expect(typeof environment.processes.exec).toBe('function');
    expect(typeof environment.processes.spawn).toBe('function');

    const config = CodingAgentConfigSchema.parse({
      cwd: root,
      session_dir: path.join(root, '.ello', 'sessions'),
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
    try {
      const runtime = createProductionCommandRuntime({
        config,
        taskBoards: stores.taskBoards,
        taskBoardScope: { type: 'session', sessionId: 'process-boundary' },
        mode: () => ({
          mode: 'ask-before-changes',
          previousMode: null,
          source: 'config',
          changedAt: '2026-08-01T00:00:00.000Z',
        }),
      });
      const toolNames = runtime.module.commands.map((command) => command.name);

      expect(toolNames).toContain('bash');
      expect(toolNames).not.toContain('test');
      expect(toolNames).not.toContain('workspace_snapshot');
      expect(toolNames).not.toContain('process');
    } finally {
      stores.close();
    }
  });
});

describe('Command Run 工具说明', () => {
  it('从生产 Command 定义自动渲染可直接调用的 Frame 示例', () => {
    const commands = [
      ...createFsCommands({} as CodingAgentConfig, () => 'auto'),
      ...createSearchCommands({} as CodingAgentConfig, () => 'auto'),
      ...createShellCommands({} as CodingAgentConfig, () => 'auto'),
    ];
    const runtime = createCommandRunRuntime(
      createCommandRegistrySnapshot({
        modules: [defineCommandModule({ id: 'example-test', commands })],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    );

    expect(runtime.modelTool.description).toContain(
      '  Batch: {"commands":[{"step":1,"command":"read","args":["README.md","--limit","80"]},{"step":2,"command":"write","args":["notes.txt"],"body":"First line\\n"}]}',
    );
    expect(runtime.modelTool.description).toContain(
      '  Object arguments: {"step":1,"command":"command_invoke","input":{"name":"<command_search result>","arguments":{}}}',
    );
    expect(
      runtime.modelTool.input.safeParse({
        commands: [
          { step: 1, command: 'read', args: ['README.md', '--limit', '80'] },
          {
            step: 2,
            command: 'write',
            args: ['notes.txt'],
            body: 'First line\n',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('核心命令不再引用已移除的直接工具或旧的模型响应并发语义', () => {
    const descriptions = new Map(
      [
        ...createFsCommands({} as CodingAgentConfig, () => 'auto'),
        ...createSearchCommands({} as CodingAgentConfig, () => 'auto'),
        ...createShellCommands({} as CodingAgentConfig, () => 'auto'),
      ].map((command) => [
        command.name,
        [command.summary, command.details]
          .filter((value): value is string => value !== undefined)
          .join(' '),
      ]),
    );

    for (const name of ['read', 'write', 'apply_patch', 'bash']) {
      const description = descriptions.get(name);
      if (description === undefined) throw new Error(`Missing ${name} tool.`);
      expect(description).not.toContain('edit');
      expect(description).not.toContain('grep');
      expect(description).not.toContain('glob');
      expect(description).not.toContain('model response');
    }
    expect(descriptions.get('write')).toContain('STALE_WRITE');
    expect(descriptions.get('apply_patch')).toContain('*** Begin Patch');
    expect(descriptions.get('search')).toContain('Unicode regular expression');
    expect(descriptions.get('search')).not.toContain('model response');
  });
});

describe('Task Command 命名空间', () => {
  it('持久任务 Command 收到子代理 job id 时指向正确的控制 Command', async () => {
    const root = await temporaryDirectory('ello-task-command-namespace-');
    const stores = createTestStores({ databasePath: ':memory:' });
    try {
      const taskGet = codingCommand(
        createTaskCommands(
          () => () => 'auto',
          createTaskService(stores.taskBoards, {
            type: 'session',
            sessionId: 'namespace-test',
          }),
        ),
        'task_get',
      );

      await expect(
        taskGet.execute(
          { id: 'job_c260a350714844dd9d65d353d0c13b37' },
          toolContext(root, noNativeProcesses()),
        ),
      ).rejects.toThrow(
        'This is a Subagent job ID; use get_agent to read it or stop_agent to stop it.',
      );
    } finally {
      stores.close();
    }
  });
});

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
    const read = codingCommand(
      createFsCommands({} as CodingAgentConfig, () => 'auto', fileState),
      'read',
    );
    const nextRunRead = codingCommand(
      createFsCommands({} as CodingAgentConfig, () => 'auto', fileState),
      'read',
    );
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
    const read = codingCommand(
      createFsCommands({} as CodingAgentConfig, () => 'auto'),
      'read',
    );

    const result = await read.execute(
      { filePath: 'large.txt', offset: 1, limit: 500 },
      searchContext(root),
    );

    expect(result.output.length).toBeGreaterThan(12_000);
    expect(result.output).toContain('[Read lines 1-500 of 500.]');
  });
});

describe('Command 输出预算', () => {
  it('按 byte budget 截断超长单行并把完整输出写入 artifact', async () => {
    const output = 'x'.repeat(64 * 1024);
    let persisted = '';

    const result = await persistLargeOutput({
      output,
      limits: { maxBytes: 1_024, maxLines: 100, previewLines: 20 },
      store: {
        writeLargeOutput(input) {
          persisted = input.content;
          return Promise.resolve({
            outputPath: '/workspace/artifacts/bash.txt',
          });
        },
      },
      sessionId: 'session',
      runId: 'run',
      callId: 'call',
      preferredName: 'bash.txt',
    });

    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('Expected a truncated output.');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(result.output).toContain('truncated');
    expect(result.outputPath).toBe('/workspace/artifacts/bash.txt');
    expect(persisted).toBe(output);
  });
});

describe('文件写入审批边界', () => {
  it.each([
    {
      name: 'write',
      input: {
        filePath: '/external/write.txt',
        content: 'new\n',
      },
      externalDirs: ['/external/write.txt'],
    },
    {
      name: 'edit',
      input: {
        filePath: '/external/edit.txt',
        oldText: 'old',
        newText: 'new',
      },
      externalDirs: ['/external/edit.txt'],
    },
    {
      name: 'apply_patch',
      input: {
        patch: `*** Begin Patch
*** Update File: /external/source.txt
*** Move to: /external/destination.txt
@@
-old
+new
*** End Patch`,
      },
      externalDirs: ['/external/source.txt', '/external/destination.txt'],
    },
  ])(
    '$name 在 external_directory 获批前不读取 Environment',
    async ({ name, input, externalDirs }) => {
      const readText = vi.fn(() =>
        Promise.reject(new Error('approval performed filesystem I/O')),
      );
      const environment = createTestEnvironmentHandle('/workspace');
      const context: CommandContext = {
        runId: 'run',
        turnIndex: 0,
        commandId: 'call',
        environment: {
          ...environment,
          fileSystem: { ...environment.fileSystem, readText },
        },
        metadata: {},
        signal: new AbortController().signal,
      };
      const config = CodingAgentConfigSchema.parse({
        cwd: '/workspace',
        allowed_paths: [],
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
      const decide = makeApprovalPolicy(
        config,
        () => [],
        () => ({
          mode: 'ask-before-changes',
          previousMode: null,
          source: 'config',
          changedAt: '2026-07-31T00:00:00.000Z',
        }),
      );
      const tool = codingCommand(createFsCommands(config, decide), name);
      if (tool.approval === undefined) {
        throw new Error(`${name} approval missing`);
      }

      await expect(tool.approval(input, context)).resolves.toMatchObject({
        action: 'required',
        metadata: {
          externalDirs,
          request: { kind: 'edit' },
        },
      });
      expect(readText).not.toHaveBeenCalled();
    },
  );
});

describe('文件写入执行契约', () => {
  it('使用 read 返回的 digest 覆写并拒绝 stale digest', async () => {
    const root = await temporaryDirectory('ello-write-digest-');
    await writeFile(path.join(root, 'existing.txt'), 'before\n', 'utf8');
    const commands = createFsCommands({} as CodingAgentConfig, () => 'auto');
    const read = codingCommand(commands, 'read');
    const write = codingCommand(commands, 'write');
    const context = searchContext(root);
    const observed = await read.execute(
      { filePath: 'existing.txt', offset: 1, limit: 10 },
      context,
    );
    const expectedDigest = observed.metadata.sha256;
    expect(expectedDigest).toMatch(/^[a-f\d]{64}$/u);

    await expect(
      write.execute(
        { filePath: 'existing.txt', content: 'after\n', expectedDigest },
        context,
      ),
    ).resolves.toMatchObject({
      metadata: { before: 'before\n', after: 'after\n' },
    });

    await writeFile(path.join(root, 'existing.txt'), 'other\n', 'utf8');
    await expect(
      write.execute(
        { filePath: 'existing.txt', content: 'stale\n', expectedDigest },
        context,
      ),
    ).rejects.toThrow('STALE_WRITE');
    await expect(
      readFile(path.join(root, 'existing.txt'), 'utf8'),
    ).resolves.toBe('other\n');
  });

  it('在 Environment 报告 ENOENT 时创建新文件', async () => {
    const root = await temporaryDirectory('ello-write-missing-');
    const writeText = vi.fn(async (targetPath: string, content: string) => {
      await mkdir(path.dirname(path.resolve(root, targetPath)), {
        recursive: true,
      });
      await writeFile(path.resolve(root, targetPath), content, 'utf8');
    });
    const environment = createTestEnvironmentHandle(root);
    const fileSystem = {
      ...environment.fileSystem,
      readText: vi.fn(() =>
        Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      ),
      writeText,
    };
    const tool = codingCommand(
      createFsCommands({} as CodingAgentConfig, () => 'auto'),
      'write',
    );

    await expect(
      tool.execute(
        { filePath: 'nested/new.txt', content: 'created\n' },
        {
          runId: 'run',
          turnIndex: 0,
          commandId: 'call',
          environment: { ...environment, fileSystem },
          metadata: {},
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      metadata: { before: null, after: 'created\n' },
    });
    expect(writeText).toHaveBeenCalledWith('nested/new.txt', 'created\n');
    await expect(
      readFile(path.join(root, 'nested/new.txt'), 'utf8'),
    ).resolves.toBe('created\n');
  });
});

describe('工具失败恢复契约', () => {
  it('相同错误生成稳定指纹，并在第二次失败后要求切换策略', () => {
    const tracker = new CommandFailureTracker();
    const first = tracker.create(
      'read',
      new Error('No such file at line 12: missing-123.txt'),
    );
    const second = tracker.create(
      'read',
      new Error('No such file at line 99: missing-456.txt'),
    );

    expect(first).toBeInstanceOf(CommandExecutionError);
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
});

function codingCommand(commands: readonly CommandDefinition[], name: string) {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined || command.execution.kind !== 'immediate') {
    throw new Error(`Missing immediate Command ${name}.`);
  }
  const execution = command.execution;
  const parse = (input: unknown) =>
    command.invocation.input.schema.parse(input);
  return {
    approval:
      command.approval === undefined
        ? undefined
        : async (input: unknown, context: CommandContext) =>
            command.approval?.(parse(input), context),
    execute: async (
      input: unknown,
      context: CommandContext,
    ): Promise<CommandResult> =>
      (await execution.run(
        input === undefined ? input : parse(input),
        context,
      )) as CommandResult,
  };
}

function searchTool(name: 'grep' | 'glob', provider?: SearchProvider) {
  const command = codingCommand(
    createSearchCommands({} as CodingAgentConfig, () => 'auto', provider),
    'search',
  );
  return {
    execute: (input: unknown, context: CommandContext) =>
      command.execute(
        {
          kind: name === 'grep' ? 'text' : 'files',
          ...(input as Record<string, unknown>),
        },
        context,
      ),
  };
}

function searchContext(root: string): CommandContext {
  const fileSystem = testFileSystem(root);
  const environment = createTestEnvironmentHandle(root);
  return {
    runId: 'run',
    turnIndex: 0,
    commandId: 'call',
    environment: {
      ...environment,
      fileSystem,
      processes: noNativeProcesses(),
    },
    metadata: {},
    signal: new AbortController().signal,
  };
}

function toolContext(
  root: string,
  processes: EnvironmentProcesses,
): CommandContext {
  const context = searchContext(root);
  return {
    ...context,
    environment: { ...context.environment, processes },
  };
}

function testFileSystem(root: string): EnvironmentFileSystem {
  const resolvePath = (targetPath: string): string =>
    path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(root, targetPath);
  return {
    resolvePath,
    readFile: (targetPath) => readFile(resolvePath(targetPath)),
    readText: (targetPath) => readFile(resolvePath(targetPath), 'utf8'),
    async writeFile(targetPath, content) {
      const resolved = resolvePath(targetPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    async writeText(targetPath, content) {
      const resolved = resolvePath(targetPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    listDir: (targetPath) => readdir(resolvePath(targetPath)),
    async stat(targetPath) {
      const value = await stat(resolvePath(targetPath));
      return {
        kind: value.isDirectory()
          ? 'directory'
          : value.isFile()
            ? 'file'
            : value.isSymbolicLink()
              ? 'symlink'
              : 'other',
        size: value.size,
        modifiedAtMs: value.mtimeMs,
      };
    },
    remove: (targetPath) => rm(resolvePath(targetPath)),
  };
}

function testProcesses(
  exec: EnvironmentProcesses['exec'],
): EnvironmentProcesses {
  return { ...createTestEnvironmentHandle().processes, exec };
}

function noNativeProcesses(): EnvironmentProcesses {
  return testProcesses(() =>
    Promise.reject(
      Object.assign(new Error('Native process unavailable.'), {
        code: 'ENOENT',
      }),
    ),
  );
}
