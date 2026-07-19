import type {
  AgentApprovalDecision,
  AgentFileSystem,
  AgentShell,
  AgentToolContext,
  MaybePromise,
} from '../engine/index.js';

/** 工具输出最大字符数，避免单个 tool result 撑爆上下文和 TUI。 */
export const MAX_TOOL_OUTPUT = 12_000;

/**
 * 审批工厂类型：按工具名生成 `approval` 回调（{@link makeApprovalPolicy}）。
 *
 * 内核会在工具被调度前调用返回的回调，`'required'` 时暂停并发 `approval.required`。
 *
 * 内层入参声明为 `never`：审批策略实际不关心具体入参形状，用 `never` 可让
 * `defineTool` 从 zod schema 推导出 `TInput`，而不会被 `unknown` 入参覆盖成
 * `unknown`（仍与实际的 `(input: unknown, ...)` 实现兼容，逆变方向成立）。
 */
export type ApprovalFor = (
  toolName: string,
) => (
  input: never,
  ctx: AgentToolContext,
) => MaybePromise<AgentApprovalDecision>;

/** 截断超长文本，标注省略。 */
export function truncate(value: string): string {
  return value.length > MAX_TOOL_OUTPUT
    ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n... truncated ...`
    : value;
}

/** 取出环境的文件系统能力；所有路径边界检查都应委托给运行时环境。 */
export function requireFs(ctx: AgentToolContext): AgentFileSystem {
  const fs = ctx.environment.fileSystem;
  if (fs === undefined) {
    throw new Error('Environment has no file system; cannot run file tools.');
  }
  return fs;
}

/** 取出环境的 shell 能力；缺省抛出清晰错误。 */
export function requireShell(ctx: AgentToolContext): AgentShell {
  if (ctx.environment.shell === undefined) {
    throw new Error('Environment has no shell; cannot run shell tools.');
  }
  return ctx.environment.shell;
}

/** 将运行时路径解析成绝对路径；缺少能力说明环境装配错误。 */
export function resolveRuntimePath(
  fs: AgentFileSystem,
  targetPath: string,
): string {
  const resolver = (fs as { resolvePath?: unknown }).resolvePath;
  if (typeof resolver !== 'function') {
    throw new Error('Runtime file system does not expose resolvePath.');
  }
  return resolver.call(fs, targetPath) as string;
}

/** 读取运行时路径状态；搜索和 read 需要用它区分目录与文件。 */
export async function statRuntimePath(
  fs: AgentFileSystem,
  targetPath: string,
): Promise<{ isDirectory(): boolean }> {
  const statFn = (fs as { stat?: unknown }).stat;
  if (typeof statFn !== 'function') {
    throw new Error('Runtime file system does not expose stat.');
  }
  return statFn.call(fs, targetPath) as Promise<{ isDirectory(): boolean }>;
}
