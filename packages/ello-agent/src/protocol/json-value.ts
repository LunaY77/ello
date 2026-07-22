/**
 * 本文件负责 Protocol 的“json-value”模块职责。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 *
 * Args:
 * - `value`: 要由 `isRecord` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `isRecord` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 执行 JSON-RPC 协议的 `json-value` 模块 定义的 `jsonClone` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `value`: 要由 `jsonClone` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `jsonClone` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function jsonClone(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Value is not JSON serializable.');
  }
  return JSON.parse(serialized);
}

/**
 * 执行 JSON-RPC 协议的 `json-value` 模块 定义的 `jsonRecord` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `value`: 要由 `jsonRecord` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `jsonRecord` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function jsonRecord(value: unknown): Record<string, unknown> {
  const cloned = jsonClone(value);
  if (!isRecord(cloned)) throw new Error('Value must serialize to an object.');
  return cloned;
}

/**
 * 执行 JSON-RPC 协议的 `json-value` 模块 定义的 `jsonArray` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `value`: 要由 `jsonArray` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function jsonArray(value: unknown): Array<unknown> {
  const cloned = jsonClone(value);
  if (!Array.isArray(cloned)) {
    throw new Error('Value must serialize to an array.');
  }
  return cloned;
}
