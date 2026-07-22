/**
 * 本文件负责 config feature 的“atomic-write”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { errnoCode } from '../../infra/filesystem.js';

/**
 * 在同目录写入临时文件后原子替换目标，失败时保留旧文件并清理临时文件。
 * 已有文件沿用原权限；新建配置默认仅当前用户可读写。
 *
 * Args:
 * - `target`: `atomicWriteText` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `content`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - Promise 在 配置 `atomic-write` 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
export async function atomicWriteText(
  target: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const mode = await existingMode(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function existingMode(target: string): Promise<number> {
  try {
    return (await stat(target)).mode & 0o777;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 0o600;
    throw error;
  }
}
