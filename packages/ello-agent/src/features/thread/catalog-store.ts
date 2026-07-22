/**
 * Thread catalog 把 JSONL records 事务化投影到 SQLite 查询表。
 *
 * 本文件只拥有可从完整 record 序列重建的查询投影，不拥有 Thread 日志、lease 或进程内状态。
 * 每次 apply 必须严格连续推进 seq；rebuild 必须在单个事务内替换完整投影，失败时保留原数据。
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import {
  immediateTransaction,
  type CodingDatabase,
} from '../../infra/database/database.js';
import {
  threadCatalog,
  threadCheckpointCatalog,
  threadItemCatalog,
  threadRequestCatalog,
  threadTurnCatalog,
} from '../../infra/database/schema.js';
import {
  ThreadItemSchema,
  ThreadSummarySchema,
  type ThreadItem,
  type ThreadStatus,
  type ThreadSummary,
  type Turn,
} from '../../protocol/v1/index.js';
import type { ThreadRecord } from '../../storage/threads/thread-record.js';

import { projectThreadItemDelta } from './records.js';

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

export interface ThreadCatalogProjection {
  /**
   * 在 Thread `catalog-store` 模块 中执行 `apply` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `record`: 要由 `apply` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Thread `catalog-store` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  apply(record: ThreadRecord): void;
  /**
   * 执行 Thread `catalog-store` 模块 定义的 `rebuild` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `records`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   *
   * Returns:
   * - Thread `catalog-store` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  rebuild(records: ReadonlyArray<ThreadRecord>): void;
  /**
   * 按 Thread `catalog-store` 模块 的一致性约束执行 `delete` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   *
   * Throws:
   * - 当 Thread `catalog-store` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  delete(threadId: string): boolean;
  /**
   * 执行 Thread `catalog-store` 模块 定义的 `state` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  state(threadId: string): ThreadCatalogState | null;
  /**
   * 执行 Thread `catalog-store` 模块 定义的 `states` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  states(): ReadonlyArray<ThreadCatalogState>;
  /**
   * 读取 Thread `catalog-store` 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `options`: 仅作用于 `list` 的调用选项；函数只读取该对象，不保留可变引用。
   *
   * Returns:
   * - 返回 `list` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  list(options: ThreadCatalogListOptions): ThreadCatalogPage;
}

/**
 * 创建绑定单个 SQLite 数据库的 Thread catalog 投影。
 *
 * Args:
 * - `database`: 已打开的应用数据库；调用方拥有并负责其关闭生命周期。
 *
 * Returns:
 * - 返回严格按 record seq 事务化推进、并能从完整 JSONL records 原子重建的投影对象。
 */
export function createThreadCatalog(
  database: CodingDatabase,
): ThreadCatalogProjection {
  return {
    apply(record) {
      immediateTransaction(database, () =>
        applyCatalogRecord(database, record),
      );
    },
    rebuild(records) {
      assertRebuildRecords(records);
      immediateTransaction(database, () => {
        database
          .delete(threadCatalog)
          .where(eq(threadCatalog.id, records[0].threadId))
          .run();
        for (const record of records) applyCatalogRecord(database, record);
      });
    },
    delete(threadId) {
      return immediateTransaction(
        database,
        () =>
          database
            .delete(threadCatalog)
            .where(eq(threadCatalog.id, threadId))
            .run().changes > 0,
      );
    },
    state: (threadId) => catalogState(database, threadId),
    states: () => catalogStates(database),
    list: (options) => listCatalog(database, options),
  };
}

