/**
 * benchmark 计划使用的稳定 JSON 序列化和 SHA-256 标识。
 *
 * 对象 key 按字典序排序，数组顺序保持原始矩阵顺序。
 */
import { createHash } from 'node:crypto';

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return Object.fromEntries(
    entries.map(([key, item]) => [key, sortValue(item)]),
  );
}
