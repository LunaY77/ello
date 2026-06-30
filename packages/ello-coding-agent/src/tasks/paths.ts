import path from 'node:path';

import type { CodingAgentConfig } from '../config/index.js';
import { globalTasksDir, projectTasksDir } from '../config/index.js';

import { resolveTaskListId } from './ids.js';

/** 解析当前任务列表目录。 */
export function taskListDir(config: CodingAgentConfig): string {
  const root =
    config.allowedPaths.includes(config.cwd) || config.cwd !== ''
      ? projectTasksDir(config.cwd)
      : globalTasksDir();
  return path.join(root, resolveTaskListId(config));
}

/** 单个任务 JSON 文件路径。 */
export function taskFilePath(baseDir: string, id: string): string {
  return path.join(baseDir, `${id}.json`);
}

/** 高水位文件路径，用于保证删除后 ID 不复用。 */
export function highwatermarkPath(baseDir: string): string {
  return path.join(baseDir, '.highwatermark');
}

/** 锁目录路径；mkdir 原子性足够覆盖单机并发写。 */
export function lockPath(baseDir: string): string {
  return path.join(baseDir, '.lock');
}
