/**
 * 本文件负责基础设施层的“content-policy”模块职责。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { createHash } from 'node:crypto';

import type { LangfuseTracingConfig } from '../../features/config/index.js';

export type TraceContentPolicy = LangfuseTracingConfig['content'];

/**
 * 执行 基础设施层的 `content-policy` 模块 定义的 `contentAttributes` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `policy`: `contentAttributes` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `field`: `contentAttributes` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `payload`: `contentAttributes` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `contentAttributes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function contentAttributes(
  policy: TraceContentPolicy,
  field: 'input' | 'output',
  payload: unknown,
): Record<string, string | number> {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error(`Trace ${field} payload is not JSON serializable.`);
  }
  if (policy === 'full') {
    return { [`langfuse.observation.${field}`]: serialized };
  }
  return {
    [`ello.${field}.bytes`]: Buffer.byteLength(serialized),
    [`ello.${field}.sha256`]: createHash('sha256')
      .update(serialized)
      .digest('hex'),
  };
}
