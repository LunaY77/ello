import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { MemoryRoots, MemoryScope } from './paths.js';
import { memoryIndexPath, memoryRoot } from './paths.js';
import {
  MEMORY_INDEX_FILE,
  assertMemoryTopicFile,
  parseMemoryIndex,
  parseMemoryTopic,
  renderMemoryIndex,
  renderMemoryTopic,
  type MemoryIndexEntry,
  type MemoryTopicDocument,
} from './schema.js';

export interface MemoryFileRecord {
  readonly scope: MemoryScope;
  readonly file: string;
  readonly content: string;
  readonly revision: string;
}

export interface MemoryTopicRecord extends MemoryFileRecord {
  readonly document: MemoryTopicDocument;
}

export interface MemoryMutation {
  readonly scope: MemoryScope;
  readonly file: string;
  readonly operation: 'created' | 'updated' | 'deleted';
  readonly revision: string | null;
}

export interface MemorySearchMatch {
  readonly scope: MemoryScope;
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly snippet: string;
  readonly revision: string;
}

export class MemoryRepository {
  constructor(readonly roots: MemoryRoots) {}

  async initialize(): Promise<void> {
    for (const scope of scopes()) {
      const root = memoryRoot(this.roots, scope);
      await mkdir(root, { recursive: true });
      await assertDirectoryIsNotSymlink(root);
      const indexPath = memoryIndexPath(this.roots, scope);
      try {
        await writeFile(indexPath, '', { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      await this.assertConsistent(scope);
    }
  }

  async read(scope: MemoryScope, file: string): Promise<MemoryFileRecord> {
    if (file !== MEMORY_INDEX_FILE) {
      assertMemoryTopicFile(file);
    }
    const target = await this.safeExistingFile(scope, file);
    const content = await readFile(target, 'utf8');
    if (file === MEMORY_INDEX_FILE) {
      parseMemoryIndex(content);
    } else {
      parseMemoryTopic(content);
    }
    return { scope, file, content, revision: revision(content) };
  }

  async list(scope: MemoryScope): Promise<MemoryTopicRecord[]> {
    const root = await this.safeRoot(scope);
    const entries = await readdir(root, { withFileTypes: true });
    const topics: MemoryTopicRecord[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === MEMORY_INDEX_FILE) {
        if (!entry.isFile()) {
          throw new Error(
            `${memoryIndexPath(this.roots, scope)} is not a file.`,
          );
        }
        continue;
      }
      assertMemoryTopicFile(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Invalid memory directory entry: ${entry.name}`);
      }
      const record = await this.read(scope, entry.name);
      topics.push({ ...record, document: parseMemoryTopic(record.content) });
    }
    return topics;
  }

  async write(
    scope: MemoryScope,
    file: string,
    expectedRevision: string | null,
    content: string,
  ): Promise<MemoryMutation> {
    assertMemoryTopicFile(file);
    const document = parseMemoryTopic(content);
    if (scope === 'team' && document.frontmatter.type === 'user') {
      throw new Error('user memories must use private scope.');
    }
    const normalized = renderMemoryTopic(document);
    const existing = await this.readOptional(scope, file);
    assertExpectedRevision(file, existing?.revision ?? null, expectedRevision);
    const topics = await this.list(scope);
    const duplicate = topics.find(
      (topic) =>
        topic.file !== file &&
        topic.document.frontmatter.name === document.frontmatter.name,
    );
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate memory name ${document.frontmatter.name} in ${duplicate.file}.`,
      );
    }
    const nextTopics = topics
      .filter((topic) => topic.file !== file)
      .concat({
        scope,
        file,
        content: normalized,
        revision: revision(normalized),
        document,
      })
      .sort((left, right) => left.file.localeCompare(right.file));
    const index = renderMemoryIndex(nextTopics.map(toIndexEntry));
    await this.commitWrite(scope, file, normalized, index);
    return {
      scope,
      file,
      operation: existing === null ? 'created' : 'updated',
      revision: revision(normalized),
    };
  }

  async delete(
    scope: MemoryScope,
    file: string,
    expectedRevision: string,
  ): Promise<MemoryMutation> {
    assertMemoryTopicFile(file);
    const existing = await this.read(scope, file);
    assertExpectedRevision(file, existing.revision, expectedRevision);
    const nextTopics = (await this.list(scope)).filter(
      (topic) => topic.file !== file,
    );
    const index = renderMemoryIndex(nextTopics.map(toIndexEntry));
    const root = await this.safeRoot(scope);
    const backup = path.join(root, `.${file}.${randomUUID()}.deleted`);
    await rename(path.join(root, file), backup);
    try {
      await atomicWrite(memoryIndexPath(this.roots, scope), index);
      await rm(backup);
    } catch (error) {
      await rename(backup, path.join(root, file));
      throw error;
    }
    return { scope, file, operation: 'deleted', revision: null };
  }

  async search(
    query: string,
    scope?: MemoryScope,
  ): Promise<MemorySearchMatch[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery === '') {
      throw new Error('Memory search query must not be empty.');
    }
    const matches: MemorySearchMatch[] = [];
    for (const selectedScope of scope === undefined ? scopes() : [scope]) {
      for (const topic of await this.list(selectedScope)) {
        const haystack = [
          topic.document.frontmatter.name,
          topic.document.frontmatter.description,
          topic.document.body,
        ]
          .join('\n')
          .toLocaleLowerCase();
        const position = haystack.indexOf(normalizedQuery);
        if (position < 0) {
          continue;
        }
        const bodyPosition = topic.document.body
          .toLocaleLowerCase()
          .indexOf(normalizedQuery);
        const snippetStart = Math.max(
          0,
          bodyPosition < 0 ? 0 : bodyPosition - 80,
        );
        matches.push({
          scope: selectedScope,
          file: topic.file,
          name: topic.document.frontmatter.name,
          description: topic.document.frontmatter.description,
          snippet: topic.document.body.slice(snippetStart, snippetStart + 240),
          revision: topic.revision,
        });
      }
    }
    return matches;
  }

  async status(): Promise<{
    readonly privateEntries: number;
    readonly teamEntries: number;
  }> {
    const [privateTopics, teamTopics] = await Promise.all([
      this.list('private'),
      this.list('team'),
    ]);
    return {
      privateEntries: privateTopics.length,
      teamEntries: teamTopics.length,
    };
  }

  private async assertConsistent(scope: MemoryScope): Promise<void> {
    const index = parseMemoryIndex(
      (await this.read(scope, MEMORY_INDEX_FILE)).content,
    );
    const expected = (await this.list(scope)).map(toIndexEntry);
    if (JSON.stringify(index) !== JSON.stringify(expected)) {
      throw new Error(
        `${memoryIndexPath(this.roots, scope)} does not match its topic files.`,
      );
    }
  }

  private async readOptional(
    scope: MemoryScope,
    file: string,
  ): Promise<MemoryFileRecord | null> {
    try {
      return await this.read(scope, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async commitWrite(
    scope: MemoryScope,
    file: string,
    content: string,
    index: string,
  ): Promise<void> {
    const root = await this.safeRoot(scope);
    const target = path.join(root, file);
    const tempTopic = path.join(root, `.${file}.${randomUUID()}.tmp`);
    const tempIndex = path.join(root, `.MEMORY.${randomUUID()}.tmp`);
    await writeFile(tempTopic, content, 'utf8');
    await writeFile(tempIndex, index, 'utf8');
    try {
      await rename(tempTopic, target);
      await rename(tempIndex, memoryIndexPath(this.roots, scope));
    } finally {
      await Promise.all([
        rm(tempTopic, { force: true }),
        rm(tempIndex, { force: true }),
      ]);
    }
  }

  private async safeExistingFile(
    scope: MemoryScope,
    file: string,
  ): Promise<string> {
    const root = await this.safeRoot(scope);
    const target = path.join(root, file);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Memory path is not a regular file: ${target}`);
    }
    const resolved = await realpath(target);
    if (path.dirname(resolved) !== root) {
      throw new Error(`Memory path escapes its root: ${target}`);
    }
    return target;
  }

  private async safeRoot(scope: MemoryScope): Promise<string> {
    const root = memoryRoot(this.roots, scope);
    await assertDirectoryIsNotSymlink(root);
    return realpath(root);
  }
}

function scopes(): readonly MemoryScope[] {
  return ['private', 'team'];
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function toIndexEntry(topic: MemoryTopicRecord): MemoryIndexEntry {
  return {
    name: topic.document.frontmatter.name,
    file: topic.file,
    description: topic.document.frontmatter.description,
  };
}

function assertExpectedRevision(
  file: string,
  actual: string | null,
  expected: string | null,
): void {
  if (actual !== expected) {
    throw new Error(
      `Memory revision conflict for ${file}: expected ${expected ?? '<missing>'}, actual ${actual ?? '<missing>'}.`,
    );
  }
}

async function assertDirectoryIsNotSymlink(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Memory root is not a regular directory: ${root}`);
  }
  const resolved = await realpath(root);
  if (resolved !== path.resolve(root)) {
    throw new Error(`Memory root must not traverse symlinks: ${root}`);
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  await writeFile(temp, content, 'utf8');
  try {
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
