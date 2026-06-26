import { randomUUID } from "node:crypto";
import { generateEntryId, type SessionEntry, type SessionStorage } from "./types.js";

/**
 * 基于内存的 session tree 存储。
 *
 * 维护 entries 列表、byId 索引和当前 leafId。
 */
export class InMemorySessionStorage implements SessionStorage {
  private readonly metadata: Record<string, unknown>;
  private readonly entries: SessionEntry[];
  private readonly byId: Map<string, SessionEntry>;
  private leafId: string | null;

  constructor(options: { sessionId?: string; entries?: SessionEntry[] } = {}) {
    this.metadata = {
      id: options.sessionId ?? randomUUID().replaceAll("-", ""),
      createdAt: new Date().toISOString(),
    };
    this.entries = options.entries ? [...options.entries] : [];
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    this.leafId = this.entries.length > 0 ? this.entries[this.entries.length - 1]?.id ?? null : null;
  }

  async getMetadata(): Promise<Record<string, unknown>> {
    return { ...this.metadata };
  }

  async getLeafId(): Promise<string | null> {
    return this.leafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new Error(`Entry '${leafId}' not found`);
    }
    this.leafId = leafId;
  }

  async appendEntry(entry: SessionEntry): Promise<void> {
    if (!entry.id) {
      entry.id = generateEntryId();
    }
    if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }
    if (entry.parentId === null) {
      entry.parentId = this.leafId;
    }
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }

  async getEntry(entryId: string): Promise<SessionEntry | null> {
    return this.byId.get(entryId) ?? null;
  }

  async getPathToRoot(leafId: string | null): Promise<SessionEntry[]> {
    if (leafId === null) {
      return [];
    }
    const path: SessionEntry[] = [];
    let current = this.byId.get(leafId);
    while (current !== undefined) {
      path.push(current);
      if (current.parentId === null) {
        break;
      }
      current = this.byId.get(current.parentId);
    }
    return path.reverse();
  }

  async getEntries(): Promise<SessionEntry[]> {
    return [...this.entries];
  }

  /** 当前 entry 数量。 */
  get entryCount(): number {
    return this.entries.length;
  }
}
