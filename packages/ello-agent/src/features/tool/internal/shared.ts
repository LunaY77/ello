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

/**
 * 保留的头部占比；测试与构建工具把失败摘要放在输出末尾，因此尾部权重更高。
 */
export const TRUNCATION_HEAD_RATIO = 0.3;

/** 文件中与目标文本最接近的一行；行号是 1-based。 */
export interface NearestLine {
  readonly line: number;
  readonly text: string;
}

/**
 * 找出与 `expected` 最相似的一行，供文本定位失败时报告实际内容。
 *
 * 相似度取去掉两侧空白后的公共前缀长度：edit 与 apply_patch 的定位失败几乎
 * 都源于缩进或空白差异，只回显期望文本无法让调用方判断实际内容长什么样。
 *
 * Args:
 * - `lines`: 目标文件按行拆分后的内容；函数不会修改调用方持有的集合。
 * - `expected`: 期望匹配的单行文本；空白行无法产生有意义的比较结果。
 *
 * Returns:
 * - 返回匹配值；没有任何行与之共享前缀时显式返回 `undefined`。
 */
export function findNearestLine(
  lines: readonly string[],
  expected: string,
): NearestLine | undefined {
  const needle = expected.trim();
  if (needle === '') {
    return undefined;
  }
  let best: { line: number; text: string; score: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const score = commonPrefixLength(line.trim(), needle);
    if (score > 0 && (best === undefined || score > best.score)) {
      best = { line: index + 1, text: line, score };
    }
  }
  return best === undefined ? undefined : { line: best.line, text: best.text };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

/**
 * 生成头尾之间的省略标记。
 *
 * Args:
 * - `omittedBytes`: 头尾之间被丢弃的字节数；调用方据此判断信息缺口大小。
 *
 * Returns:
 * - 返回 `truncationMarker` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function truncationMarker(omittedBytes: number): string {
  return `... truncated ${omittedBytes} bytes from the middle; head and tail kept. Narrow the command (single test file, terser reporter, or pipe through 'tail') to see the omitted region ...`;
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
