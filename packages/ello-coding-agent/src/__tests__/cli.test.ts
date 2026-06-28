import { describe, expect, it } from 'vitest';

import { buildProgram, type CliIo } from '../cli/main.js';

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
  it('lists tools', async () => {
    const { io, out } = fakeIo();
    await buildProgram(io).parseAsync(['tools'], { from: 'user' });
    expect(out().length).toBeGreaterThan(0);
    expect(out()).toMatch(/read|write|bash/u);
  });

  it('prints merged config as JSON with --json config get', async () => {
    const { io, out } = fakeIo();
    await buildProgram(io).parseAsync(['config', 'get'], { from: 'user' });
    const parsed = JSON.parse(out()) as { model: string };
    expect(typeof parsed.model).toBe('string');
  });
});
