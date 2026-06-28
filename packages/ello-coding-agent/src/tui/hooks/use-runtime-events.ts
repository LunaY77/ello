import { useEffect, useState } from 'react';

import type { ProductSnapshot } from '../../product/event-store.js';
import type { CodingAgentRuntime } from '../../product/runtime.js';

/** 订阅 ProductEventStore 并返回 domain snapshot。 */
export function useRuntimeEvents(runtime: CodingAgentRuntime): ProductSnapshot {
  const [snapshot, setSnapshot] = useState<ProductSnapshot>(() => runtime.events.snapshot());
  useEffect(() => runtime.events.subscribe(() => setSnapshot(runtime.events.snapshot())), [runtime]);
  return snapshot;
}
