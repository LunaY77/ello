import { describe, expect, it } from 'vitest';

import { createFileChange } from '../tools/file-change.js';
import {
  buildPermissionView,
  type PermissionRequestLike,
} from '../tui/store/permission-view.js';

function request(over: Partial<PermissionRequestLike>): PermissionRequestLike {
  return { toolName: 'generic', input: {}, ...over };
}

describe('permission-view kind resolution', () => {
  it('maps metadata.kind workspace to external_directory', () => {
    const view = buildPermissionView(
      request({
        toolName: 'write',
        metadata: { kind: 'workspace', paths: ['/etc/hosts'] },
      }),
    );
    expect(view.kind).toBe('external_directory');
    expect(view.title).toBe('Write outside workspace');
    expect(view.fields).toContainEqual({ label: 'path', value: '/etc/hosts' });
  });

  it('falls back to tool-name inference when metadata.kind absent', () => {
    expect(buildPermissionView(request({ toolName: 'apply_patch' })).kind).toBe(
      'edit',
    );
    expect(buildPermissionView(request({ toolName: 'bash' })).kind).toBe(
      'shell',
    );
    expect(buildPermissionView(request({ toolName: 'grep' })).kind).toBe(
      'search',
    );
    expect(buildPermissionView(request({ toolName: 'web_fetch' })).kind).toBe(
      'network',
    );
    expect(buildPermissionView(request({ toolName: 'task-run' })).kind).toBe(
      'task',
    );
  });
});

describe('permission-view per-kind content', () => {
  it('edit shows path + diff summary only (no full diff)', () => {
    const fileChanges = [createFileChange('a.ts', 'line\n', 'line\nadded\n')];
    const view = buildPermissionView(
      request({
        toolName: 'edit',
        input: { path: 'a.ts' },
        metadata: { kind: 'edit', fileChanges },
      }),
    );
    expect(view.fields).toContainEqual({ label: 'path', value: 'a.ts' });
    expect(view.diffSummary).toEqual({ added: 1, removed: 0 });
    expect(JSON.stringify(view)).not.toContain('+added');
  });

  it('shell flags destructive commands', () => {
    const danger = buildPermissionView(
      request({ toolName: 'bash', input: { command: 'rm -rf /tmp/x' } }),
    );
    expect(danger.fields[0]).toEqual({ label: '$', value: 'rm -rf /tmp/x' });
    expect(danger.risk).toBeDefined();

    const safe = buildPermissionView(
      request({ toolName: 'bash', input: { command: 'ls -la' } }),
    );
    expect(safe.risk).toBeUndefined();
  });

  it('search and network extract their relevant fields', () => {
    const search = buildPermissionView(
      request({ toolName: 'grep', input: { pattern: 'foo', path: 'src' } }),
    );
    expect(search.fields).toContainEqual({ label: 'pattern', value: 'foo' });
    expect(search.fields).toContainEqual({ label: 'in', value: 'src' });

    const network = buildPermissionView(
      request({ toolName: 'fetch', input: { url: 'https://x.dev' } }),
    );
    expect(network.fields).toContainEqual({
      label: 'url',
      value: 'https://x.dev',
    });
  });

  it('task surfaces agent and description', () => {
    const view = buildPermissionView(
      request({
        toolName: 'delegate',
        input: { subagent_type: 'Explore', description: 'find usages' },
      }),
    );
    expect(view.fields).toContainEqual({ label: 'agent', value: 'Explore' });
    expect(view.fields).toContainEqual({ label: 'task', value: 'find usages' });
  });
});
