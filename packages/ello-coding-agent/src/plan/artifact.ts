import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PlanModeError } from '../runtime/session-mode.js';
import { projectDir } from '../session/paths.js';

export const MAX_PLAN_BYTES = 256_000;

/** Plan 固定写入项目的 ello 状态目录，不占用或覆盖用户业务文档。 */
export function planArtifactPath(cwd: string, sessionId: string): string {
  return path.join(projectDir(cwd), 'plans', `${sessionId}.md`);
}

export function hashPlan(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 完整写入 Plan 后再返回 hash；审批 Preview 永远读取最后一次完整落盘的版本，
 * 不会看到模型正在生成的半截内容。
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
 */
export async function readPlanArtifact(cwd: string, sessionId: string) {
  const artifactPath = planArtifactPath(cwd, sessionId);
  try {
    const content = (await readFile(artifactPath, 'utf8')).trim();
    if (content.length === 0) throw new Error('empty plan');
    return { path: artifactPath, content, contentHash: hashPlan(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
