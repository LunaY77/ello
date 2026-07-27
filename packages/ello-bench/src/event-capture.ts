/**
 * benchmark 将完整 EngineEvent 逐行归档为脱敏 JSONL，并在关闭时写入完成标记。
 *
 * recorder 写入失败会直接中止 Agent run，确保不产生缺少原始证据的可发布结果。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentEventRecorder } from '@ello/agent/runtime';

import { EventCaptureSchema } from './contracts.js';

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
  private closed = false;
  private lastSequence = 0;
  private eventCount = 0;
  private runCount = 0;
  private turnCount = 0;
  private modelCallCount = 0;

  constructor(readonly eventLogPath: string) {
    this.completePath = `${eventLogPath}.complete.json`;
    this.ready = mkdir(path.dirname(eventLogPath), { recursive: true }).then(
      () => writeFile(eventLogPath, '', 'utf8'),
    );
    this.recorder = {
      record: async (event) => this.record(event),
      flush: async () => this.flush(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
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
    this.closed = true;
  }

  private async record(event: RecordedEvent): Promise<void> {
    if (this.closed) {
      throw new Error(
        `Cannot record after capture close: ${this.eventLogPath}`,
      );
    }
    const payload = redact(event);
    if (!isRecord(payload)) {
      throw new TypeError('Engine event must serialize to an object payload.');
    }
    const capture = EventCaptureSchema.parse({
      schema: 'ello.benchmark.event-capture.v1',
      sequence: event.sequence,
      event: event.type,
      payload,
    });
    // 序号校验与落盘之间不能存在 await：否则并发 record 会全部先通过校验、再
    // 乱序写入，校验形同虚设。把两者串进同一条写入链，使校验与写入原子。
    const written = this.writes.then(async () => {
      if (event.sequence <= this.lastSequence) {
        throw new Error(
          `Engine event sequence must increase: ${event.sequence} after ${this.lastSequence}.`,
        );
      }
      await this.ready;
      await appendFile(
        this.eventLogPath,
        `${JSON.stringify(capture)}\n`,
        'utf8',
      );
      this.lastSequence = event.sequence;
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
