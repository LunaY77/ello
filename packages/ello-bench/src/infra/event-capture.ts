/**
 * benchmark 将完整 EngineEvent 逐行归档为脱敏 JSONL，并在关闭时写入完成标记。
 *
 * recorder 写入失败会直接中止 Agent run，确保不产生缺少原始证据的可发布结果。
 */
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { AgentEventRecorder } from '@ello/agent/runtime';

import {
  EventCaptureSchema,
  type EventCapture,
} from '../domain/contract/index.js';

import { sha256File } from './io.js';

type RecordedEvent = Parameters<AgentEventRecorder['record']>[0];

const MAX_REDACTION_DEPTH = 64;
const CIRCULAR_VALUE = '[Circular]';
const TRUNCATED_VALUE = '[Truncated]';

export interface EventCaptureRecorder {
  readonly eventLogPath: string;
  readonly completePath: string;
  readonly recorder: AgentEventRecorder;
  close(): Promise<void>;
}

export function createEventCaptureRecorder(
  eventLogPath: string,
): EventCaptureRecorder {
  return new JsonlEventCaptureRecorder(eventLogPath);
}

class JsonlEventCaptureRecorder implements EventCaptureRecorder {
  readonly completePath: string;
  readonly recorder: AgentEventRecorder;
  private readonly ready: Promise<void>;
  /** 落盘链尾指针，保证序号校验与追加写入成对且互不交错。 */
  private writes: Promise<void> = Promise.resolve();
  private finalized = false;
  private readonly lastSequenceByRun = new Map<string, number>();
  private eventCount = 0;
  private runCount = 0;
  private turnCount = 0;
  private modelCallCount = 0;

  constructor(readonly eventLogPath: string) {
    this.completePath = `${eventLogPath}.complete.json`;
    this.ready = this.initialize();
    this.recorder = {
      record: async (event) => this.record(event),
      flush: async () => this.flush(),
    };
  }

  async close(): Promise<void> {
    if (this.finalized) {
      throw new Error(`Event capture already closed: ${this.eventLogPath}`);
    }
    await this.flush();
    const checksum = await sha256File(this.eventLogPath);
    await writeFile(
      this.completePath,
      `${JSON.stringify({
        schema: 'ello.benchmark.event-capture.complete.v1',
        eventLogPath: this.eventLogPath,
        eventCount: this.eventCount,
        runCount: this.runCount,
        turnCount: this.turnCount,
        modelCallCount: this.modelCallCount,
        sha256: checksum,
      })}\n`,
      'utf8',
    );
    this.finalized = true;
  }

  private async record(event: RecordedEvent): Promise<void> {
    // Provider recovery reuses the same thread and recorder after a completed
    // tracing lifecycle. New events reopen the capture and the next close
    // atomically replaces its completion marker.
    this.finalized = false;
    const payload = redact(project(event));
    if (!isRecord(payload)) {
      throw new TypeError('Engine event must serialize to an object payload.');
    }
    // 序号校验与落盘之间不能存在 await：否则并发 record 会全部先通过校验、再
    // 乱序写入，校验形同虚设。把两者串进同一条写入链，使校验与写入原子。
    const written = this.writes.then(async () => {
      await this.ready;
      const previousSequence = this.lastSequenceByRun.get(event.runId) ?? 0;
      if (event.sequence <= previousSequence) {
        throw new Error(
          `Engine event sequence must increase for run ${event.runId}: ${event.sequence} after ${previousSequence}.`,
        );
      }
      const capture = EventCaptureSchema.parse({
        schema: 'ello.benchmark.event-capture.v1',
        sequence: this.eventCount + 1,
        event: event.type,
        payload,
      });
      await appendFile(
        this.eventLogPath,
        `${JSON.stringify(capture)}\n`,
        'utf8',
      );
      this.lastSequenceByRun.set(event.runId, event.sequence);
      this.eventCount += 1;
      if (event.type === 'run.started') this.runCount += 1;
      if (event.type === 'turn.started') this.turnCount += 1;
      if (event.type === 'model.started') this.modelCallCount += 1;
    });
    this.writes = written.then(
      () => undefined,
      () => undefined,
    );
    await written;
  }

