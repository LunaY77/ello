import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram, type CliIo } from '../cli/main.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** 收集 stdout/stderr 的假 IO。 */
function fakeIo(): { io: CliIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: { write: (chunk: string) => ((err += chunk), true) },
    },
    out: () => out,
    err: () => err,
  };
}

describe('cli buildProgram', () => {
  it('registers the commander goal command with session and token options', () => {
    const { io } = fakeIo();
    const goal = buildProgram(io).commands.find(
      (command) => command.name() === 'goal',
    );

    expect(goal).toBeDefined();
    expect(goal?.options.map((option) => option.long)).toEqual([
      '--tokens',
      '--session',
    ]);
  });

  it('lists tools', async () => {
    const { io, out } = fakeIo();
    await buildProgram(io).parseAsync(['tools'], { from: 'user' });
    expect(out().length).toBeGreaterThan(0);
    expect(out()).toMatch(/read|write|bash/u);
  });

  it('prints merged config as JSON with --json config get', async () => {
    const cwd = await tempDir();
    const { io, out } = fakeIo();
    await buildProgram(io).parseAsync(['--cwd', cwd, 'config', 'get'], {
      from: 'user',
    });
    const parsed = JSON.parse(out()) as { active_profile: string };
    expect(parsed.active_profile).toBe('main');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-cli-'));
  dirs.push(dir);
  return dir;
}
