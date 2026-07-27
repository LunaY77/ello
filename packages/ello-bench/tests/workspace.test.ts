import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/contracts.js';
import { taskContainerDockerArgs } from '../src/workspace.js';

const ENVIRONMENT = {
  image: 'example.invalid/swe-bench:task',
  allowInternet: false,
  buildTimeoutMs: 1_800_000,
  cpus: 2,
  memoryMb: 8192,
  storageMb: 20480,
} as const;

describe('task container Docker arguments', () => {
  it('runs the agent container as the host user so the shared Git repository stays writable', () => {
    const args = taskContainerDockerArgs({
      containerName: 'ello-bench-abc-agent',
      workspace: '/runs/job/workspace',
      network: 'none',
      containerUser: '1000:1000',
      task: resolvedTask('deep-swe'),
    });

    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
    expect(args).toContain('type=bind,source=/runs/job/workspace,target=/app');
  });

  it('redirects HOME to a writable container path', () => {
    const args = taskContainerDockerArgs({
      containerName: 'ello-bench-abc-agent',
      workspace: '/runs/job/workspace',
      network: 'bridge',
      containerUser: '1000:1000',
      task: resolvedTask('deep-swe'),
    });

    const home = args[args.indexOf('--env') + 1];
    expect(home).toBe('HOME=/tmp/ello-bench-home');
    expect(home).not.toContain('/root');
  });

  it('starts SWE-bench Pro without a login shell', () => {
    const args = taskContainerDockerArgs({
      containerName: 'ello-bench-abc-agent',
      workspace: '/runs/job/workspace',
      network: 'none',
      containerUser: '1000:1000',
      task: resolvedTask('swe-bench-pro'),
    });

    expect(args.slice(-4)).toEqual([
      '/bin/bash',
      ENVIRONMENT.image,
      '-c',
      'sleep infinity',
    ]);
  });
});

function resolvedTask(benchmark: ResolvedTask['benchmark']): ResolvedTask {
  return { benchmark, environment: ENVIRONMENT } as ResolvedTask;
}
