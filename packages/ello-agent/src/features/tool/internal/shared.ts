/**
 * 本文件负责 tool feature 的“shared”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  AgentFileSystem,
  AgentShell,
  AgentToolContext,
} from '../../agent/engine/index.js';

/** 工具输出最大字符数，避免单个 tool result 撑爆上下文和 TUI。 */
export const MAX_TOOL_OUTPUT = 12_000;

/**
 * 截断超长文本，标注省略。
 *
 * Args:
 * - `value`: 要由 `truncate` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `truncate` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function truncate(value: string): string {
  return value.length > MAX_TOOL_OUTPUT
    ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n... truncated ...`
    : value;
}

/**
 * 取出环境的文件系统能力；所有路径边界检查都应委托给运行时环境。
 *
 * Args:
 * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `requireFs` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `shared` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function requireFs(ctx: AgentToolContext): AgentFileSystem {
  const fs = ctx.environment.fileSystem;
  if (fs === undefined) {
    throw new Error('Environment has no file system; cannot run file tools.');
  }
  return fs;
}

/**
 * 取出环境的 shell 能力；能力未注入时直接抛出清晰错误。
 *
 * Args:
 * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `requireShell` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `shared` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function requireShell(ctx: AgentToolContext): AgentShell {
  if (ctx.environment.shell === undefined) {
    throw new Error('Environment has no shell; cannot run shell tools.');
  }
  return ctx.environment.shell;
}

/**
 * 将运行时路径解析成绝对路径；缺少能力说明环境装配错误。
 *
 * Args:
 * - `fs`: `resolveRuntimePath` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `targetPath`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `resolveRuntimePath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `shared` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function resolveRuntimePath(
  fs: AgentFileSystem,
  targetPath: string,
): string {
  return fs.resolvePath(targetPath);
}

/**
 * 读取运行时路径状态；搜索和 read 需要用它区分目录与文件。
 *
 * Args:
 * - `fs`: `statRuntimePath` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `targetPath`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - Promise 在 工具 `shared` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function statRuntimePath(
  fs: AgentFileSystem,
  targetPath: string,
): Promise<{ isDirectory(): boolean }> {
  return fs.stat(targetPath);
}
