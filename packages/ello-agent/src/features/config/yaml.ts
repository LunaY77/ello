/**
 * 本文件负责 config feature 的“yaml”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { parse, parseDocument, stringify } from 'yaml';

/**
 * 统一封装 YAML 对象解析；空内容和非对象根节点都表示配置边界不完整。
 *
 * Args:
 * - `text`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `parseYamlConfig` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 配置 `yaml` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseYamlConfig(text: string): Record<string, unknown> {
  const value: unknown = parse(text);
  if (value === null || value === undefined) {
    throw new Error('YAML config root must be an object.');
  }
  if (!isRecord(value)) {
    throw new Error('YAML config root must be an object.');
  }
  return value;
}

/**
 * 统一封装 YAML 序列化，并保证文件末尾有换行。
 *
 * Args:
 * - `value`: 要由 `stringifyYamlConfig` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `stringifyYamlConfig` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function stringifyYamlConfig(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

/**
 * 路径级更新 YAML，保留未触达区域的注释与排版。
 *
 * Args:
 * - `text`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 * - `entries`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `updateYamlConfigValues` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 配置 `yaml` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function updateYamlConfigValues(
  text: string,
  entries: readonly {
    readonly path: readonly string[];
    readonly value: unknown;
  }[],
): string {
  const document = parseDocument(text);
  assertValidDocument(document.errors);
  for (const entry of entries) {
    document.setIn([...entry.path], entry.value);
  }
  return ensureTrailingNewline(String(document));
}

/**
 * 路径级删除 YAML，保留未触达区域的注释与排版。
 *
 * Args:
 * - `text`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 * - `paths`: `deleteYamlConfigValues` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `deleteYamlConfigValues` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 配置 `yaml` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function deleteYamlConfigValues(
  text: string,
  paths: readonly (readonly string[])[],
): string {
  const document = parseDocument(text);
  assertValidDocument(document.errors);
  for (const path of paths) {
    document.deleteIn([...path]);
  }
  return ensureTrailingNewline(String(document));
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function assertValidDocument(errors: readonly Error[]): void {
  const firstError = errors[0];
  if (firstError !== undefined) {
    throw new Error(`Invalid YAML config: ${firstError.message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
