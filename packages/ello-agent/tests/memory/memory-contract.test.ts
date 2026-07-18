import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentToolContext } from '../../src/agent/engine/index.js';
import {
  MemoryIndexLoader,
  shouldIgnoreMemory,
} from '../../src/agent/memory/index-loader.js';
import { MemoryRepository } from '../../src/agent/memory/repository.js';
import { createProductionToolRuntime } from '../../src/agent/tools/production.js';
import { CodingAgentConfigSchema } from '../../src/config/schema.js';
import type { ServerConnection } from '../../src/server/connection/server-connection.js';
import { ServerServices } from '../../src/server/methods/server-services.js';
import { createCodingStorage } from '../../src/storage/database/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRepository(): Promise<MemoryRepository> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-memory-contract-'));
  temporaryDirectories.push(root);
  const repository = new MemoryRepository({
    private: path.join(root, 'private'),
    team: path.join(root, 'team'),
  });
  await repository.initialize();
  return repository;
}

function topic(input: {
  readonly name: string;
  readonly description: string;
  readonly type: 'user' | 'feedback' | 'project' | 'reference';
  readonly body: string;
}): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    `type: ${input.type}`,
    '---',
    '',
    input.body,
    '',
  ].join('\n');
}

describe('Memory 文件与索引契约', () => {
  it('初始化两个作用域并保持幂等的空索引', async () => {
    const repository = await createRepository();

    expect(await repository.status()).toEqual({
      privateEntries: 0,
      teamEntries: 0,
    });
    await repository.initialize();
    await expect(
      readFile(path.join(repository.roots.private, 'MEMORY.md'), 'utf8'),
    ).resolves.toBe('');
    await expect(
      readFile(path.join(repository.roots.team, 'MEMORY.md'), 'utf8'),
    ).resolves.toBe('');
  });

  it('按 revision 创建、更新和删除主题并同步维护摘要索引', async () => {
    const repository = await createRepository();
    const created = await repository.write(
      'private',
      'collaboration-style.md',
      null,
      topic({
        name: 'Collaboration style',
        description: 'Prefer source-grounded updates',
        type: 'user',
        body: 'The user prefers source-grounded implementation updates.',
      }),
    );

    expect(created.operation).toBe('created');
    expect((await repository.read('private', 'MEMORY.md')).content).toBe(
      '- [Collaboration style](collaboration-style.md) — Prefer source-grounded updates\n',
    );
    expect(
      (await repository.read('private', 'MEMORY.md')).content,
    ).not.toContain('implementation updates');

    await expect(
      repository.write(
        'private',
        'collaboration-style.md',
        'stale-revision',
        topic({
          name: 'Collaboration style',
          description: 'Prefer concise updates',
          type: 'user',
          body: 'The user prefers concise updates.',
        }),
      ),
    ).rejects.toThrow('Memory revision conflict');

    const current = await repository.read('private', 'collaboration-style.md');
    expect(
      await repository.write(
        'private',
        'collaboration-style.md',
        current.revision,
        topic({
          name: 'Collaboration style',
          description: 'Prefer concise updates',
          type: 'user',
          body: 'The user prefers concise updates.',
        }),
      ),
    ).toMatchObject({ operation: 'updated' });

    const updated = await repository.read('private', 'collaboration-style.md');
    expect(
      await repository.delete(
        'private',
        'collaboration-style.md',
        updated.revision,
      ),
    ).toMatchObject({ operation: 'deleted', revision: null });
    expect(await repository.status()).toEqual({
      privateEntries: 0,
      teamEntries: 0,
    });
  });

  it('搜索名称、说明和正文并支持作用域过滤', async () => {
    const repository = await createRepository();
    await repository.write(
      'private',
      'typescript.md',
      null,
      topic({
        name: 'TypeScript preference',
        description: 'Prefer strict typing',
        type: 'user',
        body: 'Use strict TypeScript for application code.',
      }),
    );
    await repository.write(
      'team',
      'release-reference.md',
      null,
      topic({
        name: 'Release reference',
        description: 'Release handbook',
        type: 'reference',
        body: 'The TypeScript package must pass verification before release.',
      }),
    );

    expect(
      (await repository.search('typescript')).map((match) => match.scope),
    ).toEqual(['private', 'team']);
    expect(await repository.search('release', 'private')).toEqual([]);
    await expect(repository.search('   ')).rejects.toThrow('must not be empty');
  });

  it('拒绝错误作用域、主题格式、路径和重复名称且不污染索引', async () => {
    const repository = await createRepository();

    await expect(
      repository.write(
        'team',
        'user-role.md',
        null,
        topic({
          name: 'User role',
          description: 'User role details',
          type: 'user',
          body: 'The user is a platform engineer.',
        }),
      ),
    ).rejects.toThrow('user memories must use private scope');
    await expect(
      repository.write(
        'team',
        'testing-policy.md',
        null,
        topic({
          name: 'Testing policy',
          description: 'Use a real database',
          type: 'feedback',
          body: 'Use a real database.',
        }),
      ),
    ).rejects.toThrow('must contain **Why:** and **How to apply:**');
    await expect(
      repository.write(
        'team',
        '../escape.md',
        null,
        topic({
          name: 'Escape',
          description: 'Invalid path',
          type: 'reference',
          body: 'Invalid path.',
        }),
      ),
    ).rejects.toThrow('Invalid memory topic file');

    const first = topic({
      name: 'Shared name',
      description: 'First entry',
      type: 'reference',
      body: 'First body.',
    });
    await repository.write('team', 'first.md', null, first);
    await expect(
      repository.write(
        'team',
        'second.md',
        null,
        topic({
          name: 'Shared name',
          description: 'Second entry',
          type: 'reference',
          body: 'Second body.',
        }),
      ),
    ).rejects.toThrow('Duplicate memory name');
    expect(
      (await repository.list('team')).map((record) => record.file),
    ).toEqual(['first.md']);
  });

  it('拒绝超长索引行、符号链接主题和不一致的手工索引', async () => {
    const repository = await createRepository();
    await expect(
      repository.write(
        'team',
        'oversized-index.md',
        null,
        topic({
          name: 'Oversized index',
          description: 'x'.repeat(220),
          type: 'reference',
          body: 'External reference.',
        }),
      ),
    ).rejects.toThrow('exceeds 200 characters');

    const outside = path.join(
      path.dirname(repository.roots.team),
      'outside.md',
    );
    await writeFile(outside, 'outside', 'utf8');
    await symlink(outside, path.join(repository.roots.team, 'linked.md'));
    await expect(repository.list('team')).rejects.toThrow(
      'Invalid memory directory entry',
    );
    await rm(path.join(repository.roots.team, 'linked.md'));

    await writeFile(
      path.join(repository.roots.team, 'MEMORY.md'),
      '- [Ghost](ghost.md) — Missing topic\n',
      'utf8',
    );
    await expect(repository.initialize()).rejects.toThrow(
      'does not match its topic files',
    );
  });
});

