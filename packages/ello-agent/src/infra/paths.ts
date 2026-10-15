/**
 * 本文件负责基础设施层的路径推导与路径约束。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORAGE_ID_PATTERN = /^[A-Za-z0-9_@+-][A-Za-z0-9._:@+-]{0,199}$/u;

/**
 * 解析随构建产物分发的只读资源目录(提示词、迁移、模板等)。
 *
 * `bun build --compile` 打包的 sidecar 中模块路径是虚拟的(~BUN/root),
 * 文件系统上没有真实资源文件;此时由宿主进程(桌面端)通过
 * ELLO_AGENT_DIST_DIR 注入解包后的资源根目录。
 *
 * Args:
 * - `options.moduleUrl`: 调用方模块的 import.meta.url,仅用于本地布局回退。
 * - `options.dirName`: 本地布局中资源目录相对模块目录的名字。
 * - `options.distRelative`: 资源目录相对 dist 根的路径,用于 ELLO_AGENT_DIST_DIR 布局。
 *
 * Returns:
 * - 返回资源目录的绝对路径;目录是否存在由调用方读取时显式校验。
 */
export function bundledAssetDir(options: {
  readonly moduleUrl: string;
  readonly dirName: string;
  readonly distRelative: string;
}): string {
  const root = process.env.ELLO_AGENT_DIST_DIR?.trim();
  if (root !== undefined && root !== '') {
    return join(root, options.distRelative);
  }
  return join(dirname(fileURLToPath(options.moduleUrl)), options.dirName);
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `elloHomeDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `elloHomeDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function elloHomeDir(): string {
  const configured = process.env.ELLO_HOME?.trim();
  return configured === undefined || configured === ''
    ? join(homedir(), '.ello')
    : configured;
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `activeThreadsDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `activeThreadsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function activeThreadsDir(root = elloHomeDir()): string {
  return join(root, 'threads', 'active');
}

/**
 * 按 基础设施层的 `paths` 模块 的一致性约束执行 `archivedThreadsDir` 状态变更。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `archivedThreadsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function archivedThreadsDir(root = elloHomeDir()): string {
  return join(root, 'threads', 'archived');
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `threadLogPath` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `threadLogPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function threadLogPath(threadId: string, root = elloHomeDir()): string {
  return storageFilePath(activeThreadsDir(root), threadId, '.jsonl');
}

/**
 * 按 基础设施层的 `paths` 模块 的一致性约束执行 `archivedThreadLogPath` 状态变更。
 *
 * Args:
 * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `archivedThreadLogPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function archivedThreadLogPath(
  threadId: string,
  root = elloHomeDir(),
): string {
  return storageFilePath(archivedThreadsDir(root), threadId, '.jsonl');
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `artifactsDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `artifactsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function artifactsDir(root = elloHomeDir()): string {
  return join(root, 'artifacts');
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `stateDatabasePath` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `stateDatabasePath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function stateDatabasePath(root = elloHomeDir()): string {
  return join(root, 'state', 'ello.sqlite');
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `serverRunDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `serverRunDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function serverRunDir(root = elloHomeDir()): string {
  return join(root, 'run');
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `threadLocksDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `threadLocksDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function threadLocksDir(root = elloHomeDir()): string {
  return join(serverRunDir(root), 'thread-locks');
}

/**
 * 执行 基础设施层的 `paths` 模块 定义的 `threadLeasePath` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `threadLeasePath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function threadLeasePath(
  threadId: string,
  root = elloHomeDir(),
): string {
  return storageFilePath(threadLocksDir(root), threadId, '.lock');
}

/** 文件型 thread ID 不接受目录分隔符，并再次验证结果仍位于目标目录。 */
function storageFilePath(
  directory: string,
  id: string,
  extension: string,
): string {
  if (!STORAGE_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error(`Unsafe storage id: ${id}.`);
  }
  const base = resolve(directory);
  const candidate = resolve(base, `${id}${extension}`);
  const relativeCandidate = relative(base, candidate);
  if (
    relativeCandidate === '' ||
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate)
  ) {
    throw new Error(`Storage path escapes its directory: ${id}.`);
  }
  return candidate;
}
