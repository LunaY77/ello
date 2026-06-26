import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentContext,
  ListDirTool,
  LocalEnvironment,
  ReadFileTool,
  ShellExecTool,
  Toolset,
  WriteFileTool,
  type ToolRunContext,
} from '../index.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'ello-tools-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function withCtx<T>(fn: (ctx: ToolRunContext) => Promise<T>): Promise<T> {
  const env = new LocalEnvironment({
    defaultPath: tempDir,
    allowedPaths: [tempDir],
  });
  await env.enter();
  try {
    return await fn({ deps: new AgentContext({ env }) });
  } finally {
    await env.exit();
  }
}

describe('ShellExecTool', () => {
  it('is available when shell exists', async () => {
    await withCtx(async (ctx) => {
      expect(new ShellExecTool().isAvailable(ctx)).toBe(true);
    });
  });

  it('runs commands', async () => {
    await withCtx(async (ctx) => {
      const result = await new ShellExecTool().call(ctx, {
        command: 'echo hello',
      });

      expect(result.return_code).toBe(0);
      expect(String(result.stdout)).toContain('hello');
    });
  });

  it('rejects empty command', async () => {
    await withCtx(async (ctx) => {
      const result = await new ShellExecTool().call(ctx, { command: '' });

      expect(result.return_code).toBe(1);
      expect(String(result.error).toLowerCase()).toContain('empty');
    });
  });
});

describe('ReadFileTool', () => {
  it('reads file content', async () => {
    await writeFile(
      path.join(tempDir, 'test.txt'),
      'line1\nline2\nline3\n',
      'utf8',
    );

    await withCtx(async (ctx) => {
      const result = await new ReadFileTool().call(ctx, { path: 'test.txt' });

      expect(String(result)).toContain('line1');
      expect(String(result)).toContain('line2');
    });
  });

  it('returns not found error', async () => {
    await withCtx(async (ctx) => {
      const result = await new ReadFileTool().call(ctx, {
        path: 'nonexistent.txt',
      });

      expect(String(result).toLowerCase()).toContain('not found');
    });
  });

  it('supports pagination', async () => {
    const lines = Array.from(
      { length: 100 },
      (_, index) => `line ${index}\n`,
    ).join('');
    await writeFile(path.join(tempDir, 'big.txt'), lines, 'utf8');

    await withCtx(async (ctx) => {
      const result = await new ReadFileTool().call(ctx, {
        path: 'big.txt',
        lineOffset: 10,
        lineLimit: 5,
      });

      expect(result).toMatchObject({
        start_line: 11,
        has_more: true,
      });
    });
  });
});

describe('WriteFileTool', () => {
  it('writes file content', async () => {
    await withCtx(async (ctx) => {
      const result = await new WriteFileTool().call(ctx, {
        path: 'output.txt',
        content: 'hello world',
      });

      expect(result).toContain('Successfully');
    });

    await expect(
      readFile(path.join(tempDir, 'output.txt'), 'utf8'),
    ).resolves.toBe('hello world');
  });
});

describe('ListDirTool', () => {
  it('lists directory content', async () => {
    await writeFile(path.join(tempDir, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(tempDir, 'b.txt'), 'b', 'utf8');
    await mkdir(path.join(tempDir, 'subdir'));

    await withCtx(async (ctx) => {
      const result = await new ListDirTool().call(ctx, { path: '.' });

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
      expect(result.entries).toContain('a.txt');
    });
  });

  it('is superseded by shell tools', async () => {
    await withCtx(async (ctx) => {
      const ts = new Toolset({ tools: [ShellExecTool, ListDirTool] });
      const tools = await ts.getTools(ctx);

      expect(tools).toHaveProperty('shell_exec');
      expect(tools).not.toHaveProperty('list_dir');
    });
  });
});
