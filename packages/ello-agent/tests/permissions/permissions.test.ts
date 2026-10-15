/**
 * 本文件验证 permissions 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DeferredApprovalItem } from '../../src/features/agent/engine/index.js';
import { projectPermissionsFile } from '../../src/features/config/paths.js';
import { CodingAgentConfigSchema } from '../../src/features/config/schema.js';
import { evaluatePermission } from '../../src/features/tool/permissions/engine.js';
import { makeApprovalPolicy } from '../../src/features/tool/permissions/policy.js';
import { RulesStore } from '../../src/features/tool/permissions/rules-store.js';
import type { PermissionRule } from '../../src/features/tool/permissions/types.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-permissions-'));
  dirs.push(dir);
  return dir;
}

describe('permission policy', () => {
  it('未加载磁盘规则时直接拒绝读取', async () => {
    const cwd = await tempDir();
    const store = new RulesStore(cwd);

    expect(() => store.rules()).toThrow(
      'RulesStore.load() must complete before reading user rules.',
    );
  });

  it('uses the last matching rule', () => {
    const rules: PermissionRule[] = [
      { permission: 'bash', pattern: '**', action: 'allow', scope: 'project' },
      {
        permission: 'bash',
        pattern: 'rm **',
        action: 'deny',
        scope: 'project',
      },
    ];

    expect(evaluatePermission(rules, 'bash', 'rm -rf /tmp/x')).toBe('deny');
  });

  it('falls back to ask when nothing matches', () => {
    expect(evaluatePermission([], 'external_api', 'example.com')).toBe('ask');
  });

  it('treats configured allowed_paths as Tool Policy scope, not Environment isolation', async () => {
    const root = await tempDir();
    const workspace = path.join(root, 'workspace');
    const sibling = path.join(root, 'sibling');
    const config = CodingAgentConfigSchema.parse({
      cwd: workspace,
      allowed_paths: [sibling],
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
          reasoning_effort: 'medium',
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
    const descriptor = (target: string) => ({
      permission: 'read',
      patterns: [target],
      always: [target],
      paths: [target],
      metadata: { kind: 'read' as const, path: target },
    });

    expect(
      decide(descriptor(path.join(sibling, 'README.md')), {} as never),
    ).toBe('auto');
    expect(
      decide(descriptor(path.join(root, 'outside', 'README.md')), {} as never),
    ).toMatchObject({
      action: 'required',
      metadata: {
        externalDirs: [path.join(root, 'outside', 'README.md')],
      },
    });
  });

  it('resolves relative allowed_paths from the coding working directory', async () => {
    const root = await tempDir();
    const workspace = path.join(root, 'workspace');
    const config = CodingAgentConfigSchema.parse({
      cwd: workspace,
      allowed_paths: ['../sibling'],
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
          reasoning_effort: 'medium',
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
    const target = path.join(root, 'sibling', 'README.md');

    expect(
      decide(
        {
          permission: 'read',
          patterns: [target],
          always: [target],
          paths: [target],
          metadata: { kind: 'read', path: target },
        },
        {} as never,
      ),
    ).toBe('auto');
  });

  it('persists project approval rules as YAML using typed metadata', async () => {
    const cwd = await tempDir();
    const store = new RulesStore(cwd);
    await store.load();
    const item: DeferredApprovalItem = {
      kind: 'approval',
      toolCallId: 'call_1',
      commandName: 'external_api',
      input: { url: 'https://example.com/a' },
      metadata: {
        permission: 'external_api',
        patterns: ['example.com'],
        always: ['example.com', 'api.example.com'],
        externalDirs: ['/outside/project'],
        request: {
          kind: 'network',
          url: 'https://example.com/a',
          domain: 'example.com',
        },
      },
    };

    await store.addAllowRule(item, 'project');

    const text = await readFile(projectPermissionsFile(cwd), 'utf8');
    expect(text).toContain('rules:');
    expect(text).toContain('permission: external_api');
    expect(text).toContain('pattern: example.com');
    expect(text).not.toContain('[');

    const reloaded = new RulesStore(cwd);
    await reloaded.load();
    expect(reloaded.rules()).toEqual([
      expect.objectContaining({
        action: 'allow',
        permission: 'external_api',
        pattern: 'example.com',
      }),
      expect.objectContaining({
        action: 'allow',
        permission: 'external_api',
        pattern: 'api.example.com',
      }),
      expect.objectContaining({
        action: 'allow',
        permission: 'external_directory',
        pattern: '/outside/project',
      }),
    ]);
  });

  it('项目规则写盘失败时不发布进程内幽灵授权', async () => {
    const cwd = await tempDir();
    const store = new RulesStore(cwd);
    await store.load();
    await writeFile(path.join(cwd, '.ello'), 'not a directory', 'utf8');
    const item: DeferredApprovalItem = {
      kind: 'approval',
      toolCallId: 'call_failed_write',
      commandName: 'bash',
      input: { command: 'pnpm test' },
      metadata: {
        permission: 'bash',
        patterns: ['pnpm test'],
        always: ['pnpm test', 'pnpm lint'],
        externalDirs: ['/outside/project'],
        request: {
          kind: 'shell',
          command: 'pnpm test',
          cwd,
        },
      },
    };

    await expect(store.addAllowRule(item, 'project')).rejects.toThrow();
    expect(store.rules()).toEqual([]);
  });
});
