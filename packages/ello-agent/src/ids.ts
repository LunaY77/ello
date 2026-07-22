/**
 * 本文件负责 ello-agent 的“ids”模块职责。
 *
 * 模块只持有其声明的状态与资源，并通过显式类型连接调用方。
 * 输入不满足协议时直接失败，异步资源必须在对应生命周期结束前完成释放。
 */
import { randomUUID } from 'node:crypto';

export type EntityIdPrefix =
  | 'thr'
  | 'turn'
  | 'item'
  | 'srvreq'
  | 'job'
  | 'watch';

/**
 * 前缀只帮助诊断，调用方必须把完整 id 当作 opaque string。
 *
 * Args:
 * - `prefix`: `createEntityId` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createEntityId` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 `ids` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createEntityId(prefix: EntityIdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