  private async flush(): Promise<void> {
    // 排在写入链尾，确保 flush 与 close 观察到的是全部已受理事件。
    await this.writes;
    await this.ready;
    const handle = await open(this.eventLogPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.eventLogPath), { recursive: true });
    try {
      await forEachExistingCapture(this.eventLogPath, (capture) => {
        this.eventCount += 1;
        if (capture.event === 'run.started') this.runCount += 1;
        if (capture.event === 'turn.started') this.turnCount += 1;
        if (capture.event === 'model.started') this.modelCallCount += 1;
        const runId = capture.payload.runId;
        const sequence = capture.payload.sequence;
        if (typeof runId === 'string' && typeof sequence === 'number') {
          this.lastSequenceByRun.set(runId, sequence);
        }
      });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await writeFile(this.eventLogPath, '', 'utf8');
    }
  }
}

async function forEachExistingCapture(
  eventLogPath: string,
  visit: (capture: EventCapture) => void,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(eventLogPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line === '') continue;
      try {
        visit(EventCaptureSchema.parse(JSON.parse(line) as unknown));
      } catch (error) {
        throw new Error(`Invalid event capture line ${lineNumber}.`, {
          cause: error,
        });
      }
    }
  } finally {
    lines.close();
  }
}

/**
 * 把两个二次增长的 model 事件投影成定长摘要。
 *
 * `model.started.request` 携带本次请求的**全部**消息，`model.completed.response` 携带
 * 全部消息加响应文本，于是第 k 轮写入的内容包含前 k-1 轮：一次 279 轮的 run 里这两类
 * 事件就占了 588MB 中的 453MB，长会话必然撞上 V8 单字符串上限并让整份证据不可读。
 *
 * 归一化只读 identity、occurredAt、diagnostics.toolsetFingerprint、response.finishReason、
 * response.usage 和 response.toolCalls 的 id/name，所以这里保留这些字段，并把被裁掉的
 * 部分换成显式计数，避免看起来像「本来就没有」。
 *
 * Args:
 * - `event`: 引擎原样交付的事件。
 *
 * Returns:
 * - 需要裁剪的事件返回投影副本，其余事件原样返回。
 */
function project(event: RecordedEvent): unknown {
  if (event.type === 'model.started') {
    const { request, ...rest } = event as RecordedEvent & {
      readonly request?: Record<string, unknown>;
    };
    return { ...rest, requestSummary: summarizeRequest(request) };
  }
  if (event.type === 'model.completed') {
    const { response, ...rest } = event as RecordedEvent & {
      readonly response?: Record<string, unknown>;
    };
    return { ...rest, response: summarizeResponse(response) };
  }
  return event;
}

function summarizeRequest(
  request: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (request === undefined) return { messageCount: 0 };
  const messages = request.messages;
  const tools = request.tools;
  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    toolCount:
      typeof tools === 'object' && tools !== null
        ? Object.keys(tools).length
        : 0,
    ...(Array.isArray(request.activeTools)
      ? { activeTools: request.activeTools }
      : {}),
    ...(isRecord(request.modelSettings)
      ? { modelSettings: request.modelSettings }
      : {}),
  };
}

function summarizeResponse(
  response: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (response === undefined) return {};
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  const text = response.text;
  return {
    ...(response.finishReason === undefined
      ? {}
      : { finishReason: response.finishReason }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    toolCalls: toolCalls.map((toolCall) =>
      isRecord(toolCall)
        ? {
            ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
            ...(toolCall.name === undefined ? {} : { name: toolCall.name }),
          }
        : toolCall,
    ),
    textLength: typeof text === 'string' ? text.length : 0,
    messageCount: Array.isArray(response.messages)
      ? response.messages.length
      : 0,
    newMessageCount: Array.isArray(response.newMessages)
      ? response.newMessages.length
      : 0,
  };
}

function redact(
  value: unknown,
  ancestors = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) return CIRCULAR_VALUE;
  if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED_VALUE;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((child) => redact(child, ancestors, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, child]) => [key, redact(child, ancestors, depth + 1)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return /^(authorization|api[_-]?key|secret|credential|password|access[_-]?token|refresh[_-]?token|env)$/iu.test(
    key,
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