describe('Memory 上下文加载契约', () => {
  it('只加载两个索引而不注入主题正文，并按显式失效刷新快照', async () => {
    const repository = await createRepository();
    await repository.write(
      'private',
      'profile.md',
      null,
      topic({
        name: 'User profile',
        description: 'User prefers concise answers',
        type: 'user',
        body: 'TOPIC_BODY_MUST_NOT_BE_IN_CONTEXT',
      }),
    );
    const loader = new MemoryIndexLoader(repository);

    const first = await loader.load();
    expect(first.sources).toHaveLength(2);
    expect(first.sources.map((source) => source.id)).toEqual([
      'memory:private',
      'memory:team',
    ]);
    expect(first.sources[0]?.content).toContain('User profile');
    expect(first.sources[0]?.content).not.toContain(
      'TOPIC_BODY_MUST_NOT_BE_IN_CONTEXT',
    );

    await repository.write(
      'team',
      'reference.md',
      null,
      topic({
        name: 'Team reference',
        description: 'Shared reference',
        type: 'reference',
        body: 'Shared full body.',
      }),
    );
    expect((await loader.load()).sources[1]?.content).not.toContain(
      'Team reference',
    );
    loader.invalidate();
    expect((await loader.load()).sources[1]?.content).toContain(
      'Team reference',
    );
  });

  it('识别字符串、prompt 和用户消息中的忽略记忆指令', () => {
    expect(shouldIgnoreMemory('Ignore memory for this request.')).toBe(true);
    expect(shouldIgnoreMemory({ prompt: "Don't use the memories." })).toBe(
      true,
    );
    expect(
      shouldIgnoreMemory([
        { role: 'assistant', content: 'ignore memory' },
        { role: 'user', content: 'Please do not use memory.' },
      ]),
    ).toBe(true);
    expect(shouldIgnoreMemory('Use memory when answering.')).toBe(false);
  });
});

