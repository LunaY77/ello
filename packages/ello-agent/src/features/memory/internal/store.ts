/**
 * 本文件负责 memory feature 的持久化操作与一致性。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
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

import { errnoCode } from '../../../infra/filesystem.js';

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

/** Memory topic 与索引文件的原子持久化边界。 */
export interface MemoryStore {
  readonly roots: MemoryRoots;
  /**
   * 初始化 Memory 持久化 store 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
   *
   * Throws:
   * - 当 Memory 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  initialize(): Promise<void>;
  /**
   * 读取 Memory 持久化 store 模块 的 `read` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `scope`: `read` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `file`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   *
   * Returns:
   * - Promise 在 Memory 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Memory 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  read(scope: MemoryScope, file: string): Promise<MemoryFileRecord>;
  /**
   * 读取 Memory 持久化 store 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `scope`: `list` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Memory 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  list(scope: MemoryScope): Promise<ReadonlyArray<MemoryTopicRecord>>;
  /**
   * 按 Memory 持久化 store 模块 的一致性约束执行 `write` 状态变更。
   *
   * Args:
   * - `scope`: `write` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `file`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   * - `expectedRevision`: `write` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `content`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - Promise 在 Memory 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Memory 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  write(
    scope: MemoryScope,
    file: string,
    expectedRevision: string | null,
    content: string,
  ): Promise<MemoryMutation>;
  /**
   * 按 Memory 持久化 store 模块 的一致性约束执行 `delete` 状态变更。
   *
   * Args:
   * - `scope`: `delete` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `file`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   * - `expectedRevision`: `delete` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Memory 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Memory 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  delete(
    scope: MemoryScope,
    file: string,
    expectedRevision: string,
  ): Promise<MemoryMutation>;
  /**
   * 在 Memory 持久化 store 模块 中执行 `search` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `query`: `search` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `scope`: `search` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Memory 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  search(
    query: string,
    scope?: MemoryScope,
  ): Promise<ReadonlyArray<MemorySearchMatch>>;
  /**
   * 读取 Memory 持久化 store 模块 的 `status` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Memory 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  status(): Promise<{
    readonly privateEntries: number;
    readonly teamEntries: number;
  }>;
}

/**
 * 创建闭包持有 Memory roots 的文件 store。
 *
 * Args:
 * - `roots`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `createMemoryStore` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Memory 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createMemoryStore(roots: MemoryRoots): MemoryStore {
  /**
   * 初始化 Memory 持久化 store 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
   *
   * Throws:
   * - 当 Memory 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async function initialize(): Promise<void> {
    for (const scope of scopes()) {
      const root = memoryRoot(roots, scope);
      await mkdir(root, { recursive: true });
      await assertDirectoryIsNotSymlink(root);
      const indexPath = memoryIndexPath(roots, scope);
      try {
        await writeFile(indexPath, '', { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') {
          throw error;
        }
      }
      await assertConsistent(scope);
    }
  }

  async function read(
    scope: MemoryScope,
    file: string,
  ): Promise<MemoryFileRecord> {
    if (file !== MEMORY_INDEX_FILE) {
      assertMemoryTopicFile(file);
    }
    const target = await safeExistingFile(scope, file);
    const content = await readFile(target, 'utf8');
    if (file === MEMORY_INDEX_FILE) {
      parseMemoryIndex(content);
    } else {
      parseMemoryTopic(content);
    }
    return { scope, file, content, revision: revision(content) };
  }

  async function list(scope: MemoryScope): Promise<MemoryTopicRecord[]> {
    const root = await safeRoot(scope);
    const entries = await readdir(root, { withFileTypes: true });
    const topics: MemoryTopicRecord[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === MEMORY_INDEX_FILE) {
        if (!entry.isFile()) {
          throw new Error(`${memoryIndexPath(roots, scope)} is not a file.`);
        }
        continue;
      }
      assertMemoryTopicFile(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Invalid memory directory entry: ${entry.name}`);
      }
      const record = await read(scope, entry.name);
      topics.push({ ...record, document: parseMemoryTopic(record.content) });
    }
    return topics;
  }

  async function write(
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
    const existing = await readOptional(scope, file);
    assertExpectedRevision(file, existing?.revision ?? null, expectedRevision);
    const topics = await list(scope);
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
    await commitWrite(scope, file, normalized, index);
    return {
      scope,
      file,
      operation: existing === null ? 'created' : 'updated',
      revision: revision(normalized),
    };
  }

  async function remove(
    scope: MemoryScope,
    file: string,
    expectedRevision: string,
  ): Promise<MemoryMutation> {
    assertMemoryTopicFile(file);
    const existing = await read(scope, file);
    assertExpectedRevision(file, existing.revision, expectedRevision);
    const nextTopics = (await list(scope)).filter(
      (topic) => topic.file !== file,
    );
    const index = renderMemoryIndex(nextTopics.map(toIndexEntry));
    const root = await safeRoot(scope);
    const backup = path.join(root, `.${file}.${randomUUID()}.deleted`);
    await rename(path.join(root, file), backup);
    try {
      await atomicWrite(memoryIndexPath(roots, scope), index);
      await rm(backup);
    } catch (error) {
      await rename(backup, path.join(root, file));
      throw error;
    }
    return { scope, file, operation: 'deleted', revision: null };
  }

  async function search(
    query: string,
    scope?: MemoryScope,
  ): Promise<MemorySearchMatch[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery === '') {
      throw new Error('Memory search query must not be empty.');
    }
    const matches: MemorySearchMatch[] = [];
    for (const selectedScope of scope === undefined ? scopes() : [scope]) {
      for (const topic of await list(selectedScope)) {
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

  async function status(): Promise<{
    readonly privateEntries: number;
    readonly teamEntries: number;
  }> {
    const [privateTopics, teamTopics] = await Promise.all([
      list('private'),
      list('team'),
    ]);
    return {
      privateEntries: privateTopics.length,
      teamEntries: teamTopics.length,
    };
  }

  async function assertConsistent(scope: MemoryScope): Promise<void> {
    const index = parseMemoryIndex(
      (await read(scope, MEMORY_INDEX_FILE)).content,
    );
    const expected = (await list(scope)).map(toIndexEntry);
    if (JSON.stringify(index) !== JSON.stringify(expected)) {
      throw new Error(
        `${memoryIndexPath(roots, scope)} does not match its topic files.`,
      );
    }
  }

  async function readOptional(
    scope: MemoryScope,
    file: string,
  ): Promise<MemoryFileRecord | null> {
    try {
      return await read(scope, file);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async function commitWrite(
    scope: MemoryScope,
    file: string,
    content: string,
    index: string,
  ): Promise<void> {
    const root = await safeRoot(scope);
    const target = path.join(root, file);
    const tempTopic = path.join(root, `.${file}.${randomUUID()}.tmp`);
    const tempIndex = path.join(root, `.MEMORY.${randomUUID()}.tmp`);
    await writeFile(tempTopic, content, 'utf8');
    await writeFile(tempIndex, index, 'utf8');
    try {
      await rename(tempTopic, target);
      await rename(tempIndex, memoryIndexPath(roots, scope));
    } finally {
      await Promise.all([
        rm(tempTopic, { force: true }),
        rm(tempIndex, { force: true }),
      ]);
    }
  }

  async function safeExistingFile(
    scope: MemoryScope,
    file: string,
  ): Promise<string> {
    const root = await safeRoot(scope);
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

  async function safeRoot(scope: MemoryScope): Promise<string> {
    const root = memoryRoot(roots, scope);
    await assertDirectoryIsNotSymlink(root);
    return realpath(root);
  }
  return {
    roots,
    initialize,
    read,
    list,
    write,
    delete: remove,
    search,
    status,
  };
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
