import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCodingStorage,
  type CodingStorage,
} from '../../src/storage/database/index.js';
import {
  createTaskService,
  TaskEventBus,
  type TaskEvent,
  type TaskService,
} from '../../src/storage/tasks/index.js';

describe('TaskBoardRepository', () => {
  let oldHome: string | undefined;
  let home: string;
  let storage: CodingStorage;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-task-board-'));
    process.env.ELLO_HOME = home;
    storage = createCodingStorage();
  });

  afterEach(async () => {
    storage.close();
    if (oldHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });

  it('隔离不同 session board，并在 board 内独立递增 sequence', () => {
    const first = sessionService('session-a');
    const second = sessionService('session-b');
    const firstTask = first.create({ subject: 'first' });
    const secondTask = second.create({ subject: 'second' });

    expect(firstTask.sequence).toBe(1);
    expect(secondTask.sequence).toBe(1);
    expect(firstTask.id).not.toBe(secondTask.id);
    expect(first.list()).toHaveLength(1);
    expect(second.list()).toHaveLength(1);
  });

  it('只保存单向 dependency，并投影 blocks 与 blockedBy', () => {
    const service = sessionService('session-a');
    const blocker = service.create({ subject: 'blocker' });
    const blocked = service.create({
      subject: 'blocked',
      blockedBy: [String(blocker.sequence)],
    });

    expect(service.get(String(blocker.sequence))?.blocks).toMatchObject([
      { id: blocked.id, sequence: blocked.sequence },
    ]);
    expect(service.get(String(blocked.sequence))?.blockedBy).toMatchObject([
      { id: blocker.id, sequence: blocker.sequence },
    ]);
  });

  it('blocker 完成后解除 claim 阻塞但保留 dependency', () => {
    const service = sessionService('session-a');
    const blocker = service.create({ subject: 'blocker' });
    const blocked = service.create({
      subject: 'blocked',
      blockedBy: [String(blocker.sequence)],
    });

    expect(service.claim(String(blocked.sequence), 'worker').ok).toBe(false);
    service.update(String(blocker.sequence), { status: 'completed' });
    expect(service.claim(String(blocked.sequence), 'worker').ok).toBe(true);
    expect(service.get(String(blocked.sequence))?.blockedBy).toHaveLength(1);
  });

  it('拒绝 self dependency 和 cross-board dependency', () => {
    const first = sessionService('session-a');
    const second = sessionService('session-b');
    const foreign = second.create({ subject: 'foreign' });

    expect(() =>
      first.create({ subject: 'cross', blockedBy: [foreign.id] }),
    ).toThrow('belongs to another board');
    expect(() => first.create({ subject: 'self', blockedBy: ['1'] })).toThrow(
      'Task cannot depend on itself',
    );
    expect(first.list()).toHaveLength(0);
  });

  it('两个 claim 竞争只有一个 owner 成功', async () => {
    const service = sessionService('session-a');
    const task = service.create({ subject: 'claim me' });
    const secondStorage = createCodingStorage();
    const secondService = createTaskService(secondStorage.taskBoards, {
      type: 'session',
      sessionId: 'session-a',
    });
    const results = await Promise.all([
      Promise.resolve().then(() => service.claim(String(task.sequence), 'a')),
      Promise.resolve().then(() =>
        secondService.claim(String(task.sequence), 'b'),
      ),
    ]);
    secondStorage.close();

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
  });

  it('mutation 失败时不保留 task、dependency 或 sequence 半状态', () => {
    const service = sessionService('session-a');
    expect(() =>
      service.create({ subject: 'broken', blockedBy: ['999'] }),
    ).toThrow('Unknown task');

    const created = service.create({ subject: 'valid' });
    expect(created.sequence).toBe(1);
    expect(service.list()).toHaveLength(1);
  });

  it('reset 只清理当前 board', () => {
    const first = sessionService('session-a');
    const second = sessionService('session-b');
    first.create({ subject: 'first' });
    second.create({ subject: 'second' });

    first.reset();

    expect(first.list()).toHaveLength(0);
    expect(second.list()).toHaveLength(1);
    expect(first.create({ subject: 'again' }).sequence).toBe(1);
  });

  it('mutation 发出 board 绑定后的任务事件', () => {
    const events: TaskEvent[] = [];
    const bus = new TaskEventBus();
    bus.subscribe((event) => events.push(event));
    const service = createTaskService(
      storage.taskBoards,
      { type: 'session', sessionId: 'session-events' },
      bus,
    );
    const task = service.create({ subject: 'event' });
    service.update(String(task.sequence), { status: 'completed' });
    service.delete(String(task.sequence));

    expect(events.map((event) => event.type)).toContain('task.changed');
    expect(events.map((event) => event.type)).toContain('task.list.changed');
    expect(events.map((event) => event.type)).toContain('task.deleted');
  });

  function sessionService(sessionId: string): TaskService {
    return createTaskService(storage.taskBoards, {
      type: 'session',
      sessionId,
    });
  }
});
