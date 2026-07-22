/**
 * 本文件负责 thread feature 的Plan 文件状态。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { errnoCode } from '../../infra/filesystem.js';
import { projectElloDir } from '../config/index.js';
import { PlanModeError } from '../tool/index.js';

export const MAX_PLAN_BYTES = 256_000;

/**
 * Plan 固定写入项目的 ello 状态目录，不占用或覆盖用户业务文档。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `sessionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 *
 * Returns:
 * - 返回 `planArtifactPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function planArtifactPath(cwd: string, sessionId: string): string {
  return path.join(projectElloDir(cwd), 'plans', `${sessionId}.md`);
}

/**
 * 执行 Thread `plan` 模块 定义的 `hashPlan` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `content`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `hashPlan` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function hashPlan(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 完整写入 Plan 后再返回 hash；审批 Preview 永远读取最后一次完整落盘的版本，
 * 不会看到模型正在生成的半截内容。
 *
 * Args:
 * - `input`: `writePlanArtifact` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - Promise 在 Thread `plan` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 Thread `plan` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function writePlanArtifact(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly content: string;
}): Promise<{
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
}> {
  const content = input.content.trim();
  if (content.length === 0 || Buffer.byteLength(content) > MAX_PLAN_BYTES) {
    throw new PlanModeError({
      code: 'PLAN_STATE_INVALID',
      message: `Plan must contain 1-${MAX_PLAN_BYTES} bytes.`,
      sessionId: input.sessionId,
      state: { bytes: Buffer.byteLength(content) },
    });
  }
  const artifactPath = planArtifactPath(input.cwd, input.sessionId);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${content}\n`, 'utf8');
  return { path: artifactPath, content, contentHash: hashPlan(content) };
}

/**
 * 读取时重新计算内容 hash。调用方必须把它与事件流中的 contentHash 比较，
 * 从而阻止用户接受一个已经在审批界面之外发生变化的计划。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `sessionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 *
 * Returns:
 * - 返回 `readPlanArtifact` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `plan` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function readPlanArtifact(cwd: string, sessionId: string) {
  const artifactPath = planArtifactPath(cwd, sessionId);
  try {
    const content = (await readFile(artifactPath, 'utf8')).trim();
    if (content.length === 0) throw new Error('empty plan');
    return { path: artifactPath, content, contentHash: hashPlan(content) };
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new PlanModeError({
        code: 'PLAN_NOT_FOUND',
        message: `No plan exists for session ${sessionId}.`,
        sessionId,
        state: null,
      });
    }
    throw error;
  }
}
