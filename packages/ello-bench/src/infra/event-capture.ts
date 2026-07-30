/**
 * benchmark 将完整 EngineEvent 逐行归档为脱敏 JSONL，并在关闭时写入完成标记。
 *
 * recorder 写入失败会直接中止 Agent run，确保不产生缺少原始证据的可发布结果。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentEventRecorder } from '@ello/agent/runtime';

import { EventCaptureSchema } from '../domain/contract/index.js';

type RecordedEvent = Parameters<AgentEventRecorder['record']>[0];

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
    const content = await readFile(this.eventLogPath);
    const checksum = createHash('sha256').update(content).digest('hex');
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
    const payload = redact(event);
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
    let source: string;
    try {
      source = await readFile(this.eventLogPath, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await writeFile(this.eventLogPath, '', 'utf8');
      return;
    }
    const captures = source
      .split(/\r?\n/u)
      .filter((line) => line !== '')
      .map((line) => EventCaptureSchema.parse(JSON.parse(line) as unknown));
    this.eventCount = captures.length;
    for (const capture of captures) {
      if (capture.event === 'run.started') this.runCount += 1;
      if (capture.event === 'turn.started') this.turnCount += 1;
      if (capture.event === 'model.started') this.modelCallCount += 1;
      const runId = capture.payload.runId;
      const sequence = capture.payload.sequence;
      if (typeof runId === 'string' && typeof sequence === 'number') {
        this.lastSequenceByRun.set(runId, sequence);
      }
    }
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, child]) => [key, redact(child)]),
  );
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
