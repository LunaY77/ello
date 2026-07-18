import type { ThreadItem, ThreadSnapshot } from '../../api/protocol-types.js';

export interface TimelineEntry {
  readonly id: string;
  readonly turnId: string;
  readonly kind: ThreadItem['type'];
  readonly item: ThreadItem;
}

export function timelineFromSnapshot(snapshot: ThreadSnapshot): readonly TimelineEntry[] {
  return snapshot.turns.flatMap((turn) =>
    turn.items.map((item) => ({ id: item.id, turnId: turn.id, kind: item.type, item })),
  );
}

export class TimelineStore {
  private current: readonly TimelineEntry[] = [];

  get entries(): readonly TimelineEntry[] { return this.current; }

  replace(snapshot: ThreadSnapshot): readonly TimelineEntry[] {
    this.current = timelineFromSnapshot(snapshot);
    return this.current;
  }
}
