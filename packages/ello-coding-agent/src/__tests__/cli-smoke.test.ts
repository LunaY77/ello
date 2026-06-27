import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../cli.js';

function captureIo(): { io: CliIo; stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: {
        write: (chunk: string | Uint8Array) => {
          out += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          err += String(chunk);
          return true;
        },
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe('runCli smoke', () => {
  it('prints help without starting the TUI', async () => {
    const io = captureIo();

    await runCli(['--help'], io.io);

    expect(io.stdout()).toContain('ello run <prompt>');
    expect(io.stderr()).toBe('');
  });

  it('runs slash commands through the non-interactive command path', async () => {
    const io = captureIo();

    await runCli(['run', '--json', '/tools'], io.io);

    expect(io.stdout()).toContain('read_file');
    expect(io.stdout()).toContain('shell_exec');
    expect(io.stderr()).toBe('');
  });
});
