import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AgentModelEvent,
  AgentModelRequest,
  AgentModelResponse,
  ModelAdapter,
} from '@ello/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import { createCodingSystemPromptSection } from '../context/prompts.js';
import { MemoryIndexLoader } from '../memory/index-loader.js';
import { memoryRoots } from '../memory/paths.js';
import { MemoryRepository } from '../memory/repository.js';
import {
  createCodingSession as createCodingSessionRuntime,
  type CreateCodingSessionOptions,
} from '../runtime/coding-session.js';
import type { CodingSessionEvent } from '../runtime/intents.js';

function createCodingSession(
  options: Omit<CreateCodingSessionOptions, 'clientCapabilities'>,
) {
  return createCodingSessionRuntime({
    ...options,
    clientCapabilities: { requestUserInput: false },
  });
}

describe('file memory', () => {
  let previousHome: string | undefined;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-memory-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-memory-cwd-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('memory 默认关闭且路径在 config load 时规范化', async () => {
    const config = await loadCodingAgentConfig({ cwd });

    expect(config.context.memory).toMatchObject({
      enabled: false,
      private_dir: path.join(home, 'memory', 'private'),
      team_dir: path.join(cwd, '.ello', 'memory', 'team'),
      extraction: {
        enabled: true,
        recent_messages: 40,
        max_attempts: 2,
      },
    });
    await expect(
      access(path.join(home, 'memory', 'private')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('disabled runtime 不初始化目录、不注册 job，/dream 明确失败', async () => {
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir: path.join(home, 'sessions-disabled'),
    });
    const adapter = new InspectToolsAdapter();
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });

    await session.submit('hello');
    expect(await session.memoryStatus()).toMatchObject({ enabled: false });
    await expect(session.dream()).rejects.toThrow(
      'Enable context.memory.enabled',
    );
    expect(adapter.mainTools.some((name) => name.startsWith('memory_'))).toBe(
      false,
    );
    await session.close();
    await expect(
      access(path.join(home, 'memory', 'private')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repository 用 revision 写入、更新、删除 topic 并自动维护索引', async () => {
    const repository = await createRepository();
    const created = await repository.write(
      'private',
      'collaboration-style.md',
      null,
      topic({
        name: 'Collaboration style',
        description: 'Prefer source-grounded implementation updates',
        type: 'user',
        body: 'The user prefers source-grounded implementation updates.',
      }),
    );

    expect(created.operation).toBe('created');
    const index = await repository.read('private', 'MEMORY.md');
    expect(index.content).toBe(
      '- [Collaboration style](collaboration-style.md) — Prefer source-grounded implementation updates\n',
    );
    expect(index.content).not.toContain('The user prefers');

    await expect(
      repository.write(
        'private',
        'collaboration-style.md',
        'stale-revision',
        topic({
          name: 'Collaboration style',
          description: 'Prefer concise source-grounded implementation updates',
          type: 'user',
          body: 'The user prefers concise source-grounded implementation updates.',
        }),
      ),
    ).rejects.toThrow('Memory revision conflict');

    const current = await repository.read('private', 'collaboration-style.md');
    const updated = await repository.write(
      'private',
      'collaboration-style.md',
      current.revision,
      topic({
        name: 'Collaboration style',
        description: 'Prefer concise source-grounded implementation updates',
        type: 'user',
        body: 'The user prefers concise source-grounded implementation updates.',
      }),
    );
    expect(updated.operation).toBe('updated');

    const deletionRevision = (
      await repository.read('private', 'collaboration-style.md')
    ).revision;
    expect(
      await repository.delete(
        'private',
        'collaboration-style.md',
        deletionRevision,
      ),
    ).toMatchObject({ operation: 'deleted', revision: null });
    expect((await repository.read('private', 'MEMORY.md')).content).toBe('');
  });

  it('严格校验 scope、frontmatter、索引大小和 symlink', async () => {
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
          description: 'Integration tests use a real database',
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
          body: 'Invalid.',
        }),
      ),
    ).rejects.toThrow('Invalid memory topic file');

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

    const outside = path.join(cwd, 'outside.md');
    await writeFile(outside, 'outside', 'utf8');
    await symlink(outside, path.join(repository.roots.team, 'linked.md'));
    await expect(repository.list('team')).rejects.toThrow(
      'Invalid memory directory entry',
    );
  });

  it('enabled 时只注入两个索引，ignore memory 时完全不应用', async () => {
    const config = await loadCodingAgentConfig({
      cwd,
      context: {
        memory: {
          enabled: true,
          private_dir: path.join(home, 'memory', 'private'),
          team_dir: path.join(cwd, '.ello', 'memory', 'team'),
          extraction: {
            enabled: true,
            recent_messages: 40,
            max_attempts: 2,
          },
        },
      } as never,
    });
    const repository = new MemoryRepository(memoryRoots(config));
    await repository.initialize();
    await repository.write(
      'private',
      'user-profile.md',
      null,
      topic({
        name: 'User profile',
        description: 'User prefers concise answers',
        type: 'user',
        body: 'TOPIC_BODY_MUST_NOT_BE_IN_SYSTEM_CONTEXT',
      }),
    );
    const loader = new MemoryIndexLoader(repository);
    const section = createCodingSystemPromptSection(config, {
      model: 'test/model',
      memoryIndexLoader: loader,
    });

    const system = await section({
      runId: 'memory-on',
      input: 'help me',
    } as never);
    expect(system).toContain('User profile');
    expect(system).toContain(repository.roots.private);
    expect(system).toContain(repository.roots.team);
    expect(system).not.toContain('TOPIC_BODY_MUST_NOT_BE_IN_SYSTEM_CONTEXT');

    const ignored = await section({
      runId: 'memory-ignored',
      input: 'Ignore memory for this request.',
    } as never);
    expect(ignored).not.toContain('User profile');
    expect(ignored).not.toContain('# Memory');
  });

  it('主 agent 能在当前 run 直接写入 memory', async () => {
    const sessionDir = path.join(home, 'sessions-main-write');
    const config = await enabledConfig(sessionDir, 40);
    const events: CodingSessionEvent[] = [];
    const session = await createCodingSession({
      config,
      modelAdapter: new MemoryScenarioAdapter('main-write'),
    });
    session.subscribe((event) => events.push(event));

    const result = await session.submit(
      'Remember that I prefer concise answers.',
    );
    await session.close();

    expect(result.output).toBe('Remembered.');
    expect(events).toContainEqual({
      type: 'memory.saved',
      scope: 'private',
      file: 'concise-answers.md',
      operation: 'created',
    });
    expect(
      await readFile(
        path.join(home, 'memory', 'private', 'concise-answers.md'),
        'utf8',
      ),
    ).toContain('The user prefers concise answers.');
  });

  it('真实 user submit 后 durable enqueue extraction 且同 leaf 只执行一次', async () => {
    const sessionDir = path.join(home, 'sessions-extraction');
    const config = await enabledConfig(sessionDir, 2);
    const events: CodingSessionEvent[] = [];
    const session = await createCodingSession({
      config,
      modelAdapter: new MemoryScenarioAdapter('extraction'),
    });
    session.subscribe((event) => events.push(event));

    await session.submit('I review infrastructure changes.');
    await waitForEvent(events, 'memory.extraction.completed');
    const status = await session.memoryStatus();
    await session.close();

    expect(status.enabled).toBe(true);
    if (!status.enabled) {
      throw new Error('Expected memory to be enabled.');
    }
    expect(status.queuedJobs).toBe(0);
    expect(status.runningJobs).toBe(0);
    expect(
      await readFile(
        path.join(home, 'memory', 'private', 'infrastructure-reviewer.md'),
        'utf8',
      ),
    ).toContain('The user reviews infrastructure changes.');
    expect(
      events.filter((event) => event.type === 'memory.extraction.completed'),
    ).toHaveLength(1);
  });

  it('/dream 对 active job 去重并在后台完成整合', async () => {
    const sessionDir = path.join(home, 'sessions-dream');
    const config = await enabledConfig(sessionDir, 40);
    const events: CodingSessionEvent[] = [];
    const session = await createCodingSession({
      config,
      modelAdapter: new MemoryScenarioAdapter('dream'),
    });
    session.subscribe((event) => events.push(event));

    const first = await session.dream();
    const second = await session.dream();
    expect(second.id).toBe(first.id);
    await waitForEvent(events, 'memory.dream.completed');
    await session.close();

    expect(
      await readFile(
        path.join(cwd, '.ello', 'memory', 'team', 'release-policy.md'),
        'utf8',
      ),
    ).toContain('**How to apply:**');
    expect(
      events.filter((event) => event.type === 'memory.dream.completed'),
    ).toHaveLength(1);
  });

  async function createRepository(): Promise<MemoryRepository> {
    const roots = {
      private: path.join(home, 'memory', 'private'),
      team: path.join(cwd, '.ello', 'memory', 'team'),
    };
    await mkdir(path.dirname(roots.private), { recursive: true });
    const repository = new MemoryRepository(roots);
    await repository.initialize();
    return repository;
  }

  async function enabledConfig(sessionDir: string, recentMessages: number) {
    return loadCodingAgentConfig({
      cwd,
      sessionDir,
      initialMode: 'bypass',
      bypassEnabled: true,
      context: {
        memory: {
          enabled: true,
          private_dir: path.join(home, 'memory', 'private'),
          team_dir: path.join(cwd, '.ello', 'memory', 'team'),
          extraction: {
            enabled: true,
            recent_messages: recentMessages,
            max_attempts: 2,
          },
        },
      } as never,
    });
  }
});

