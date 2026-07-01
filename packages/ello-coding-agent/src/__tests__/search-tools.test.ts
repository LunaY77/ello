import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentFileSystem } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import type { CodingToolContext } from '../tools/runtime/coding-tool.js';
import { createSearchTools } from '../tools/search.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-search-'));
  dirs.push(dir);
  return dir;
}

describe('search tools', () => {
  it('grep limits returned matches', async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, 'a.txt'),
      ['hit one', 'hit two', 'hit three'].join('\n'),
      'utf8',
    );
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir: await tempDir(),
      approvalMode: 'bypass',
    });
    const grep = createSearchTools(config, () => () => 'approved').find(
      (tool) => tool.name === 'grep',
    );
    if (grep === undefined) {
      throw new Error('grep tool missing');
    }

    const result = await grep.execute(
      { pattern: 'hit', path: '.', limit: 2 },
      searchContext(config.cwd),
    );

    expect(result.output.split('\n')).toHaveLength(2);
    expect(result.metadata.matchCount).toBe(2);
  });

  it('grep reports no matches as an empty successful result', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'a.txt'), 'hello\n', 'utf8');
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir: await tempDir(),
      approvalMode: 'bypass',
    });
    const grep = createSearchTools(config, () => () => 'approved').find(
      (tool) => tool.name === 'grep',
    );
    if (grep === undefined) {
      throw new Error('grep tool missing');
    }

    const result = await grep.execute(
      { pattern: 'missing', path: '.', limit: 2 },
      searchContext(config.cwd),
    );

    expect(result.output).toBe('');
    expect(result.metadata.matchCount).toBe(0);
  });

  it('grep treats pattern as a regular expression', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'a.txt'), 'abc-123\nabc-xyz\n', 'utf8');
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir: await tempDir(),
      approvalMode: 'bypass',
    });
    const grep = createSearchTools(config, () => () => 'approved').find(
      (tool) => tool.name === 'grep',
    );
    if (grep === undefined) {
      throw new Error('grep tool missing');
    }

    const result = await grep.execute(
      { pattern: 'abc-\\d+', path: '.', limit: 10 },
      searchContext(config.cwd),
    );

    expect(result.output).toContain('a.txt:1:abc-123');
    expect(result.output).not.toContain('abc-xyz');
    expect(result.metadata.matchCount).toBe(1);
  });
});

function searchContext(cwd: string): CodingToolContext {
  const fileSystem = testFileSystem(cwd);
  return {
    cwd,
    allowedPaths: [cwd],
    sessionId: 'session',
    runId: 'run',
    callId: 'call',
    agent: {
      runId: 'run',
      toolCallId: 'call',
      toolName: 'grep',
      environment: { fileSystem, files: fileSystem },
      metadata: {},
    },
  };
}

function testFileSystem(cwd: string): AgentFileSystem & {
  resolvePath(targetPath: string): string;
  stat(targetPath: string): ReturnType<typeof stat>;
} {
  return {
    resolvePath(targetPath): string {
      return path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(cwd, targetPath);
    },
    async readText(targetPath): Promise<string> {
      return readFile(this.resolvePath(targetPath), 'utf8');
    },
    async writeText(): Promise<void> {
      throw new Error('search test file system does not support writes.');
    },
    async listDir(targetPath): Promise<string[]> {
      return readdir(this.resolvePath(targetPath));
    },
    stat(targetPath) {
      return stat(this.resolvePath(targetPath));
    },
  };
}
