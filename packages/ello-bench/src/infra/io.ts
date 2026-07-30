import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

export async function readJsonFile<T extends z.ZodType>(
  filePath: string,
  schema: T,
): Promise<z.output<T>> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return schema.parse(parsed);
}

export async function writeJsonLines(
  filePath: string,
  values: readonly unknown[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = values.map((value) => JSON.stringify(value)).join('\n');
  await writeFile(filePath, content === '' ? '' : `${content}\n`, 'utf8');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
