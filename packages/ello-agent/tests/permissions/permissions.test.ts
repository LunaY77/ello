import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DeferredApprovalItem } from '../../src/agent/engine/index.js';
import { evaluatePermission } from '../../src/agent/permissions/engine.js';
import { RulesStore } from '../../src/agent/permissions/rules-store.js';
import type { PermissionRule } from '../../src/agent/permissions/types.js';
import { projectPermissionsFile } from '../../src/config/paths.js';

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

  it('persists project approval rules as YAML using typed metadata', async () => {
    const cwd = await tempDir();
    const store = new RulesStore(cwd);
    const item: DeferredApprovalItem = {
      kind: 'approval',
      toolCallId: 'call_1',
      toolName: 'external_api',
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
    await writeFile(path.join(cwd, '.ello'), 'not a directory', 'utf8');
    const store = new RulesStore(cwd);
    const item: DeferredApprovalItem = {
      kind: 'approval',
      toolCallId: 'call_failed_write',
      toolName: 'bash',
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
