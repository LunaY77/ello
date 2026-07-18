import { and, asc, desc, eq } from 'drizzle-orm';

import { projectThreadItemDelta } from '../../domain/projection/thread-snapshot.js';
import {
  ThreadItemSchema,
  ThreadSummarySchema,
  type ThreadItem,
  type ThreadStatus,
  type ThreadSummary,
  type Turn,
} from '../../protocol/v1/index.js';
import {
  immediateTransaction,
  type CodingDatabase,
} from '../database/database.js';
import {
  threadCatalog,
  threadCheckpointCatalog,
  threadItemCatalog,
  threadRequestCatalog,
  threadTurnCatalog,
} from '../database/schema.js';
import type { ThreadRecord } from '../threads/thread-record.js';

export interface ThreadCatalogState {
  readonly id: string;
  readonly seq: number;
  readonly archived: boolean;
}

export interface ThreadCatalogListOptions {
  readonly archived: boolean;
  readonly cwd?: string;
  readonly offset: number;
  readonly limit: number;
}

export interface ThreadCatalogPage {
  readonly data: readonly ThreadSummary[];
  readonly hasMore: boolean;
}

/** JSONL 的结构化查询投影；所有内容都可以从 thread log 原子重建。 */
export class ThreadCatalogRepository {
  constructor(private readonly db: CodingDatabase) {}

  apply(record: ThreadRecord): void {
    immediateTransaction(this.db, () => this.applyInTransaction(record));
  }

  rebuild(records: readonly ThreadRecord[]): void {
    assertRebuildRecords(records);
    immediateTransaction(this.db, () => {
      this.db
        .delete(threadCatalog)
        .where(eq(threadCatalog.id, records[0]!.threadId))
        .run();
      for (const record of records) this.applyInTransaction(record);
    });
  }

  delete(threadId: string): boolean {
    return immediateTransaction(
      this.db,
      () =>
        this.db
          .delete(threadCatalog)
          .where(eq(threadCatalog.id, threadId))
          .run().changes > 0,
    );
  }

  state(threadId: string): ThreadCatalogState | null {
    const row = this.db
      .select({
        id: threadCatalog.id,
        seq: threadCatalog.seq,
        archived: threadCatalog.archived,
      })
      .from(threadCatalog)
      .where(eq(threadCatalog.id, threadId))
      .get();
    return row ?? null;
  }

  states(): readonly ThreadCatalogState[] {
    return this.db
      .select({
        id: threadCatalog.id,
        seq: threadCatalog.seq,
        archived: threadCatalog.archived,
      })
      .from(threadCatalog)
      .orderBy(asc(threadCatalog.id))
      .all();
  }

  list(options: ThreadCatalogListOptions): ThreadCatalogPage {
    const filter =
      options.cwd === undefined
        ? eq(threadCatalog.archived, options.archived)
        : and(
            eq(threadCatalog.archived, options.archived),
            eq(threadCatalog.cwd, options.cwd),
          );
    const rows = this.db
      .select()
      .from(threadCatalog)
      .where(filter)
      .orderBy(desc(threadCatalog.updatedAt), desc(threadCatalog.id))
      .limit(options.limit + 1)
      .offset(options.offset)
      .all();
    return {
      data: rows.slice(0, options.limit).map((row) =>
        ThreadSummarySchema.parse({
          id: row.id,
          rootId: row.rootId,
          ...(row.forkedFromId === null
            ? {}
            : { forkedFromId: row.forkedFromId }),
          cwd: row.cwd,
          name: row.name,
          preview: row.preview,
          status: row.status,
          archived: row.archived,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }),
      ),
      hasMore: rows.length > options.limit,
    };
  }

