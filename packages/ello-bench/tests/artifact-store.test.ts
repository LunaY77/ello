import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fsArtifactStore } from '../src/infra/artifact/fs.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('filesystem artifact store', () => {
  it('creates parent directories for text and JSON artifacts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-store-'));
    directories.push(directory);
    const textPath = path.join(directory, 'raw', 'task', 'instruction.md');
    const jsonPath = path.join(directory, 'raw', 'task', 'resolved.json');

    await fsArtifactStore.writeText(textPath, 'instruction\n');
    await fsArtifactStore.writeJson(jsonPath, { valid: true });

    await expect(fsArtifactStore.read(textPath)).resolves.toEqual(
      Buffer.from('instruction\n'),
    );
    await expect(fsArtifactStore.read(jsonPath)).resolves.toEqual(
      Buffer.from('{\n  "valid": true\n}\n'),
    );
  });
});
