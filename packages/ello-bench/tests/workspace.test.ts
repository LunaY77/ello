import { describe, expect, it } from 'vitest';

import { dockerRunArgs } from '../src/infra/container/docker.js';
import type { ContainerSpec } from '../src/ports/container.js';

describe('task container Docker arguments', () => {
  it('enforces the task network, resource, user, and workspace contract', () => {
    const args = dockerRunArgs(containerSpec());

    expect(option(args, '--network')).toBe('none');
    expect(option(args, '--cpus')).toBe('2');
    expect(option(args, '--memory')).toBe('8192m');
    expect(args).not.toContain('--storage-opt');
    expect(option(args, '--user')).toBe('1000:1000');
    expect(option(args, '--workdir')).toBe('/app');
    expect(args).toContain('type=bind,source=/runs/job/workspace,target=/app');
    expect(args).toContain('HOME=/tmp/ello-bench-home');
  });

  it('exposes storage as a bind-workspace watchdog policy', () => {
    const spec = containerSpec();
    expect(spec.storageMb).toBe(20480);
  });

  it('uses the declared image entrypoint and long-running command', () => {
    const args = dockerRunArgs(containerSpec());

    expect(option(args, '--entrypoint')).toBe('/bin/bash');
    expect(args.slice(-2)).toEqual([
      'example.invalid/swe-bench:task',
      'sleep infinity',
    ]);
  });

  it('maps internet-enabled tasks to the bridge network', () => {
    const args = dockerRunArgs({ ...containerSpec(), network: 'bridge' });

    expect(option(args, '--network')).toBe('bridge');
  });
});

function containerSpec(): ContainerSpec {
  return {
    image: 'example.invalid/swe-bench:task',
    name: 'ello-bench-abc-agent',
    workspaceMount: {
      host: '/runs/job/workspace',
      container: '/app',
    },
    network: 'none',
    cpus: 2,
    memoryMb: 8192,
    storageMb: 20480,
    env: { HOME: '/tmp/ello-bench-home' },
    user: { uid: 1000, gid: 1000 },
    entrypoint: '/bin/bash',
    command: ['sleep infinity'],
  };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