const usage = {
  requests: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

class MemoryScenarioAdapter implements ModelAdapter {
  constructor(
    private readonly scenario: 'main-write' | 'extraction' | 'dream',
  ) {}

  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const system = request.system ?? '';
    const hasToolResult = request.messages.some(
      (message) => message.role === 'tool',
    );
    if (system.includes('memory extraction subagent')) {
      return hasToolResult
        ? textResponse(request, 'Extraction complete.')
        : toolResponse(request, {
            id: 'extract-write',
            name: 'memory_write',
            input: {
              scope: 'private',
              file: 'infrastructure-reviewer.md',
              expectedRevision: null,
              content: topic({
                name: 'Infrastructure reviewer',
                description: 'User reviews infrastructure changes',
                type: 'user',
                body: 'The user reviews infrastructure changes.',
              }),
            },
          });
    }
    if (system.includes('# Dream: Memory Consolidation')) {
      return hasToolResult
        ? textResponse(request, 'Consolidated release policy.')
        : toolResponse(request, {
            id: 'dream-write',
            name: 'memory_write',
            input: {
              scope: 'team',
              file: 'release-policy.md',
              expectedRevision: null,
              content: topic({
                name: 'Release policy',
                description: 'Release changes require verification',
                type: 'project',
                body: [
                  'Release changes require verification.',
                  '',
                  '**Why:** Release stability is a project constraint.',
                  '',
                  '**How to apply:** Run targeted verification before release changes.',
                ].join('\n'),
              }),
            },
          });
    }
    if (
      this.scenario === 'main-write' &&
      system.includes('# Primary Agent Role')
    ) {
      return hasToolResult
        ? textResponse(request, 'Remembered.')
        : toolResponse(request, {
            id: 'main-write',
            name: 'memory_write',
            input: {
              scope: 'private',
              file: 'concise-answers.md',
              expectedRevision: null,
              content: topic({
                name: 'Concise answers',
                description: 'User prefers concise answers',
                type: 'user',
                body: 'The user prefers concise answers.',
              }),
            },
          });
    }
    if (this.scenario === 'extraction') {
      return textResponse(request, 'Noted.');
    }
    return textResponse(request, 'Memory test');
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    yield { type: 'final', response: await this.generate(request) };
  }
}

