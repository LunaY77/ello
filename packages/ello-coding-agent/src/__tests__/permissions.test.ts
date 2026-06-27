import {
  LocalEnvironment,
  ReadFileTool,
  Toolset,
  type AgentContext,
} from '@ello/agent';
import { describe, expect, it } from 'vitest';


import {
  PermissionToolset,
  evaluateToolPermission,
  formatPermissionRules,
} from '../permissions.js';

describe('permissions', () => {
  it('applies deny rules before approval mode defaults', () => {
    const decision = evaluateToolPermission(
      {
        approvalMode: 'never',
        cwd: '/repo',
        allowedPaths: ['/repo'],
        rules: [{ tool: 'shell_exec', action: 'deny', command: 'rm -rf' }],
      },
      'shell_exec',
      { command: 'rm -rf dist' },
    );

    expect(decision.action).toBe('deny');
  });

  it('asks for mutating tools in on-request mode', () => {
    expect(
      evaluateToolPermission(
        { approvalMode: 'on-request', cwd: '/repo', allowedPaths: ['/repo'], rules: [] },
        'write_file',
        { path: 'src/index.ts' },
      ).action,
    ).toBe('ask');
  });

  it('allows read-only file tools inside allowed paths', () => {
    const decision = evaluateToolPermission(
      { approvalMode: 'on-request', cwd: '/repo', allowedPaths: ['/repo'], rules: [] },
      'read_file',
      { path: 'src/index.ts' },
    );

    expect(decision.action).toBe('allow');
  });

  it('asks before reading outside allowed paths', () => {
    const decision = evaluateToolPermission(
      { approvalMode: 'on-request', cwd: '/repo', allowedPaths: ['/repo/src'], rules: [] },
      'read_file',
      { path: '../secrets.txt' },
    );

    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain('outside allowedPaths');
  });

  it('asks when any move/copy endpoint crosses allowed paths', () => {
    const decision = evaluateToolPermission(
      { approvalMode: 'on-request', cwd: '/repo', allowedPaths: ['/repo/src'], rules: [] },
      'move_copy',
      { source: 'src/input.ts', destination: '/tmp/input.ts', copy: true },
    );

    expect(decision.action).toBe('ask');
  });

  it('matches explicit path rules against any path-bearing argument', () => {
    const decision = evaluateToolPermission(
      {
        approvalMode: 'on-request',
        cwd: '/repo',
        allowedPaths: ['/repo'],
        rules: [{ tool: 'move_copy', action: 'deny', path: 'src/private' }],
      },
      'move_copy',
      { source: 'src/public/a.ts', destination: 'src/private/a.ts' },
    );

    expect(decision.action).toBe('deny');
  });

  it('formats configured rules', () => {
    expect(
      formatPermissionRules([{ tool: 'shell_exec', action: 'ask', command: 'git push' }]),
    ).toContain('shell_exec');
  });

  it('keeps allowed path decisions in the permission toolset wrapper', async () => {
    const env = new LocalEnvironment({
      defaultPath: '/repo',
      allowedPaths: ['/repo/src'],
    });
    await env.enter();
    try {
      const toolset = new PermissionToolset(
        new Toolset({ tools: [ReadFileTool] }),
        {
          approvalMode: 'on-request',
          cwd: '/repo',
          allowedPaths: ['/repo/src'],
          rules: [],
        },
      );
      const ctx = {
        deps: {
          env,
          toolConfig: {
            viewMaxTextFileSize: 1024 * 1024,
          },
        } as AgentContext,
      };

      const tools = await toolset.getTools(ctx);
      expect(tools.read_file?.requiresApproval).toBe(false);
      expect(
        evaluateToolPermission(
          {
            approvalMode: 'on-request',
            cwd: '/repo',
            allowedPaths: ['/repo/src'],
            rules: [],
          },
          'read_file',
          { path: '/tmp/secrets.txt' },
        ).action,
      ).toBe('ask');
    } finally {
      await env.exit();
    }
  });
});
