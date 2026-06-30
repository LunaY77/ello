import { createHash } from 'node:crypto';

import type { CodingAgentConfig } from '../config/index.js';

/** 生成稳定短 hash，避免把绝对路径直接塞进目录名。 */
export function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

/**
 * 解析当前任务列表 ID。
 *
 * 优先级与计划文档一致：显式环境变量 > session id > cwd hash。
 */
export function resolveTaskListId(config: CodingAgentConfig): string {
  if (process.env.ELLO_TASK_LIST_ID?.trim()) {
    return sanitizeTaskListId(process.env.ELLO_TASK_LIST_ID);
  }
  if (config.sessionId?.trim()) {
    return sanitizeTaskListId(config.sessionId);
  }
  return `cwd-${shortHash(config.cwd)}`;
}

/** 任务列表 ID 只允许用于目录名的保守字符。 */
export function sanitizeTaskListId(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .slice(0, 80);
}
