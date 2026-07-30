import { mkdir, readdir } from 'node:fs/promises';

export async function ensureEmptyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length !== 0) {
    throw new Error(`Directory must be empty: ${directory}`);
  }
}
