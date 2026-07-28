/**
 * 验证产品运行环境的动态 session mode 与路径授权保持一致。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CodingAgentConfig } from '../../src/features/config/index.js';
import { createRuntimeEnvironment } from '../../src/features/environment/index.js';
import type { SessionMode } from '../../src/protocol/v1/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('runtime environment', () => {
  it('allows external paths only while the shared mode is bypass', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-environment-'));
    roots.push(root);
    const cwd = path.join(root, 'workspace');
    const external = path.join(root, 'outside');
    await mkdir(cwd);
    await mkdir(external);
    const externalFile = path.join(external, 'context.ts');
    await writeFile(externalFile, 'export const context = true;\n', 'utf8');
    let mode: SessionMode = 'ask-before-changes';
    const environment = createRuntimeEnvironment(
      { cwd } as CodingAgentConfig,
      () => [],
      () => [],
      () => mode,
      () => [],
    );
    const fileSystem = environment.fileSystem;
    if (fileSystem === undefined) {
      throw new Error('Runtime environment did not provide a file system.');
    }

    try {
      expect(() => fileSystem.readText(externalFile)).toThrow(
        `Path not allowed: ${externalFile}`,
      );

      mode = 'bypass';
      await expect(fileSystem.readText(externalFile)).resolves.toBe(
        'export const context = true;\n',
      );
      await expect(fileSystem.listDir(external)).resolves.toEqual([
        'context.ts',
      ]);

      mode = 'ask-before-changes';
      await expect(fileSystem.listDir(external)).rejects.toThrow(
        `Path not allowed: ${external}`,
      );
    } finally {
      await environment.close?.();
    }
  });
});
