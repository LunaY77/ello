import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DeferredApprovalItem } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { RulesStore } from '../permission/rules-store.js';
import { evaluateToolPermission, type PermissionRule } from '../permissions.js';
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
  it('uses the last matching rule', async () => {
    const cwd = await tempDir();
    const rules: PermissionRule[] = [
      { action: 'allow', tool: 'bash', scope: 'project' },
      { action: 'deny', tool: 'bash', scope: 'project' },
    ];

    expect(
      evaluateToolPermission({
        toolName: 'bash',
        input: { command: 'echo hi' },
        cwd,
        allowedPaths: [cwd],
        mode: 'default',
        rules,
      }),
    ).toMatchObject({ action: 'deny' });
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
        kind: 'network',
        url: 'https://example.com/a',
        domain: 'example.com',
      },
    };

    await store.addAllowRule(item, 'project');

    const text = await readFile(projectPermissionsFile(cwd), 'utf8');
    expect(text).toContain('rules:');
    expect(text).toContain('domain: example.com');
    expect(text).not.toContain('[');

    const reloaded = new RulesStore(cwd);
    await reloaded.load();
    expect(reloaded.rules()).toEqual([
      expect.objectContaining({
        action: 'allow',
        tool: 'web_fetch',
        domain: 'example.com',
      }),
    ]);
  });
});
