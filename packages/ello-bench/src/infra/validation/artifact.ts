import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../domain/hash.js';

export function assertInside(root: string, target: string): void {
  const relative = path.relative(root, path.resolve(target));
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Attempt path escapes run root: ${target}`);
  }
}

export async function readReferencedJson<
  TSchema extends { parse(value: unknown): unknown },
>(
  attemptRoot: string,
  reference: { readonly path: string; readonly sha256: string },
  schema: TSchema,
): Promise<ReturnType<TSchema['parse']>> {
  assertInside(attemptRoot, reference.path);
  const content = await readFile(reference.path);
  if (sha256(content) !== reference.sha256) {
    throw new Error(`Artifact checksum mismatch: ${reference.path}`);
  }
  return schema.parse(
    JSON.parse(content.toString('utf8')) as unknown,
  ) as ReturnType<TSchema['parse']>;
}

export async function validateFileEvidence(
  attemptRoot: string,
  file: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  },
): Promise<void> {
  assertInside(attemptRoot, file.path);
  const content = await readFile(file.path);
  if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
    throw new Error(`File evidence mismatch: ${file.path}`);
  }
}
