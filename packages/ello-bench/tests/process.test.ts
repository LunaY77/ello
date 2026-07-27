import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runProcess } from '../src/process.js';

describe('process runner', () => {
  it('terminates a timed-out process', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-process-'));
    const stdoutPath = path.join(root, 'stdout.log');
    const stderrPath = path.join(root, 'stderr.log');
    const execution = await runProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        cwd: root,
        timeoutMs: 100,
        killGraceMs: 100,
        capture: false,
        stdoutPath,
        stderrPath,
      },
    );

    expect(execution.result.timedOut).toBe(true);
    expect(await readFile(stdoutPath, 'utf8')).toBe('');
    expect(await readFile(stderrPath, 'utf8')).toBe('');
  });

  it('preserves streamed output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-process-'));
    const stdoutPath = path.join(root, 'stdout.log');
    const stderrPath = path.join(root, 'stderr.log');
    const execution = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("ready\\n")'],
      {
        cwd: root,
        timeoutMs: 10_000,
        killGraceMs: 100,
        capture: false,
        stdoutPath,
        stderrPath,
      },
    );

    expect(execution.result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await readFile(stdoutPath, 'utf8')).toBe('ready\n');
    expect(await readFile(stderrPath, 'utf8')).toBe('');
  });

  it('terminates the process when streamed output cannot be written', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-process-'));

    await expect(
      runProcess(
        process.execPath,
        ['-e', 'setInterval(() => process.stdout.write("data\\n"), 10)'],
        {
          cwd: root,
          timeoutMs: 10_000,
          killGraceMs: 100,
          capture: false,
          stdoutPath: root,
          stderrPath: path.join(root, 'stderr.log'),
        },
      ),
    ).rejects.toThrow();
  });
});