  private applyInTransaction(record: ThreadRecord): void {
    if (record.kind === 'thread.created') {
      this.applyCreated(record);
      return;
    }
    const current = this.state(record.threadId);
    if (current === null) {
      throw new Error(
        `Thread catalog ${record.threadId} does not contain thread.created.`,
      );
    }
    if (current.seq !== record.seq - 1) {
      throw new Error(
        `Thread catalog ${record.threadId} is at seq ${current.seq}, cannot apply seq ${record.seq}.`,
      );
    }

    let status: ThreadStatus | undefined;
    switch (record.kind) {
      case 'thread.metadata':
        this.applyMetadata(record);
        status =
          record.archived === undefined
            ? undefined
            : record.archived
              ? 'archived'
              : 'idle';
        break;
      case 'thread.status':
        status = record.status;
        break;
      case 'turn.started':
        this.insertTurn(record.threadId, record.turn, record.seq);
        status = 'running';
        break;
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.failed':
        this.completeTurn(record.turn, record.seq);
        status =
          record.kind === 'turn.completed'
            ? 'idle'
            : record.kind === 'turn.interrupted'
              ? 'interrupted'
              : 'failed';
        break;
      case 'item.started':
        this.insertItem(
          record.threadId,
          record.turnId,
          record.item,
          record.seq,
        );
        break;
      case 'item.delta':
        this.applyItemDelta(record);
        break;
      case 'item.completed':
        this.completeItem(record);
        break;
      case 'serverRequest.created':
        this.createRequest(record);
        status =
          record.request.method === 'item/tool/requestUserInput'
            ? 'awaitingUserInput'
            : 'awaitingApproval';
        break;
      case 'serverRequest.resolved':
        this.resolveRequest(record);
        status = this.statusAfterRequestResolution(record.threadId);
        break;
      case 'compaction':
        this.insertCompaction(record);
        break;
      case 'transcript.entry':
      case 'goal.state':
      case 'plan.state':
      case 'content.replacement':
      case 'usage.updated':
        break;
    }

    this.db
      .update(threadCatalog)
      .set({
        seq: record.seq,
        updatedAt: record.createdAt,
        ...(status === undefined ? {} : { status }),
      })
      .where(eq(threadCatalog.id, record.threadId))
      .run();
  }

  private applyCreated(
    record: Extract<ThreadRecord, { kind: 'thread.created' }>,
  ): void {
    if (record.seq !== 1) {
      throw new Error(
        `thread.created for ${record.threadId} must have seq 1, got ${record.seq}.`,
      );
    }
    if (this.state(record.threadId) !== null) {
      throw new Error(`Thread catalog ${record.threadId} already exists.`);
    }
    this.db
      .insert(threadCatalog)
      .values({
        id: record.threadId,
        rootId: record.rootId,
        forkedFromId: record.forkedFromId ?? null,
        cwd: record.cwd,
        name: record.name,
        preview: '',
        status: 'idle',
        archived: false,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        seq: record.seq,
      })
      .run();
  }

  private applyMetadata(
    record: Extract<ThreadRecord, { kind: 'thread.metadata' }>,
  ): void {
    if (
      record.name === undefined &&
      record.preview === undefined &&
      record.archived === undefined
    ) {
      return;
    }
    this.db
      .update(threadCatalog)
      .set({
        ...(record.name === undefined ? {} : { name: record.name }),
        ...(record.preview === undefined ? {} : { preview: record.preview }),
        ...(record.archived === undefined ? {} : { archived: record.archived }),
      })
      .where(eq(threadCatalog.id, record.threadId))
      .run();
  }

  private insertTurn(threadId: string, turn: Turn, seq: number): void {
    if (turn.threadId !== threadId) {
      throw new Error(`Turn ${turn.id} belongs to ${turn.threadId}.`);
    }
    this.db
      .insert(threadTurnCatalog)
      .values({
        id: turn.id,
        threadId,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt ?? null,
        errorCode: turn.errorCode ?? null,
        usageJson: turn.usage === undefined ? null : JSON.stringify(turn.usage),
        seq,
      })
      .run();
    for (const item of turn.items) {
      this.insertItem(threadId, turn.id, item, seq);
    }
  }

