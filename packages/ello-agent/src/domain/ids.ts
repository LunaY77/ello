import { randomUUID } from 'node:crypto';

export type EntityIdPrefix =
  | 'thr'
  | 'turn'
  | 'item'
  | 'srvreq'
  | 'job'
  | 'watch';

/** 前缀只帮助诊断，调用方必须把完整 id 当作 opaque string。 */
export function createEntityId(prefix: EntityIdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