class InspectToolsAdapter implements ModelAdapter {
  mainTools: string[] = [];

  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const tools = Object.keys(request.tools);
    if (tools.length > 0) {
      this.mainTools = tools;
    }
    return textResponse(request, 'OK');
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    yield { type: 'final', response: await this.generate(request) };
  }
}

function toolResponse(
  request: AgentModelRequest,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
): AgentModelResponse {
  const visibleCall = Object.hasOwn(request.tools, call.name)
    ? call
    : {
        id: call.id,
        name: 'call_tool',
        input: { name: call.name, arguments: call.input },
      };
  const message = {
    role: 'assistant' as const,
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: call.id,
        toolName: visibleCall.name,
        input: visibleCall.input,
      },
    ],
  };
  return {
    text: '',
    messages: [...request.messages, message],
    newMessages: [message],
    toolCalls: [visibleCall],
    usage,
    finishReason: 'tool-calls',
    provider: null,
  };
}

function textResponse(
  request: AgentModelRequest,
  text: string,
): AgentModelResponse {
  const message = { role: 'assistant' as const, content: text };
  return {
    text,
    messages: [...request.messages, message],
    newMessages: [message],
    usage,
    finishReason: 'stop',
    provider: null,
  };
}

async function waitForEvent(
  events: readonly CodingSessionEvent[],
  type: CodingSessionEvent['type'],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.type === type)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${type}.`);
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