  private completeTurn(turn: Turn, seq: number): void {
    const result = this.db
      .update(threadTurnCatalog)
      .set({
        status: turn.status,
        completedAt: turn.completedAt ?? null,
        errorCode: turn.errorCode ?? null,
        usageJson: turn.usage === undefined ? null : JSON.stringify(turn.usage),
        seq,
      })
      .where(
        and(
          eq(threadTurnCatalog.id, turn.id),
          eq(threadTurnCatalog.threadId, turn.threadId),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error(`Thread catalog is missing turn ${turn.id}.`);
    }
  }

  private insertItem(
    threadId: string,
    turnId: string,
    item: ThreadItem,
    seq: number,
  ): void {
    if (item.turnId !== turnId) {
      throw new Error(`Item ${item.id} does not belong to turn ${turnId}.`);
    }
    this.db
      .insert(threadItemCatalog)
      .values({
        id: item.id,
        threadId,
        turnId,
        type: item.type,
        status: itemStatus(item),
        createdAt: item.createdAt,
        payloadJson: JSON.stringify(item),
        seq,
      })
      .run();
  }

  private applyItemDelta(
    record: Extract<ThreadRecord, { kind: 'item.delta' }>,
  ): void {
    const row = this.db
      .select()
      .from(threadItemCatalog)
      .where(eq(threadItemCatalog.id, record.itemId))
      .get();
    if (
      row === undefined ||
      row.threadId !== record.threadId ||
      row.turnId !== record.turnId
    ) {
      throw new Error(`Thread catalog is missing item ${record.itemId}.`);
    }
    const item = ThreadItemSchema.parse(JSON.parse(row.payloadJson));
    const projected = projectThreadItemDelta(item, record.delta);
    this.db
      .update(threadItemCatalog)
      .set({ payloadJson: JSON.stringify(projected), seq: record.seq })
      .where(eq(threadItemCatalog.id, record.itemId))
      .run();
  }

  private completeItem(
    record: Extract<ThreadRecord, { kind: 'item.completed' }>,
  ): void {
    if (record.item.turnId !== record.turnId) {
      throw new Error(
        `Item ${record.item.id} does not belong to turn ${record.turnId}.`,
      );
    }
    const result = this.db
      .update(threadItemCatalog)
      .set({
        type: record.item.type,
        status: itemStatus(record.item),
        payloadJson: JSON.stringify(record.item),
        seq: record.seq,
      })
      .where(
        and(
          eq(threadItemCatalog.id, record.item.id),
          eq(threadItemCatalog.threadId, record.threadId),
          eq(threadItemCatalog.turnId, record.turnId),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error(`Thread catalog is missing item ${record.item.id}.`);
    }
  }

  private createRequest(
    record: Extract<ThreadRecord, { kind: 'serverRequest.created' }>,
  ): void {
    if (record.request.threadId !== record.threadId) {
      throw new Error(
        `Server Request ${record.request.id} belongs to ${record.request.threadId}.`,
      );
    }
    this.db
      .insert(threadRequestCatalog)
      .values({
        id: record.request.id,
        threadId: record.threadId,
        turnId: record.request.turnId,
        itemId: record.request.itemId,
        method: record.request.method,
        paramsJson: JSON.stringify(record.request.params),
        status: 'pending',
        createdAt: record.request.createdAt,
        resolvedAt: null,
        resolutionJson: null,
      })
      .run();
  }

  private resolveRequest(
    record: Extract<ThreadRecord, { kind: 'serverRequest.resolved' }>,
  ): void {
    const status =
      record.resolution === 'resolved'
        ? 'resolved'
        : record.resolution === 'rejected'
          ? 'rejected'
          : 'cancelled';
    const result = this.db
      .update(threadRequestCatalog)
      .set({
        status,
        resolvedAt: record.createdAt,
        resolutionJson: JSON.stringify({ resolution: record.resolution }),
      })
      .where(
        and(
          eq(threadRequestCatalog.id, record.requestId),
          eq(threadRequestCatalog.threadId, record.threadId),
          eq(threadRequestCatalog.turnId, record.turnId),
          eq(threadRequestCatalog.itemId, record.itemId),
          eq(threadRequestCatalog.status, 'pending'),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error(
        `Thread catalog has no pending Server Request ${record.requestId}.`,
      );
    }
  }

  private statusAfterRequestResolution(
    threadId: string,
  ): ThreadStatus | undefined {
    const pending = this.db
      .select({ id: threadRequestCatalog.id })
      .from(threadRequestCatalog)
      .where(
        and(
          eq(threadRequestCatalog.threadId, threadId),
          eq(threadRequestCatalog.status, 'pending'),
        ),
      )
      .limit(1)
      .get();
    if (pending !== undefined) return undefined;
    const activeTurn = this.db
      .select({ id: threadTurnCatalog.id })
      .from(threadTurnCatalog)
      .where(
        and(
          eq(threadTurnCatalog.threadId, threadId),
          eq(threadTurnCatalog.status, 'inProgress'),
        ),
      )
      .limit(1)
      .get();
    return activeTurn === undefined ? 'idle' : 'running';
  }

  private insertCompaction(
    record: Extract<ThreadRecord, { kind: 'compaction' }>,
  ): void {
    this.db
      .insert(threadCheckpointCatalog)
      .values({
        id: `${record.threadId}:${record.seq}`,
        threadId: record.threadId,
        turnId: record.turnId,
        kind: 'compaction',
        summary: record.summary,
        firstKeptSeq: record.firstKeptSeq,
        tokensBefore: record.tokensBefore,
        artifactId: null,
        createdAt: record.createdAt,
      })
      .run();
  }
}

function itemStatus(item: ThreadItem): string | null {
  return 'status' in item ? item.status : null;
}

function assertRebuildRecords(records: readonly ThreadRecord[]): void {
  const first = records[0];
  if (first === undefined || first.kind !== 'thread.created') {
    throw new Error('Thread catalog rebuild requires thread.created first.');
  }
  for (const [index, record] of records.entries()) {
    if (record.threadId !== first.threadId) {
      throw new Error(
        `Thread catalog rebuild mixed ${first.threadId} and ${record.threadId}.`,
      );
    }
    if (record.seq !== index + 1) {
      throw new Error(
        `Thread catalog rebuild expected seq ${index + 1}, got ${record.seq}.`,
      );
    }
  }
}
