import { describe, expect, it } from 'vitest';

import { createDockerShell } from '../src/docker-shell.js';

describe('Docker shell', () => {
  it('executes the command in the mapped job container directory', async () => {
    const calls: Array<{
      readonly args: ReadonlyArray<string>;
      readonly timeout: number | undefined;
    }> = [];
    const records: unknown[] = [];
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async (args, timeout) => {
        calls.push({ args, timeout });
        return { stdout: 'ok', stderr: '' };
      },
      record: async (event) => {
        records.push(event);
      },
    });

    await expect(
      shell.run('npm test', {
        cwd: '/work/job/packages/core',
        timeout: 200,
        env: { NODE_ENV: 'test' },
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    });

    // 容器内 timeout 包住整条命令；宿主超时留出余量，确保容器内超时先触发。
    expect(calls).toEqual([
      {
        args: [
          'exec',
          '--workdir',
          '/app/packages/core',
          '--env',
          'NODE_ENV=test',
          'job-container',
          'timeout',
          '--signal=TERM',
          '--kill-after=5s',
          '0.2s',
          'sh',
          '-lc',
          'npm test',
        ],
        timeout: 20_200,
      },
    ]);
    expect(records).toHaveLength(1);
  });

  it('omits the container timeout prefix when no timeout is requested', async () => {
    const calls: Array<{
      readonly args: ReadonlyArray<string>;
      readonly timeout: number | undefined;
    }> = [];
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async (args, timeout) => {
        calls.push({ args, timeout });
        return { stdout: '', stderr: '' };
      },
    });

    await shell.run('pwd');

    expect(calls[0]?.args).toEqual([
      'exec',
      '--workdir',
      '/app',
      'job-container',
      'sh',
      '-lc',
      'pwd',
    ]);
    expect(calls[0]?.timeout).toBeUndefined();
  });

  it('preserves the image environment for SWE-bench Pro commands', async () => {
    const calls: ReadonlyArray<string>[] = [];
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'preserve-environment',
      execute: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      },
    });

    await shell.run('go test ./...');

    expect(calls[0]?.slice(-3)).toEqual(['sh', '-c', 'go test ./...']);
  });

  it('reports a container-side timeout exit code as a timeout', async () => {
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async () => {
        // 容器内 timeout(1) 因超时终止命令后返回 124，该码经 docker CLI 穿透。
        const error = Object.assign(new Error('exit 124'), {
          code: 124,
          stdout: 'partial output',
          stderr: '',
        });
        throw error;
      },
    });

    await expect(
      shell.run('npx vitest run', { timeout: 120_000 }),
    ).resolves.toEqual({
      exitCode: 124,
      stdout: 'partial output',
      stderr: '',
      timedOut: true,
    });
  });

  it('never reports a timed-out command as a successful empty run', async () => {
    // 回归：宿主超时只能向 docker CLI 发 SIGTERM，CLI 以 0 干净退出且不带
    // signal，execFile 因此 resolve。若超时仍由宿主施加，调用方会看到
    // exitCode 0 与空输出，把被杀的命令误判为成功并原样重跑。
    const calls: Array<ReadonlyArray<string>> = [];
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      },
    });

    await shell.run('npx vitest run', { timeout: 120_000 });

    expect(calls[0]).toContain('timeout');
    expect(calls[0]).toContain('120s');
  });

  it('rejects a cwd outside the job workspace before process execution', async () => {
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async () => ({ stdout: '', stderr: '' }),
    });

    await expect(shell.run('pwd', { cwd: '/work/other' })).rejects.toThrow(
      'escapes job workspace',
    );
  });

  it('returns command exit status without converting it to an infrastructure failure', async () => {
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async () => {
        const error = Object.assign(new Error('failed'), {
          code: 3,
          stdout: 'output',
          stderr: 'failure',
        });
        throw error;
      },
    });

    await expect(shell.run('exit 3')).resolves.toEqual({
      exitCode: 3,
      stdout: 'output',
      stderr: 'failure',
      timedOut: false,
    });
  });

  it('returns an explicit timeout result when Docker kills the command', async () => {
    const shell = createDockerShell({
      containerName: 'job-container',
      hostWorkspace: '/work/job',
      containerWorkspace: '/app',
      shellMode: 'login',
      execute: async () => {
        const error = Object.assign(new Error('timed out'), {
          code: null,
          killed: true,
          stdout: 'partial output',
          stderr: 'partial diagnostics',
        });
        throw error;
      },
    });

    // 超时前已产出的 stderr 是唯一的失败线索，不能被 'timeout' 字面量覆盖；
    // 超时事实由 timedOut 单独承载。
    await expect(shell.run('sleep 10', { timeout: 1 })).resolves.toEqual({
      exitCode: -1,
      stdout: 'partial output',
      stderr: 'partial diagnostics',
      timedOut: true,
    });
  });
});
