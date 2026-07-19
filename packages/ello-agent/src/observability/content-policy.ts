import { createHash } from 'node:crypto';

import type { LangfuseTracingConfig } from '../config/index.js';

export type TraceContentPolicy = LangfuseTracingConfig['content'];

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
