import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

/**
 * 流式计算文件的 sha256，不把整个文件读进内存。
 *
 * 证据文件可以到几百 MB；先读成 Buffer 再 hash 只是为了校验，没有必要占住那么多内存。
 *
 * Args:
 * - `filePath`: 待校验文件的路径。
 *
 * Returns:
 * - Promise 兑现为十六进制摘要，与 `sha256(buffer)` 结果一致。
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest('hex');
}

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
