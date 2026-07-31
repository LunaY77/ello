/**
 * 验证 Local Environment 的身份、Handle 与受管进程生命周期。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalEnvironments,
  LOCAL_HOST_ENVIRONMENT_REFERENCE,
  type EnvironmentHandle,
  type Environments,
} from '../../src/features/environment/index.js';

const roots: string[] = [];
const adapters: Environments[] = [];

afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential('Local Environment', () => {
  it('attaches one stable generation and exposes honest host access', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const external = path.join(root, 'external');
    await Promise.all([mkdir(workspace), mkdir(external)]);
    await writeFile(path.join(external, 'context.ts'), 'external\n', 'utf8');
    const { adapter, handle } = await attach(workspace);

    expect(handle).toMatchObject({
      environmentRef: LOCAL_HOST_ENVIRONMENT_REFERENCE,
      generation: 1,
      workingDirectory: workspace,
      grant: { isolation: 'none' },
    });
    await expect(handle.fileSystem.readText('../external/context.ts')).resolves
      .toBe('external\n');
    await expect(handle.getInstructions()).resolves.toContain(
      '<isolation>none</isolation>',
    );

    await handle.fileSystem.writeText('empty/file.txt', 'content');
    await handle.fileSystem.remove('empty/file.txt');
    await handle.fileSystem.remove('empty');
    await expect(handle.fileSystem.stat('empty')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await handle.close();
    expect(() => handle.fileSystem.resolvePath('.')).toThrow(
      'Environment Handle is closed',
    );
    await expect(handle.processes.exec(command('true'))).rejects.toThrow(
      'Environment Handle is closed',
    );
    await adapter.close();
  });

  it('exec captures split output and enforces max runtime on the process tree', async () => {
    const root = await temporaryRoot();
    const { handle } = await attach(root);
    const result = await handle.processes.exec({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("out"); process.stderr.write("err")',
      ],
      maxRuntimeMs: 10_000,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(text(result.stdout.data)).toBe('out');
    expect(text(result.stderr.data)).toBe('err');

    const timedOut = await handle.processes.exec({
      command: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
      ],
      maxRuntimeMs: 50,
    });
    expect(timedOut).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
    });
  });

  it('cancellation escalates to kill without being reported as a timeout', async () => {
    const root = await temporaryRoot();
    const { handle } = await attach(root);
    const controller = new AbortController();
    const execution = handle.processes.exec({
      command: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
      ],
      maxRuntimeMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort('test cancellation'), 50).unref();

    await expect(execution).resolves.toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: false,
    });
  });

  it('allows cancellation to race with Handle close without leaking registry errors', async () => {
    const root = await temporaryRoot();
    const { handle } = await attach(root);
    const controller = new AbortController();
    const execution = handle.processes.exec({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      maxRuntimeMs: 60_000,
      signal: controller.signal,
    });

    const closing = handle.close();
    controller.abort('concurrent close');

    await expect(closing).resolves.toBeUndefined();
    await expect(execution).resolves.toMatchObject({ timedOut: false });
  });

  it('manages background stdin and incremental bounded output by reference', async () => {
    const root = await temporaryRoot();
    const { handle } = await attach(root, { processOutputLimitBytes: 5 });
    const ref = await handle.processes.spawn({
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.on("data", x => { process.stdout.write("0123456789"); process.stderr.write(x) });',
      ],
      lifecycle: 'background',
      maxRuntimeMs: 10_000,
    });
    await handle.processes.write(ref, Buffer.from('input'));
    await handle.processes.closeStdin(ref);
    await expect(handle.processes.wait(ref)).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });

    const first = await handle.processes.inspect(ref, { maxBytes: 3 });
    expect(first.status).toBe('exited');
    expect(first.stdout).toMatchObject({
      cursor: 5,
      nextCursor: 8,
      totalBytes: 10,
      truncatedBytes: 5,
      complete: false,
    });
    expect(text(first.stdout.data)).toBe('567');
    expect(text(first.stderr.data)).toBe('inp');

    const second = await handle.processes.inspect(ref, {
      stdoutCursor: first.stdout.nextCursor,
      stderrCursor: first.stderr.nextCursor,
      maxBytes: 3,
    });
    expect(text(second.stdout.data)).toBe('89');
    expect(second.stdout).toMatchObject({ nextCursor: 10, complete: true });
    expect(text(second.stderr.data)).toBe('ut');
    expect(second.stderr).toMatchObject({ nextCursor: 5, complete: true });
  });

  it('closes attached processes with their Handle but keeps bounded background work', async () => {
    const root = await temporaryRoot();
    const { adapter, handle } = await attach(root);
    const attachedRef = await handle.processes.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      lifecycle: 'attached',
    });
    const backgroundRef = await handle.processes.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      lifecycle: 'background',
      maxRuntimeMs: 10_000,
    });
    await handle.close();

    const next = await adapter.attach(
      {
        environmentRef: LOCAL_HOST_ENVIRONMENT_REFERENCE,
        workingDirectory: root,
      },
      { isolation: 'none' },
    );
    await expect(next.processes.inspect(attachedRef)).rejects.toThrow(
      'Unknown process reference',
    );
    await expect(next.processes.inspect(backgroundRef)).resolves.toMatchObject({
      status: 'running',
    });
    await next.processes.signal(backgroundRef, 'SIGKILL');
    await expect(next.processes.wait(backgroundRef)).resolves.toMatchObject({
      signal: 'SIGKILL',
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-environment-'));
  roots.push(root);
  return root;
}

async function attach(
  workingDirectory: string,
  options: { readonly processOutputLimitBytes?: number } = {},
): Promise<{ readonly adapter: Environments; readonly handle: EnvironmentHandle }> {
  const adapter = createLocalEnvironments(options);
  adapters.push(adapter);
  const handle = await adapter.attach(
    {
      environmentRef: LOCAL_HOST_ENVIRONMENT_REFERENCE,
      workingDirectory,
    },
    { isolation: 'none' },
  );
  return { adapter, handle };
}

function command(value: string) {
  return { command: value, maxRuntimeMs: 10_000 };
}

function text(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8');
}
