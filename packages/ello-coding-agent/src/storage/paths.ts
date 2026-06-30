import path from 'node:path';

import { globalHomeDir } from '../config/index.js';

/**
 * 全局结构化状态库路径。
 *
 * SQLite 在 coding-agent 中只有这一处落点：`~/.ello/state.sqlite`。不要从
 * `cwd`、项目 `.ello` 或 session 目录派生数据库路径，否则会重新制造多主源。
 */
export function globalStateDatabasePath(): string {
  return path.join(globalHomeDir(), 'state.sqlite');
}

/**
 * 全局大对象制品目录。
 *
 * checkpoint 的 before/after 快照、patch、导出包都属于可能很大的二进制或文本
 * 内容，DB 只保存它们的路径、hash 和大小，避免把 SQLite 变成内容仓库。
 */
export function globalArtifactsDir(): string {
  return path.join(globalHomeDir(), 'artifacts');
}
