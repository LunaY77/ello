import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DeferredApprovalItem } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { RulesStore } from '../permission/rules-store.js';
import type { PermissionRule } from '../permission/types.js';
import { evaluatePermission } from '../permissions.js';
import { projectPermissionsFile } from '../session/paths.js';

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
    expect(evaluatePermission([], 'web_fetch', 'example.com')).toBe('ask');
  });

  it('persists project approval rules as YAML using typed metadata', async () => {
    const cwd = await tempDir();
    const store = new RulesStore(cwd);
    const item: DeferredApprovalItem = {
      kind: 'approval',
      toolCallId: 'call_1',
      toolName: 'web_fetch',
      input: { url: 'https://example.com/a' },
      metadata: {
        permission: 'web_fetch',
        patterns: ['example.com'],
        always: ['example.com'],
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
    expect(text).toContain('permission: web_fetch');
    expect(text).toContain('pattern: example.com');
    expect(text).not.toContain('[');

    const reloaded = new RulesStore(cwd);
    await reloaded.load();
    expect(reloaded.rules()).toEqual([
      expect.objectContaining({
        action: 'allow',
        permission: 'web_fetch',
        pattern: 'example.com',
      }),
    ]);
  });
});
