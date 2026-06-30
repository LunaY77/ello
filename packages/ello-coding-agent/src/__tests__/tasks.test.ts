import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTaskStore } from '../tasks/file-store.js';
import { TaskEventBus, type TaskEvent } from '../tasks/index.js';
import { TaskService } from '../tasks/service.js';

describe('TaskService', () => {
  let dir: string;
  let service: TaskService;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ello-tasks-'));
    service = new TaskService(new FileTaskStore(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('支持任务 CRUD', async () => {
    const created = await service.create({
      subject: '实现配置初始化',
      description: '确保 ~/.ello/config.toml 存在',
    });

    expect(created.id).toBe('1');
    expect(await service.get('1')).toMatchObject({
      subject: '实现配置初始化',
      status: 'pending',
    });

    const updated = await service.update('1', {
      status: 'completed',
      owner: 'codex',
    });
    expect(updated.status).toBe('completed');
    expect(updated.owner).toBe('codex');

    expect(await service.list()).toHaveLength(1);
    expect(await service.delete('1')).toBe(true);
    expect(await service.get('1')).toBeNull();
  });

  it('删除后不会复用任务 ID', async () => {
    await service.create({ subject: 'first' });
    await service.delete('1');
    const next = await service.create({ subject: 'second' });

    expect(next.id).toBe('2');
  });

  it('并发创建任务时不会分配重复 ID', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.create({ subject: `task-${index}` }),
      ),
    );

    expect(new Set(created.map((task) => task.id)).size).toBe(20);
    expect(
      created.map((task) => task.id).sort((a, b) => Number(a) - Number(b)),
    ).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)));
  });

  it('维护 blocks / blockedBy 双向关系并在完成后自动解除阻塞', async () => {
    const blocker = await service.create({ subject: '先改配置' });
    const blocked = await service.create({
      subject: '再跑验证',
      blockedBy: [blocker.id],
    });

    expect(await service.get(blocker.id)).toMatchObject({
      blocks: [blocked.id],
    });

    await service.update(blocker.id, { status: 'completed' });

    expect(await service.get(blocked.id)).toMatchObject({
      blockedBy: [],
    });
  });

  it('claim 会拒绝被阻塞或已被其他 owner 占用的任务', async () => {
    const blocker = await service.create({ subject: 'blocker' });
    const blocked = await service.create({
      subject: 'blocked',
      blockedBy: [blocker.id],
    });

    expect(await service.claim(blocked.id, 'a')).toMatchObject({
      ok: false,
    });

    await service.update(blocker.id, { status: 'completed' });
    expect(await service.claim(blocked.id, 'a')).toMatchObject({
      ok: true,
    });
    expect(await service.claim(blocked.id, 'b')).toMatchObject({
      ok: false,
    });
  });

  it('状态变化会发出任务事件', async () => {
    const events: TaskEvent[] = [];
    const bus = new TaskEventBus();
    service = new TaskService(new FileTaskStore(dir), bus);
    bus.subscribe((event) => events.push(event));

    const task = await service.create({ subject: 'event' });
    await service.update(task.id, { status: 'completed' });
    await service.delete(task.id);

    expect(events.map((event) => event.type)).toContain('task.changed');
    expect(events.map((event) => event.type)).toContain('task.list.changed');
    expect(events.map((event) => event.type)).toContain('task.deleted');
  });
});
