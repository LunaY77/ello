import { describe, expect, it } from 'vitest';

import { createFileChange } from '../../src/testing/protocol-fixtures.js';
import {
  buildPermissionView,
  PROJECT_RULES_FILE,
  type PermissionRequestLike,
} from '../../src/tui/store/permission-view.js';

function request(
  overrides: Partial<PermissionRequestLike>,
): PermissionRequestLike {
  return { toolName: 'generic', input: {}, ...overrides };
}

describe('权限请求分类', () => {
  it('优先使用 metadata.kind，并把工作区外写入标成外部目录风险', () => {
    const view = buildPermissionView(
      request({
        toolName: 'write',
        metadata: { kind: 'workspace', paths: ['/etc/hosts'] },
      }),
    );

    expect(view).toMatchObject({
      kind: 'external_directory',
      title: 'Write outside workspace',
    });
    expect(view.fields).toContainEqual({ label: 'path', value: '/etc/hosts' });
  });

  it('缺少显式分类时按用户熟悉的工具名称推断用途', () => {
    expect(buildPermissionView(request({ toolName: 'apply_patch' })).kind).toBe(
      'edit',
    );
    expect(buildPermissionView(request({ toolName: 'bash' })).kind).toBe(
      'shell',
    );
    expect(buildPermissionView(request({ toolName: 'read' })).kind).toBe(
      'read',
    );
    expect(buildPermissionView(request({ toolName: 'grep' })).kind).toBe(
      'search',
    );
    expect(buildPermissionView(request({ toolName: 'fetch' })).kind).toBe(
      'network',
    );
    expect(buildPermissionView(request({ toolName: 'task-run' })).kind).toBe(
      'task',
    );
  });

  it('兼容协议层把工具 metadata 包在 request 字段内的形态', () => {
    const view = buildPermissionView(
      request({
        toolName: 'unknown',
        input: {},
        metadata: {
          request: { kind: 'network', url: 'https://ello.dev' },
        },
      }),
    );

    expect(view.kind).toBe('network');
    expect(view.fields).toEqual([{ label: 'url', value: 'https://ello.dev' }]);
  });
});

describe('权限请求展示内容', () => {
  it('编辑审批只展示路径和增删摘要，不泄漏完整 diff', () => {
    const fileChanges = [createFileChange('a.ts', 'line\n', 'line\nadded\n')];
    const view = buildPermissionView(
      request({
        toolName: 'edit',
        input: { path: 'a.ts' },
        metadata: { kind: 'edit', fileChanges },
      }),
    );

    expect(view.fields).toContainEqual({ label: 'path', value: 'a.ts' });
    expect(view.diffSummary).toEqual({ added: 2, removed: 1 });
    expect(JSON.stringify(view)).not.toContain('+added');
  });

  it('shell 审批展示命令和目录，并提示破坏性命令', () => {
    const dangerous = buildPermissionView(
      request({
        toolName: 'bash',
        input: { command: 'rm -rf /tmp/x', cwd: '/workspace' },
      }),
    );
    const safe = buildPermissionView(
      request({ toolName: 'bash', input: { command: 'ls -la' } }),
    );

    expect(dangerous.fields).toEqual([
      { label: '$', value: 'rm -rf /tmp/x' },
      { label: 'cwd', value: '/workspace' },
    ]);
    expect(dangerous.risk).toContain('destructive command');
    expect(safe.risk).toBeUndefined();
  });

  it('读取、搜索和网络审批仅展示各自相关字段', () => {
    expect(
      buildPermissionView(
        request({ toolName: 'read', input: { path: 'a.ts' } }),
      ).fields,
    ).toEqual([{ label: 'path', value: 'a.ts' }]);

    const search = buildPermissionView(
      request({ toolName: 'grep', input: { pattern: 'foo', path: 'src' } }),
    );
    expect(search.fields).toEqual([
      { label: 'pattern', value: 'foo' },
      { label: 'in', value: 'src' },
    ]);

    const network = buildPermissionView(
      request({
        toolName: 'fetch',
        input: { url: 'https://x.dev', domain: 'x.dev' },
      }),
    );
    expect(network.fields).toEqual([
      { label: 'url', value: 'https://x.dev' },
      { label: 'domain', value: 'x.dev' },
    ]);
  });

  it('子任务审批展示代理和任务说明，未知工具展示摘要', () => {
    const task = buildPermissionView(
      request({
        toolName: 'delegate',
        input: { subagent_type: 'Explore', description: 'find usages' },
      }),
    );
    expect(task.fields).toEqual([
      { label: 'agent', value: 'Explore' },
      { label: 'task', value: 'find usages' },
    ]);

    expect(
      buildPermissionView(
        request({ toolName: 'custom', metadata: { summary: 'do work' } }),
      ).fields,
    ).toEqual([{ label: 'summary', value: 'do work' }]);
    expect(PROJECT_RULES_FILE).toBe('.ello/permissions.yaml');
  });

  it('损坏的文件变更元数据会拒绝生成误导性的编辑摘要', () => {
    expect(() =>
      buildPermissionView(
        request({
          toolName: 'edit',
          metadata: {
            kind: 'edit',
            fileChanges: [{ path: 42, kind: 'modify' }],
          },
        }),
      ),
    ).toThrow('Invalid file change metadata.');
  });
});