function catalogState(
  database: CodingDatabase,
  threadId: string,
): ThreadCatalogState | null {
  const row = database
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

function catalogStates(
  database: CodingDatabase,
): ReadonlyArray<ThreadCatalogState> {
  return database
    .select({
      id: threadCatalog.id,
      seq: threadCatalog.seq,
      archived: threadCatalog.archived,
    })
    .from(threadCatalog)
    .orderBy(asc(threadCatalog.id))
    .all();
}

function listCatalog(
  database: CodingDatabase,
  options: ThreadCatalogListOptions,
): ThreadCatalogPage {
  const filter =
    options.cwd === undefined
      ? eq(threadCatalog.archived, options.archived)
      : and(
          eq(threadCatalog.archived, options.archived),
          eq(threadCatalog.cwd, options.cwd),
        );
  const rows = database
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

function applyCatalogRecord(
  database: CodingDatabase,
  record: ThreadRecord,
): void {
  if (record.kind === 'thread.created') {
    applyCreatedRecord(database, record);
    return;
  }
  const current = catalogState(database, record.threadId);
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
      applyMetadataRecord(database, record);
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
      insertTurn(database, record.threadId, record.turn, record.seq);
      status = 'running';
      break;
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
      completeTurn(database, record.turn, record.seq);
      status =
        record.kind === 'turn.completed'
          ? 'idle'
          : record.kind === 'turn.interrupted'
            ? 'interrupted'
            : 'failed';
      break;
    case 'item.started':
      insertItem(
        database,
        record.threadId,
        record.turnId,
        record.item,
        record.seq,
      );
      break;
    case 'item.delta':
      applyItemDelta(database, record);
      break;
    case 'item.completed':
      completeItem(database, record);
      break;
    case 'serverRequest.created':
      createRequest(database, record);
      status =
        record.request.method === 'item/tool/requestUserInput'
          ? 'awaitingUserInput'
          : 'awaitingApproval';
      break;
    case 'serverRequest.resolved':
      resolveRequest(database, record);
      status = statusAfterRequestResolution(database, record.threadId);
      break;
    case 'compaction':
      insertCompaction(database, record);
      break;
    case 'transcript.entry':
    case 'goal.state':
    case 'plan.state':
    case 'content.replacement':
    case 'usage.updated':
      break;
    default:
      record satisfies never;
      throw new Error(`Unhandled Thread record: ${String(record)}`);
  }

  database
    .update(threadCatalog)
    .set({
      seq: record.seq,
      updatedAt: record.createdAt,
      ...(status === undefined ? {} : { status }),
    })
    .where(eq(threadCatalog.id, record.threadId))
    .run();
}

function applyCreatedRecord(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'thread.created' }>,
): void {
  if (record.seq !== 1) {
    throw new Error(
      `thread.created for ${record.threadId} must have seq 1, got ${record.seq}.`,
    );
  }
  if (catalogState(database, record.threadId) !== null) {
    throw new Error(`Thread catalog ${record.threadId} already exists.`);
  }
  database
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

function applyMetadataRecord(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'thread.metadata' }>,
): void {
  if (
    record.name === undefined &&
    record.preview === undefined &&
    record.archived === undefined
  ) {
    return;
  }
  database
    .update(threadCatalog)
    .set({
      ...(record.name === undefined ? {} : { name: record.name }),
      ...(record.preview === undefined ? {} : { preview: record.preview }),
      ...(record.archived === undefined ? {} : { archived: record.archived }),
    })
    .where(eq(threadCatalog.id, record.threadId))
    .run();
}

function insertTurn(
  database: CodingDatabase,
  threadId: string,
  turn: Turn,
  seq: number,
): void {
  if (turn.threadId !== threadId) {
    throw new Error(`Turn ${turn.id} belongs to ${turn.threadId}.`);
  }
  database
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
    insertItem(database, threadId, turn.id, item, seq);
  }
}

function completeTurn(database: CodingDatabase, turn: Turn, seq: number): void {
  const result = database
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

function insertItem(
  database: CodingDatabase,
  threadId: string,
  turnId: string,
  item: ThreadItem,
  seq: number,
): void {
  if (item.turnId !== turnId) {
    throw new Error(`Item ${item.id} does not belong to turn ${turnId}.`);
  }
  database
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

function applyItemDelta(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'item.delta' }>,
): void {
  const row = database
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
  database
    .update(threadItemCatalog)
    .set({ payloadJson: JSON.stringify(projected), seq: record.seq })
    .where(eq(threadItemCatalog.id, record.itemId))
    .run();
}

function completeItem(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'item.completed' }>,
): void {
  if (record.item.turnId !== record.turnId) {
    throw new Error(
      `Item ${record.item.id} does not belong to turn ${record.turnId}.`,
    );
  }
  const result = database
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

function createRequest(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'serverRequest.created' }>,
): void {
  if (record.request.threadId !== record.threadId) {
    throw new Error(
      `Server Request ${record.request.id} belongs to ${record.request.threadId}.`,
    );
  }
  database
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

function resolveRequest(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'serverRequest.resolved' }>,
): void {
  const status =
    record.resolution === 'resolved'
      ? 'resolved'
      : record.resolution === 'rejected'
        ? 'rejected'
        : 'cancelled';
  const result = database
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

function statusAfterRequestResolution(
  database: CodingDatabase,
  threadId: string,
): ThreadStatus | undefined {
  const pending = database
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
  const activeTurn = database
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

function insertCompaction(
  database: CodingDatabase,
  record: Extract<ThreadRecord, { kind: 'compaction' }>,
): void {
  database
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

function itemStatus(item: ThreadItem): string | null {
  return 'status' in item ? item.status : null;
}

function assertRebuildRecords(
  records: ReadonlyArray<ThreadRecord>,
): asserts records is readonly [ThreadRecord, ...ThreadRecord[]] {
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
