import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram, type CliIo } from '../cli/main.js';

const runtime = vi.hoisted(() => {
  let listener:
    | ((event: {
        readonly type: 'memory.dream.completed';
        readonly jobId: string;
        readonly changes: number;
        readonly summary: string;
      }) => void)
    | undefined;
  const close = vi.fn(async () => {});
  return {
    close,
    session: {
      subscribe(next: typeof listener) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async dream() {
        queueMicrotask(() => {
          if (listener === undefined) {
            throw new Error('Dream completion listener is not registered.');
          }
          listener({
            type: 'memory.dream.completed',
            jobId: 'dream-1',
            changes: 3,
            summary: 'Memory consolidated.',
          });
        });
        return { id: 'dream-1' };
      },
      close,
    },
  };
});

vi.mock('../runtime/index.js', () => ({
  createCodingSession: async () => runtime.session,
}));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('memory CLI commands', () => {
  it('registers memory actions and the durable dream command', () => {
    const { io } = fakeIo();
    const program = buildProgram(io);
    const memory = program.commands.find(
      (command) => command.name() === 'memory',
    );
    const dream = program.commands.find(
      (command) => command.name() === 'dream',
    );

    expect(memory?.usage()).toContain('[action]');
    expect(dream?.description()).toContain('durable job');
  });

  it('keeps memory status available when file memory is disabled', async () => {
    const cwd = await disabledMemoryWorkspace();
    const { io, out } = fakeIo();

    await buildProgram(io).parseAsync(['--cwd', cwd, 'memory', 'status'], {
      from: 'user',
    });

    expect(out()).toContain('disabled');
    expect(out()).toContain('private');
    expect(out()).toContain('team');
  });

  it('fails fast when reload or dream is requested while disabled', async () => {
    const cwd = await disabledMemoryWorkspace();
    const { io } = fakeIo();

    await expect(
      buildProgram(io).parseAsync(['--cwd', cwd, 'memory', 'reload'], {
        from: 'user',
      }),
    ).rejects.toThrow('Memory is disabled');
    await expect(
      buildProgram(io).parseAsync(['--cwd', cwd, 'dream'], { from: 'user' }),
    ).rejects.toThrow('Memory is disabled');
  });

  it('reloads and validates both memory indexes', async () => {
    const cwd = await memoryWorkspace(true);
    const { io, out } = fakeIo();

    await buildProgram(io).parseAsync(['--cwd', cwd, 'memory', 'reload'], {
      from: 'user',
    });

    expect(out()).toContain('Memory index reloaded.');
    expect(out()).toContain(path.join(cwd, '.ello', 'memory', 'private'));
    expect(out()).toContain(path.join(cwd, '.ello', 'memory', 'team'));
  });

  it('waits for a durable dream job to complete before closing', async () => {
    const cwd = await memoryWorkspace(true);
    const { io, out } = fakeIo();

    await buildProgram(io).parseAsync(['--cwd', cwd, 'dream'], {
      from: 'user',
    });

    expect(out()).toContain('Dream job dream-1 completed.');
    expect(out()).toContain('Memory consolidated.');
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});

async function disabledMemoryWorkspace(): Promise<string> {
  return memoryWorkspace(false);
}

async function memoryWorkspace(enabled: boolean): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ello-memory-cli-'));
  directories.push(directory);
  const configDirectory = path.join(directory, '.ello');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, 'config.yaml'),
    [
      'context:',
      '  memory:',
      `    enabled: ${String(enabled)}`,
      '    private_dir: .ello/memory/private',
      '    team_dir: .ello/memory/team',
      '',
    ].join('\n'),
    'utf8',
  );
  return directory;
}

function fakeIo(): { io: CliIo; out: () => string } {
  let output = '';
  return {
    io: {
      stdout: { write: (chunk: string) => ((output += chunk), true) },
      stderr: { write: () => true },
    },
    out: () => output,
  };
}
