import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactStore } from '../../ports/artifact-store.js';
import { writeJsonAtomic } from '../io.js';

export const fsArtifactStore: ArtifactStore = {
  writeJson: writeJsonAtomic,
  async writeText(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, 'utf8');
  },
  read: readFile,
};