describe('Memory 生产装配契约', () => {
  it('启用后同时装配工具和索引上下文，成功写入会失效同一仓储的缓存', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-memory-runtime-'));
    temporaryDirectories.push(root);
    const storage = createCodingStorage({ databasePath: ':memory:' });
    try {
      const config = CodingAgentConfigSchema.parse({
        cwd: root,
        session_dir: path.join(root, '.ello', 'sessions'),
        initial_mode: 'ask-before-changes',
        context: {
          memory: {
            enabled: true,
            private_dir: path.join(root, 'private-memory'),
            team_dir: path.join(root, 'team-memory'),
          },
        },
      });
      const runtime = createProductionToolRuntime({
        config,
        storage,
        taskBoardScope: { type: 'session', sessionId: 'memory-runtime' },
        mode: () => ({
          mode: 'ask-before-changes',
          previousMode: null,
          source: 'resume',
          changedAt: '2026-07-19T00:00:00.000Z',
        }),
      });
      await runtime.initialize();
      expect(runtime.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'memory_list',
          'memory_read',
          'memory_write',
          'memory_delete',
          'memory_search',
        ]),
      );
      expect(
        (await runtime.memoryIndexLoader!.load()).sources[0]?.content,
      ).not.toContain('Runtime preference');

      const write = immediateTool(runtime.tools, 'memory_write');
      await write.execute(
        {
          scope: 'private',
          file: 'runtime-preference.md',
          expectedRevision: null,
          content: topic({
            name: 'Runtime preference',
            description: 'Production memory wiring',
            type: 'user',
            body: 'Memory tools and prompt context share one repository.',
          }),
        },
        TOOL_CONTEXT,
      );

      expect(
        (await runtime.memoryIndexLoader!.load()).sources[0]?.content,
      ).toContain('Runtime preference');
    } finally {
      storage.close();
    }
  });

  it('Plan 模式把 Memory 写入按 edit 权限拒绝，不从通用工具绕过边界', async () => {
    const repository = await createRepository();
    const storage = createCodingStorage({ databasePath: ':memory:' });
    try {
      const config = CodingAgentConfigSchema.parse({
        cwd: path.dirname(repository.roots.team),
        session_dir: path.join(repository.roots.team, '..', 'sessions'),
        initial_mode: 'plan',
        context: {
          memory: {
            enabled: true,
            private_dir: repository.roots.private,
            team_dir: repository.roots.team,
          },
        },
      });
      const runtime = createProductionToolRuntime({
        config,
        storage,
        taskBoardScope: { type: 'session', sessionId: 'memory-plan' },
        mode: () => ({
          mode: 'plan',
          previousMode: null,
          source: 'resume',
          changedAt: '2026-07-19T00:00:00.000Z',
        }),
      });
      const write = immediateTool(runtime.tools, 'memory_write');
      expect(
        write.approval?.(
          {
            scope: 'team',
            file: 'blocked.md',
            expectedRevision: null,
            content: topic({
              name: 'Blocked',
              description: 'Must not write in Plan mode',
              type: 'reference',
              body: 'This content must not be written.',
            }),
          },
          TOOL_CONTEXT,
        ),
      ).toMatchObject({ action: 'denied' });
    } finally {
      storage.close();
    }
  });

  it('Dream 没有生产 runner 时拒绝请求，且不发送虚假完成通知', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-memory-dream-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, '.ello'), { recursive: true });
    await writeFile(
      path.join(root, '.ello', 'config.yaml'),
      [
        'initial_mode: ask-before-changes',
        'context:',
        '  memory:',
        '    enabled: true',
        `    private_dir: ${JSON.stringify(path.join(root, 'private'))}`,
        `    team_dir: ${JSON.stringify(path.join(root, 'team'))}`,
        '',
      ].join('\n'),
      'utf8',
    );
    const notifications = vi.fn();
    const services = Object.assign(Object.create(ServerServices.prototype), {
      artifactGc: Promise.resolve(),
    }) as ServerServices;

    await expect(
      services.dispatch(
        { sendNotification: notifications } as unknown as ServerConnection,
        'memory/dream/start',
        { cwd: root },
      ),
    ).rejects.toMatchObject({
      type: 'invalidParams',
      message: expect.stringContaining('no production dream runner'),
    });
    expect(notifications).not.toHaveBeenCalled();
  });
});

const TOOL_CONTEXT: AgentToolContext = {
  runId: 'run-memory',
  turnIndex: 0,
  toolCallId: 'call-memory',
  environment: {},
  metadata: {},
  signal: new AbortController().signal,
};

function immediateTool(
  tools: ReturnType<typeof createProductionToolRuntime>['tools'],
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined || tool.execution !== 'immediate') {
    throw new Error(`Missing immediate tool ${name}.`);
  }
  return tool;
}
