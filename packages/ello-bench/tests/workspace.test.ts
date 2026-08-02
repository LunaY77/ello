import { describe, expect, it } from 'vitest';

import {
  dockerContainerUserInitArgs,
  dockerRunArgs,
} from '../src/infra/container/docker.js';
import { runChecked } from '../src/infra/process.js';
import { CONTAINER_RUNTIME_PROBE_COMMAND } from '../src/infra/workspace.js';
import type { ContainerSpec } from '../src/ports/container.js';

const PROCESS_OPTIONS = {
  timeoutMs: 30_000,
  killGraceMs: 1_000,
  maxOutputBytes: 1024 * 1024,
} as const;

describe('task container Docker arguments', () => {
  it('renders the runtime probe as three lines', async () => {
    const [command, ...args] = CONTAINER_RUNTIME_PROBE_COMMAND;
    const home = '/tmp/ello-bench-home';
    const probe = await runChecked(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      ...PROCESS_OPTIONS,
    });

    expect(probe.stdout.split('\n')).toEqual([
      process.cwd(),
      `${process.getuid?.()}:${process.getgid?.()}`,
      home,
      '',
    ]);
  });

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

  it('initializes image-owned toolchains without changing task uid', () => {
    const args = dockerContainerUserInitArgs(
      'ello-bench-job-agent',
      '1000:1000',
      '/tmp/ello-bench-home',
    );

    expect(args.slice(0, 6)).toEqual([
      'exec',
      '--user',
      '0:0',
      '--workdir',
      '/',
      'ello-bench-job-agent',
    ]);
    expect(args.at(-4)).toContain('chmod o+x /root');
    expect(args.at(-4)).toContain('ln -s /root/.rustup');
    expect(args.at(-4)).toContain('ln -s "/root/.cargo/$name"');
    expect(args.at(-2)).toBe('/tmp/ello-bench-home');
    expect(args.at(-1)).toBe('1000:1000');
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
