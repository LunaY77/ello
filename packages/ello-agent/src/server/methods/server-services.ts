import { exec } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { MemoryRepository, memoryRoots } from '../../agent/memory/index.js';
import { readPlanArtifact } from '../../agent/plans/artifact.js';
import { createProviderRegistry } from '../../agent/providers/catalog/index.js';
import { SkillCatalog } from '../../agent/skills/index.js';
import { createAgentRegistry } from '../../agent/subagents/registry.js';
import { createProductionToolRuntime } from '../../agent/tools/production.js';
import {
  describeConfigSettings,
  ensureGlobalConfig,
  ensureProjectConfig,
  globalConfigPath,
  loadCodingAgentConfig,
  loadConfigSources,
  projectConfigPath,
  writeConfigPath,
} from '../../config/index.js';
import { stringifyYamlConfig } from '../../config/yaml.js';
import { createEntityId } from '../../domain/ids.js';
import {
  AppServerError,
  type ClientMethod,
  type ParsedClientParams,
  type ThreadItem,
  type ThreadSnapshot,
} from '../../protocol/v1/index.js';
import type { CodingStorage } from '../../storage/database/index.js';
import type { Task } from '../../storage/tasks/index.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';
import {
  RepoStore,
  WorkspaceStore,
  type Repository,
  type Workspace,
} from '../../workspace/index.js';
import { resolveWorkspaceMount } from '../../workspace/paths.js';
import type { ServerConnection } from '../connection/server-connection.js';
import { ThreadManager } from '../runtime/thread-manager.js';

import { sanitizeConfigForResponse } from './config-response.js';

const execAsync = promisify(exec);
const INLINE_ARTIFACT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RpcServices {
  dispatch(
    connection: ServerConnection,
    method: ClientMethod,
    params: unknown,
  ): Promise<unknown>;
  closeConnection?(connectionId: string): void;
  close(): Promise<void>;
}

export interface ServerServicesOptions {
  readonly threads: ThreadManager;
  readonly logs: ThreadLogRepository;
  readonly storage: CodingStorage;
}

/** 除核心 Thread/Turn 生命周期外，所有产品 RPC 的唯一实现表。 */
export class ServerServices implements RpcServices {
  private readonly watchers = new Map<
    string,
    { readonly connectionId: string; readonly watcher: FSWatcher }
  >();
  private artifactGc: Promise<unknown> | undefined;

  constructor(private readonly options: ServerServicesOptions) {}

  async dispatch(
    connection: ServerConnection,
    method: ClientMethod,
    rawParams: unknown,
  ): Promise<unknown> {
    await (this.artifactGc ??= this.collectExpiredArtifacts());
    switch (method) {
      case 'thread/export':
        return this.exportThread(
          rawParams as ParsedClientParams<'thread/export'>,
        );
      case 'artifact/read':
        return this.readArtifact(
          rawParams as ParsedClientParams<'artifact/read'>,
        );
      case 'thread/compact/start': {
        throw invalid(
          'Manual context compaction is unavailable because no production compaction runner is configured.',
        );
      }
      case 'thread/shellCommand':
        return this.runThreadShell(
          rawParams as ParsedClientParams<'thread/shellCommand'>,
        );
      case 'thread/goal/get': {
        const params = rawParams as ParsedClientParams<'thread/goal/get'>;
        return { goal: await this.options.threads.goal(params.threadId) };
      }
      case 'thread/goal/set': {
        const params = rawParams as ParsedClientParams<'thread/goal/set'>;
        return {
          goal: await this.options.threads.setGoal(params.threadId, {
            objective: params.objective,
            ...(params.tokenBudget === undefined
              ? {}
              : { tokenBudget: params.tokenBudget }),
            ...(params.status === undefined ? {} : { status: params.status }),
          }),
        };
      }
      case 'thread/goal/clear': {
        const params = rawParams as ParsedClientParams<'thread/goal/clear'>;
        return {
          goalId: await this.options.threads.clearGoal(params.threadId),
        };
      }
      case 'thread/plan/read': {
        const params = rawParams as ParsedClientParams<'thread/plan/read'>;
        return { plan: await this.options.threads.plan(params.threadId) };
      }
      case 'thread/plan/preview':
        return this.previewPlan(
          rawParams as ParsedClientParams<'thread/plan/preview'>,
        );
      case 'config/read':
        return this.readConfig(rawParams as ParsedClientParams<'config/read'>);
      case 'config/settings':
        return this.readSettings(
          rawParams as ParsedClientParams<'config/settings'>,
        );
      case 'config/write':
        return this.writeConfig(
          rawParams as ParsedClientParams<'config/write'>,
        );
      case 'config/init':
        return this.initializeConfig(
          rawParams as ParsedClientParams<'config/init'>,
        );
      case 'config/sources':
        return this.configSources(
          rawParams as ParsedClientParams<'config/sources'>,
        );
      case 'model/list':
        return this.listModels(rawParams as ParsedClientParams<'model/list'>);
      case 'provider/list':
        return this.listProviders(
          rawParams as ParsedClientParams<'provider/list'>,
        );
      case 'agent/list':
        return this.listAgents(rawParams as ParsedClientParams<'agent/list'>);
      case 'tool/list':
        return this.listTools(rawParams as ParsedClientParams<'tool/list'>);
      case 'skills/list':
        return this.listSkills(rawParams as ParsedClientParams<'skills/list'>);
      case 'skills/get':
        return this.getSkill(rawParams as ParsedClientParams<'skills/get'>);
      case 'skills/reload':
        return this.reloadSkills(
          connection,
          rawParams as ParsedClientParams<'skills/reload'>,
        );
      case 'memory/status':
        return this.memoryStatus(
          rawParams as ParsedClientParams<'memory/status'>,
        );
      case 'memory/reload':
        await this.reloadMemory(
          rawParams as ParsedClientParams<'memory/reload'>,
        );
        return { ok: true };
      case 'memory/dream/start':
        return this.startMemoryJob(
          rawParams as ParsedClientParams<'memory/dream/start'>,
        );
      case 'task/list':
        return this.listTasks(rawParams as ParsedClientParams<'task/list'>);
      case 'task/get':
        return this.getTask(rawParams as ParsedClientParams<'task/get'>);
      case 'task/create':
        return this.createTask(rawParams as ParsedClientParams<'task/create'>);
      case 'task/update':
        return this.updateTask(rawParams as ParsedClientParams<'task/update'>);
      case 'task/delete':
        return this.deleteTask(rawParams as ParsedClientParams<'task/delete'>);
      case 'task/claim':
        return this.claimTask(rawParams as ParsedClientParams<'task/claim'>);
      case 'task/reset':
        return this.resetTasks(rawParams as ParsedClientParams<'task/reset'>);
      case 'fs/readFile':
        return this.readFile(rawParams as ParsedClientParams<'fs/readFile'>);
      case 'fs/readDirectory':
        return this.readDirectory(
          rawParams as ParsedClientParams<'fs/readDirectory'>,
        );
      case 'fs/getMetadata':
        return this.fileMetadata(
          rawParams as ParsedClientParams<'fs/getMetadata'>,
        );
      case 'fs/search':
        return this.searchFiles(rawParams as ParsedClientParams<'fs/search'>);
      case 'fs/watch':
        return this.watchFiles(
          connection,
          rawParams as ParsedClientParams<'fs/watch'>,
        );
      case 'fs/unwatch':
        return this.unwatchFiles(
          connection,
          rawParams as ParsedClientParams<'fs/unwatch'>,
        );
      case 'repo/add':
      case 'repo/list':
      case 'repo/read':
      case 'repo/rename':
      case 'repo/remove':
      case 'repo/fetch':
      case 'repo/fetchLocal':
      case 'repo/remote/read':
      case 'repo/remote/add':
      case 'repo/remote/set':
      case 'repo/remote/remove':
      case 'repo/export':
      case 'repo/import':
        return this.repoMethod(method, rawParams);
      case 'workspace/create':
      case 'workspace/list':
      case 'workspace/archived/list':
      case 'workspace/read':
      case 'workspace/path':
      case 'workspace/status':
      case 'workspace/repo/add':
      case 'workspace/repo/create':
      case 'workspace/repo/remove':
      case 'workspace/rename':
      case 'workspace/archive':
      case 'workspace/delete':
      case 'workspace/reconcile':
      case 'workspace/repair':
      case 'workspace/tmux/new':
        return this.workspaceMethod(method, rawParams);
      case 'initialize':
      case 'server/read':
      case 'server/shutdown':
      case 'thread/start':
      case 'thread/resume':
      case 'thread/read':
      case 'thread/list':
      case 'thread/loaded/list':
      case 'thread/fork':
      case 'thread/unsubscribe':
      case 'thread/archive':
      case 'thread/unarchive':
      case 'thread/delete':
      case 'thread/turns/list':
      case 'thread/items/list':
      case 'thread/settings/update':
      case 'turn/start':
      case 'turn/steer':
      case 'turn/interrupt':
        throw new AppServerError({
          type: 'internal',
          message: `Core method ${method} was routed to ServerServices.`,
        });
    }
  }

  async close(): Promise<void> {
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.artifactGc;
    await this.collectExpiredArtifacts();
  }

  closeConnection(connectionId: string): void {
    for (const [watchId, owned] of this.watchers) {
      if (owned.connectionId !== connectionId) continue;
      owned.watcher.close();
      this.watchers.delete(watchId);
    }
  }

  private collectExpiredArtifacts() {
    return this.options.storage.artifacts.deleteExpiredReferences(
      new Date(Date.now() - ARTIFACT_RETENTION_MS).toISOString(),
    );
  }

  private async exportThread(params: ParsedClientParams<'thread/export'>) {
    const snapshot = await this.options.threads.read({
      threadId: params.threadId,
      includeTurns: true,
      includeItems: true,
    });
    const mediaType =
      params.format === 'jsonl'
        ? 'application/x-ndjson'
        : params.format === 'html'
          ? 'text/html'
          : 'text/markdown';
    const content =
      params.format === 'jsonl'
        ? `${(await this.options.logs.read(params.threadId))
            .map((record) => JSON.stringify(record))
            .join('\n')}\n`
        : params.format === 'html'
          ? renderThreadHtml(snapshot)
          : renderThreadMarkdown(snapshot);
    const byteCount = Buffer.byteLength(content);
    if (byteCount <= INLINE_ARTIFACT_BYTES) {
      return { kind: 'inline' as const, content, mediaType };
    }
    const artifact = await this.options.storage.artifacts.put({
      kind: 'thread-export',
      content,
      contentType: mediaType,
      owner: {
        kind: 'session-export',
        id: params.threadId,
        relation: params.format,
      },
    });
    return {
      kind: 'artifact' as const,
      artifactId: artifact.id,
      byteCount: artifact.byteSize,
      mediaType,
    };
  }

  private async readArtifact(params: ParsedClientParams<'artifact/read'>) {
    const metadata = this.options.storage.artifacts.metadata(params.artifactId);
    if (params.offset > metadata.byteSize) {
      throw invalid(
        `Artifact offset ${params.offset} exceeds byte size ${metadata.byteSize}.`,
      );
    }
    const content = await this.options.storage.artifacts.read(
      params.artifactId,
    );
    const chunk = content.subarray(
      params.offset,
      Math.min(metadata.byteSize, params.offset + params.maxBytes),
    );
    return {
      artifactId: metadata.id,
      contentType: metadata.contentType,
      content: chunk.toString('base64'),
      encoding: 'base64' as const,
      byteCount: metadata.byteSize,
      offset: params.offset,
      readByteCount: chunk.byteLength,
      eof: params.offset + chunk.byteLength >= metadata.byteSize,
    };
  }

  private async runThreadShell(
    params: ParsedClientParams<'thread/shellCommand'>,
  ) {
    const snapshot = await this.options.threads.read({
      threadId: params.threadId,
      includeTurns: false,
      includeItems: false,
    });
    if (snapshot.settings.mode === 'plan') {
      throw new AppServerError({
        type: 'permissionDenied',
        message: 'Shell commands are disabled in Plan mode.',
      });
    }
    const started = Date.now();
    let exitCode = 0;
    let stdout: string;
    let stderr: string;
    try {
      const result = await execAsync(params.command, {
        cwd: snapshot.thread.cwd,
        timeout: params.timeoutMs ?? 30_000,
        maxBuffer: MAX_FILE_BYTES,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as Error & {
        readonly code?: number | string;
        readonly stdout?: string;
        readonly stderr?: string;
        readonly killed?: boolean;
      };
      exitCode =
        failure.killed === true
          ? -1
          : typeof failure.code === 'number'
            ? failure.code
            : 1;
      stdout = failure.stdout ?? '';
      stderr =
        failure.killed === true
          ? 'timeout'
          : (failure.stderr ?? failure.message);
    }
    const fullOutput = `${stdout}${stderr}`;
    const response = {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
    if (Buffer.byteLength(fullOutput) <= INLINE_ARTIFACT_BYTES) return response;
    const artifact = await this.options.storage.artifacts.put({
      kind: 'shell-output',
      content: fullOutput,
      contentType: 'text/plain',
      owner: {
        kind: 'tool-result',
        id: createEntityId('job'),
        relation: params.threadId,
      },
    });
    return {
      ...response,
      stdout: utf8Prefix(stdout, INLINE_ARTIFACT_BYTES / 2),
      stderr: utf8Prefix(stderr, INLINE_ARTIFACT_BYTES / 2),
      artifactId: artifact.id,
    };
  }

  private async previewPlan(params: ParsedClientParams<'thread/plan/preview'>) {
    const snapshot = await this.options.threads.read({
      threadId: params.threadId,
      includeTurns: false,
      includeItems: false,
    });
    const snapshotPlan = snapshot.plan;
    if (snapshotPlan === null) {
      throw invalid(`Thread ${params.threadId} has no plan.`);
    }
    const artifact = await readPlanArtifact(
      snapshot.thread.cwd,
      params.threadId,
    );
    if (
      params.contentHash !== snapshotPlan.contentHash ||
      artifact.contentHash !== snapshotPlan.contentHash
    ) {
      throw invalid('Plan content hash is stale.');
    }
    return { plan: { ...snapshotPlan, content: artifact.content } };
  }

  private async readConfig(params: ParsedClientParams<'config/read'>) {
    const config = sanitizeConfigForResponse(
      toJson(await loadCodingAgentConfig({ cwd: params.cwd })),
    );
    if (!params.includeSources) return { config };
    const sources = await loadConfigSources(params.cwd);
    return {
      config,
      sources: await Promise.all(
        sources.map(async (source) => ({
          name: source.name,
          path: source.path ?? null,
          exists: source.path === undefined ? true : await exists(source.path),
          value: sanitizeConfigForResponse(toJson(source.data)),
        })),
      ),
    };
  }

  private async readSettings(params: ParsedClientParams<'config/settings'>) {
    const [config, sources] = await Promise.all([
      loadCodingAgentConfig({ cwd: params.cwd }),
      loadConfigSources(params.cwd),
    ]);
    return {
      data: describeConfigSettings(
        sanitizeConfigForResponse(toJson(config)),
        sources,
      ),
    };
  }

  private async writeConfig(params: ParsedClientParams<'config/write'>) {
    const config = await writeConfigPath(
      params.cwd,
      params.source,
      params.path,
      params.operation === 'set'
        ? { type: 'set', value: params.value }
        : { type: 'delete' },
    );
    return { config: sanitizeConfigForResponse(toJson(config)) };
  }

  private async initializeConfig(params: ParsedClientParams<'config/init'>) {
    await ensureGlobalConfig({ force: params.force });
    await ensureProjectConfig(params.cwd, { force: params.force });
    return {
      created: [globalConfigPath(), projectConfigPath(params.cwd)],
    };
  }

  private async configSources(params: ParsedClientParams<'config/sources'>) {
    const sources = await loadConfigSources(params.cwd);
    return {
      data: await Promise.all(
        sources.map(async (source) => ({
          name: source.name,
          path: source.path ?? null,
          exists: source.path === undefined ? true : await exists(source.path),
        })),
      ),
    };
  }

  private async listProviders(params: ParsedClientParams<'provider/list'>) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    return {
      data: createProviderRegistry(config)
        .listProviders()
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          metadata: {
            kind: provider.kind,
            source: provider.source,
            apiKeyConfigured: provider.apiKey !== undefined,
            baseUrlConfigured: provider.baseUrl !== undefined,
          },
        })),
    };
  }

  private async listModels(params: ParsedClientParams<'model/list'>) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    return {
      data: createProviderRegistry(config)
        .listModels()
        .map((model) => ({
          id: model.ref,
          name: model.name,
          title: model.ref,
          enabled: model.status === 'active',
          metadata: {
            provider: model.providerId,
            status: model.status,
            context: model.limit.context,
            output: model.limit.output,
            toolCall: model.capabilities.toolCall,
            reasoning: model.capabilities.reasoning,
          },
        })),
    };
  }

  private async listAgents(params: ParsedClientParams<'agent/list'>) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const registry = await createAgentRegistry(config);
    return {
      data: registry.list().map((agent) => {
        const primaryAvailable =
          agent.hidden !== true &&
          (agent.mode === 'primary' || agent.mode === 'all');
        return {
          id: agent.name,
          name: agent.name,
          description: agent.description,
          enabled: primaryAvailable,
          metadata: {
            mode: agent.mode,
            role: agent.role,
            source: agent.source,
            runtime: primaryAvailable
              ? 'primary'
              : agent.mode === 'subagent'
                ? 'unavailable:no-delegation-runner'
                : 'internal-only',
          },
        };
      }),
    };
  }

  private async listTools(params: ParsedClientParams<'tool/list'>) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const runtime = createProductionToolRuntime({
      config,
      storage: this.options.storage,
      taskBoardScope: {
        type: 'session',
        sessionId: params.threadId ?? `catalog:${path.resolve(params.cwd)}`,
      },
      mode: () => ({
        mode: config.initial_mode,
        previousMode: null,
        source: 'config',
        changedAt: new Date().toISOString(),
      }),
    });
    return {
      data: runtime.tools.map((tool) => ({
        id: tool.name,
        name: tool.name,
        description: tool.description,
        enabled: true,
        metadata: {
          execution: tool.execution,
          risk: tool.discovery.risk,
          aliases: [...tool.discovery.aliases],
        },
      })),
    };
  }

  private async skillCatalog(
    params:
      | ParsedClientParams<'skills/list'>
      | ParsedClientParams<'skills/get'>,
  ) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const catalog = new SkillCatalog(config);
    await catalog.initialize();
    return catalog;
  }

  private async listSkills(params: ParsedClientParams<'skills/list'>) {
    const catalog = await this.skillCatalog(params);
    const skills = params.query?.trim()
      ? catalog.search(params.query)
      : catalog.list();
    return { data: skills.map(skillEntry) };
  }

  private async getSkill(params: ParsedClientParams<'skills/get'>) {
    const skill = (await this.skillCatalog(params)).get(params.name);
    if (skill === undefined) throw invalid(`Unknown skill ${params.name}.`);
    return { skill: skillEntry(skill) };
  }

  private async reloadSkills(
    connection: ServerConnection,
    params: ParsedClientParams<'skills/reload'>,
  ) {
    const catalog = await this.skillCatalog(params);
    const skills = await catalog.reload();
    await connection.sendNotification({
      method: 'skills/changed',
      params: {
        cwd: params.cwd,
        paths: skills.map((skill) => skill.skillPath),
      },
    });
    return { data: skills.map(skillEntry) };
  }

  private async memoryRepository(cwd: string) {
    const config = await loadCodingAgentConfig({ cwd });
    if (!config.context.memory.enabled) {
      throw invalid('Memory is disabled by Server configuration.');
    }
    const repository = new MemoryRepository(memoryRoots(config));
    await repository.initialize();
    return { config, repository };
  }

  private async memoryStatus(params: ParsedClientParams<'memory/status'>) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const roots = memoryRoots(config);
    if (config.context.memory.enabled) {
      const repository = new MemoryRepository(roots);
      await repository.initialize();
    }
    return {
      enabled: config.context.memory.enabled,
      state: 'idle' as const,
      privateRoot: roots.private,
      teamRoot: roots.team,
      pendingJobs: 0,
    };
  }

  private async reloadMemory(params: ParsedClientParams<'memory/reload'>) {
    await this.memoryRepository(params.cwd);
  }

  private async startMemoryJob(
    params: ParsedClientParams<'memory/dream/start'>,
  ) {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    if (!config.context.memory.enabled) {
      throw invalid('Memory is disabled by Server configuration.');
    }
    throw invalid(
      'Memory dream is unavailable because no production dream runner is configured.',
    );
  }

  private board(boardId: string) {
    const repository = this.options.storage.taskBoards;
    const board = repository.getBoardById(boardId);
    return (
      board ?? repository.getOrCreateBoard({ type: 'global', name: boardId })
    );
  }

  private listTasks(params: ParsedClientParams<'task/list'>) {
    const board =
      params.boardId === undefined
        ? this.options.storage.taskBoards.getOrCreateBoard({
            type: 'global',
            name: 'default',
          })
        : this.board(params.boardId);
    const tasks = this.options.storage.taskBoards
      .listTasks(board.id)
      .filter(
        (task) =>
          params.status === undefined ||
          protocolTaskStatus(task.status) === params.status,
      );
    return page(tasks.map(protocolTask), params.cursor, params.limit);
  }

  private getTask(params: ParsedClientParams<'task/get'>) {
    return { task: protocolTask(this.requireTask(params.id)) };
  }

  private createTask(params: ParsedClientParams<'task/create'>) {
    const board = this.board(params.boardId);
    const task = this.options.storage.taskBoards.createTask(board.id, {
      subject: params.subject,
      description: params.description,
      ...(params.activeForm === undefined
        ? {}
        : { activeForm: params.activeForm }),
      ...(params.owner === undefined ? {} : { owner: params.owner }),
      blockedBy: params.blockedBy,
      metadata: toJson(params.metadata) as Record<string, unknown>,
    });
    return { task: protocolTask(task) };
  }

  private updateTask(params: ParsedClientParams<'task/update'>) {
    const current = this.requireTask(params.id);
    const blockedBy = new Set(current.blockedBy.map((task) => task.id));
    for (const id of params.addBlockedBy ?? []) blockedBy.add(id);
    for (const id of params.removeBlockedBy ?? []) blockedBy.delete(id);
    const task = this.options.storage.taskBoards.updateTask(
      current.boardId,
      current.id,
      {
        ...(params.subject === undefined ? {} : { subject: params.subject }),
        ...(params.description === undefined
          ? {}
          : { description: params.description }),
        ...(params.activeForm === undefined
          ? {}
          : { activeForm: params.activeForm }),
        ...(params.status === undefined
          ? {}
          : { status: storageTaskStatus(params.status) }),
        ...(params.owner === undefined ? {} : { owner: params.owner }),
        blockedBy: [...blockedBy],
        ...(params.metadata === undefined
          ? {}
          : { metadata: toJson(params.metadata) as Record<string, unknown> }),
      },
    );
    return { task: protocolTask(task) };
  }

  private deleteTask(params: ParsedClientParams<'task/delete'>) {
    const current = this.requireTask(params.id);
    if (
      !this.options.storage.taskBoards.deleteTask(current.boardId, current.id)
    ) {
      throw invalid(`Task ${params.id} was not deleted.`);
    }
    return { ok: true };
  }

  private claimTask(params: ParsedClientParams<'task/claim'>) {
    const current = this.requireTask(params.id);
    const result = this.options.storage.taskBoards.claimTask(
      current.boardId,
      current.id,
      params.owner,
    );
    if (!result.ok) throw invalid(result.reason);
    return { task: protocolTask(result.task) };
  }

  private resetTasks(params: ParsedClientParams<'task/reset'>) {
    if (!params.force) throw invalid('task/reset requires force=true.');
    const board = this.options.storage.taskBoards.getBoardById(params.boardId);
    if (board === null) throw invalid(`Unknown task board ${params.boardId}.`);
    this.options.storage.taskBoards.resetBoard(board.id);
    return { ok: true };
  }

  private requireTask(id: string): Task {
    const task = this.options.storage.taskBoards.findTaskById(id);
    if (task === null) throw invalid(`Unknown task ${id}.`);
    return task;
  }

  private async readFile(params: ParsedClientParams<'fs/readFile'>) {
    const target = await existingPathInside(params.cwd, params.path);
    const info = await lstat(target);
    if (!info.isFile()) throw invalid(`Path is not a regular file: ${target}.`);
    if (info.size > MAX_FILE_BYTES) {
      throw invalid(`File exceeds the ${MAX_FILE_BYTES} byte read limit.`);
    }
    const contentBytes = await readFile(target);
    if (contentBytes.byteLength > MAX_FILE_BYTES) {
      throw invalid(`File exceeds the ${MAX_FILE_BYTES} byte read limit.`);
    }
    const content = decodeUtf8(contentBytes, target);
    const byteCount = contentBytes.byteLength;
    const maxBytes = params.maxBytes ?? INLINE_ARTIFACT_BYTES;
    if (byteCount <= maxBytes) {
      return { path: target, content, byteCount, truncated: false };
    }
    const artifact = await this.options.storage.artifacts.put({
      kind: 'file-read',
      content: contentBytes,
      contentType: 'text/plain',
      owner: {
        kind: 'tool-result',
        id: createEntityId('job'),
        relation: target,
      },
    });
    return {
      path: target,
      content: utf8Prefix(content, maxBytes),
      byteCount,
      truncated: true,
      artifactId: artifact.id,
    };
  }

  private async readDirectory(params: ParsedClientParams<'fs/readDirectory'>) {
    const directory = await existingPathInside(params.cwd, params.path);
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      data: await Promise.all(
        entries
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(async (entry) => ({
            name: entry.name,
            path: path.join(directory, entry.name),
            kind: entry.isSymbolicLink()
              ? ('symlink' as const)
              : entry.isDirectory()
                ? ('directory' as const)
                : ('file' as const),
          })),
      ),
    };
  }

  private async fileMetadata(params: ParsedClientParams<'fs/getMetadata'>) {
    const target = lexicalPathInside(params.cwd, params.path);
    const info = await lstat(target);
    if (info.isSymbolicLink())
      await existingPathInside(params.cwd, params.path);
    return metadata(target, info);
  }

  private async searchFiles(params: ParsedClientParams<'fs/search'>) {
    const root = await existingPathInside(params.cwd, '.');
    const query = params.query.toLocaleLowerCase();
    const results: Array<{
      name: string;
      path: string;
      kind: 'file' | 'directory' | 'symlink';
    }> = [];
    const pending = [root];
    while (pending.length > 0 && results.length < params.limit) {
      const directory = pending.shift()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const target = path.join(directory, entry.name);
        const kind = entry.isSymbolicLink()
          ? ('symlink' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : ('file' as const);
        if (entry.isDirectory()) pending.push(target);
        const matchesKind =
          params.kind === 'any' ||
          (params.kind === 'directory' && kind === 'directory') ||
          (params.kind === 'file' && kind === 'file');
        if (matchesKind && entry.name.toLocaleLowerCase().includes(query)) {
          results.push({ name: entry.name, path: target, kind });
          if (results.length >= params.limit) break;
        }
      }
    }
    return { data: results };
  }

  private async watchFiles(
    connection: ServerConnection,
    params: ParsedClientParams<'fs/watch'>,
  ) {
    const targets = await Promise.all(
      params.paths.map((target) => existingPathInside(params.cwd, target)),
    );
    const watchId = createEntityId('watch');
    const watchers = targets.map((target) =>
      watch(target, (event, fileName) => {
        void connection
          .sendNotification({
            method: 'fs/changed',
            params: {
              watchId,
              path: path.join(target, fileName?.toString() ?? ''),
              event,
            },
          })
          .catch(() => undefined);
      }),
    );
    const combined = {
      close: () => {
        for (const watcher of watchers) watcher.close();
      },
    } as FSWatcher;
    this.watchers.set(watchId, {
      connectionId: connection.id,
      watcher: combined,
    });
    return { watchId };
  }

  private unwatchFiles(
    connection: ServerConnection,
    params: ParsedClientParams<'fs/unwatch'>,
  ) {
    const owned = this.watchers.get(params.watchId);
    if (owned === undefined || owned.connectionId !== connection.id) {
      throw invalid(`Unknown watch ${params.watchId}.`);
    }
    owned.watcher.close();
    this.watchers.delete(params.watchId);
    return { ok: true };
  }

  private async repoMethod(method: ClientMethod, rawParams: unknown) {
    const store = new RepoStore(this.options.storage.repositories);
    switch (method) {
      case 'repo/add': {
        const params = rawParams as ParsedClientParams<'repo/add'>;
        let repository = await store.add(params.source, params.key);
        if (params.remoteUrl !== undefined && repository.remoteUrl === null) {
          repository = await store.remoteAdd(repository.key, params.remoteUrl);
        }
        return { repository: protocolRepository(repository) };
      }
      case 'repo/list':
        return { data: store.list().map(protocolRepository) };
      case 'repo/read': {
        const params = rawParams as ParsedClientParams<'repo/read'>;
        const repository = store.show(params.repo);
        if (repository === null) throw invalid(`Unknown repo ${params.repo}.`);
        return { repository: protocolRepository(repository) };
      }
      case 'repo/rename': {
        const params = rawParams as ParsedClientParams<'repo/rename'>;
        return {
          repository: protocolRepository(
            store.rename(params.repo, params.name),
          ),
        };
      }
      case 'repo/remove': {
        const params = rawParams as ParsedClientParams<'repo/remove'>;
        await store.remove(params.repo);
        return { ok: true };
      }
      case 'repo/fetch': {
        const params = rawParams as ParsedClientParams<'repo/fetch'>;
        await store.fetch([params.repo]);
        const repository = store.show(params.repo);
        if (repository === null) throw invalid(`Unknown repo ${params.repo}.`);
        return { repository: protocolRepository(repository) };
      }
      case 'repo/fetchLocal': {
        const params = rawParams as ParsedClientParams<'repo/fetchLocal'>;
        return {
          repository: protocolRepository(
            await store.fetchLocal(params.repo, params.path),
          ),
        };
      }
      case 'repo/remote/read': {
        const params = rawParams as ParsedClientParams<'repo/remote/read'>;
        const remote = store.remoteShow(params.repo);
        return {
          remotes:
            remote.remoteUrl === null ? {} : { origin: remote.remoteUrl },
        };
      }
      case 'repo/remote/add':
      case 'repo/remote/set': {
        const params = rawParams as ParsedClientParams<'repo/remote/add'>;
        assertOrigin(params.name);
        const repository =
          method === 'repo/remote/add'
            ? await store.remoteAdd(params.repo, params.url)
            : await store.remoteSet(params.repo, params.url);
        return { repository: protocolRepository(repository) };
      }
      case 'repo/remote/remove': {
        const params = rawParams as ParsedClientParams<'repo/remote/remove'>;
        assertOrigin(params.name);
        return {
          repository: protocolRepository(await store.remoteRemove(params.repo)),
        };
      }
      case 'repo/export': {
        const params = rawParams as ParsedClientParams<'repo/export'>;
        return this.exportRepositories(store, params.repos ?? []);
      }
      case 'repo/import': {
        const params = rawParams as ParsedClientParams<'repo/import'>;
        return this.importRepositories(store, params.document);
      }
      default:
        throw invalid(`Invalid repo method ${method}.`);
    }
  }

  private async exportRepositories(store: RepoStore, keys: readonly string[]) {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-repo-export-'),
    );
    const outputDir = path.join(temporaryRoot, 'portable');
    try {
      const exported = await store.export(keys, outputDir);
      return {
        document: {
          formatVersion: exported.formatVersion,
          exportedAt: exported.exportedAt,
          repositories: await Promise.all(
            exported.repositories.map(async (repository) => ({
              key: repository.key,
              remoteUrl: repository.remoteUrl,
              defaultBranch: repository.defaultBranch,
              ...(repository.bundle === undefined
                ? {}
                : {
                    bundle: {
                      encoding: 'base64',
                      data: await readFile(
                        path.join(outputDir, repository.bundle),
                        'base64',
                      ),
                    },
                  }),
            })),
          ),
        },
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async importRepositories(store: RepoStore, input: unknown) {
    const document = readRepositoryImport(input);
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-repo-import-'),
    );
    const inputDir = path.join(temporaryRoot, 'portable');
    try {
      await mkdir(path.join(inputDir, 'bundles'), { recursive: true });
      const repositories = [];
      for (const [index, repository] of document.repositories.entries()) {
        const bundle = repository.bundle;
        const bundlePath =
          bundle === undefined
            ? undefined
            : `bundles/repository-${index}.bundle`;
        if (bundlePath !== undefined) {
          await writeFile(
            path.join(inputDir, bundlePath),
            decodeBase64Bundle(bundle!.data),
            { flag: 'wx' },
          );
        }
        repositories.push({
          key: repository.key,
          remoteUrl: repository.remoteUrl,
          defaultBranch: repository.defaultBranch,
          ...(bundlePath === undefined ? {} : { bundle: bundlePath }),
        });
      }
      await writeFile(
        path.join(inputDir, 'repos.yaml'),
        stringifyYamlConfig({
          formatVersion: 1,
          exportedAt: document.exportedAt,
          repositories,
        }),
        'utf8',
      );
      const imported = await store.import(inputDir);
      return { data: imported.map(protocolRepository) };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async workspaceStore(cwd = process.cwd()) {
    const config = await loadCodingAgentConfig({ cwd });
    const repos = new RepoStore(this.options.storage.repositories);
    const store = new WorkspaceStore(
      this.options.storage.workspaces,
      repos,
      resolveWorkspaceMount(config.workspace.mount),
    );
    await store.initializeMount();
    return store;
  }

  private async workspaceMethod(method: ClientMethod, rawParams: unknown) {
    const store = await this.workspaceStore();
    switch (method) {
      case 'workspace/create': {
        const params = rawParams as ParsedClientParams<'workspace/create'>;
        return {
          workspace: protocolWorkspace(
            await store.create(params.kind, params.name, params.repos),
          ),
        };
      }
      case 'workspace/list':
        return {
          data: store.list({ status: 'active' }).map(protocolWorkspace),
        };
      case 'workspace/archived/list':
        return {
          data: store.list({ status: 'archived' }).map(protocolWorkspace),
        };
      case 'workspace/read': {
        const params = rawParams as ParsedClientParams<'workspace/read'>;
        return {
          workspace: protocolWorkspace(openWorkspace(store, params.workspace)),
        };
      }
      case 'workspace/path': {
        const params = rawParams as ParsedClientParams<'workspace/path'>;
        return { path: openWorkspace(store, params.workspace).rootPath };
      }
      case 'workspace/status': {
        const params = rawParams as ParsedClientParams<'workspace/status'>;
        const [status] = await store.status([
          openWorkspace(store, params.workspace),
        ]);
        if (status === undefined)
          throw invalid(`Unknown workspace ${params.workspace}.`);
        return { status: toJson(status) };
      }
      case 'workspace/repo/add': {
        const params = rawParams as ParsedClientParams<'workspace/repo/add'>;
        if (params.detached !== (params.role === 'reference')) {
          throw invalid(
            'detached must be true exactly for reference checkouts.',
          );
        }
        const workspace = await store.addRepos(
          openWorkspace(store, params.workspace),
          [params.repo],
          params.role,
        );
        return { workspace: protocolWorkspace(workspace) };
      }
      case 'workspace/repo/create': {
        const params = rawParams as ParsedClientParams<'workspace/repo/create'>;
        return {
          workspace: protocolWorkspace(
            await store.createRepo(
              openWorkspace(store, params.workspace),
              params.key,
            ),
          ),
        };
      }
      case 'workspace/repo/remove': {
        const params = rawParams as ParsedClientParams<'workspace/repo/remove'>;
        return {
          workspace: protocolWorkspace(
            await store.removeRepos(
              openWorkspace(store, params.workspace),
              [params.repo],
              false,
            ),
          ),
        };
      }
      case 'workspace/rename': {
        const params = rawParams as ParsedClientParams<'workspace/rename'>;
        return {
          workspace: protocolWorkspace(
            await store.rename(
              openWorkspace(store, params.workspace),
              params.name,
            ),
          ),
        };
      }
      case 'workspace/archive': {
        const params = rawParams as ParsedClientParams<'workspace/archive'>;
        return {
          workspace: protocolWorkspace(
            await store.archive(openWorkspace(store, params.workspace)),
          ),
        };
      }
      case 'workspace/delete': {
        const params = rawParams as ParsedClientParams<'workspace/delete'>;
        await store.delete(
          openWorkspace(store, params.workspace),
          params.force,
        );
        return { ok: true };
      }
      case 'workspace/reconcile': {
        const params = rawParams as ParsedClientParams<'workspace/reconcile'>;
        return {
          result: toJson(
            await store.reconcile([openWorkspace(store, params.workspace)]),
          ),
        };
      }
      case 'workspace/repair': {
        const params = rawParams as ParsedClientParams<'workspace/repair'>;
        return {
          result: toJson(
            await store.repair([openWorkspace(store, params.workspace)]),
          ),
        };
      }
      case 'workspace/tmux/new': {
        const params = rawParams as ParsedClientParams<'workspace/tmux/new'>;
        if (params.command !== undefined) {
          throw invalid(
            'workspace/tmux/new command is not supported by TmuxStore.',
          );
        }
        const workspace = openWorkspace(store, params.workspace);
        const session = `${workspace.kind}-${workspace.name}`;
        await store.bindTmux(workspace, session);
        return { session };
      }
      default:
        throw invalid(`Invalid workspace method ${method}.`);
    }
  }
}

function skillEntry(skill: {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly skillPath: string;
  readonly contentHash: string;
}) {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    enabled: true,
    metadata: {
      source: skill.source,
      path: skill.skillPath,
      contentHash: skill.contentHash,
    },
  };
}

function protocolTask(task: Task) {
  return {
    id: task.id,
    boardId: task.boardId,
    subject: task.subject,
    description: task.description,
    ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
    status: protocolTaskStatus(task.status),
    owner: task.owner ?? null,
    blockedBy: task.blockedBy.map((blocked) => blocked.id),
    metadata: toJson(task.metadata) as Record<string, unknown>,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function protocolTaskStatus(status: Task['status']) {
  return status === 'in_progress' ? ('inProgress' as const) : status;
}

function storageTaskStatus(
  status: 'pending' | 'inProgress' | 'completed' | 'cancelled',
) {
  return status === 'inProgress' ? ('in_progress' as const) : status;
}

function protocolRepository(repository: Repository) {
  return {
    id: repository.id,
    key: repository.key,
    sourceUrl: repository.remoteUrl,
    mirrorPath: repository.mirrorPath,
    defaultBranch: repository.defaultBranch,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

function protocolWorkspace(workspace: Workspace) {
  return {
    id: workspace.id,
    kind: workspace.kind,
    name: workspace.name,
    rootPath: workspace.rootPath,
    status: workspace.status,
    branch: workspace.branch,
    repositories: toJson(workspace.repos) as unknown[],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function openWorkspace(store: WorkspaceStore, selector: string): Workspace {
  try {
    return store.openById(selector);
  } catch (idError) {
    const slash = selector.indexOf('/');
    if (slash <= 0 || slash === selector.length - 1) throw idError;
    return store.open(selector.slice(0, slash), selector.slice(slash + 1));
  }
}

function readRepositoryImport(document: unknown): {
  readonly exportedAt: string;
  readonly repositories: readonly {
    readonly key: string;
    readonly remoteUrl: string | null;
    readonly defaultBranch: string;
    readonly bundle?: { readonly encoding: 'base64'; readonly data: string };
  }[];
} {
  if (typeof document !== 'object' || document === null) {
    throw invalid('Repository import document must be an object.');
  }
  const value = document as {
    readonly formatVersion?: unknown;
    readonly exportedAt?: unknown;
    readonly repositories?: unknown;
  };
  if (value.formatVersion !== 1 || typeof value.exportedAt !== 'string') {
    throw invalid('Repository import requires formatVersion 1 and exportedAt.');
  }
  const entries = value.repositories;
  if (!Array.isArray(entries))
    throw invalid('Repository import document has no repositories.');
  const repositories = entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null)
      throw invalid('Invalid repository import entry.');
    const key = (entry as { readonly key?: unknown }).key;
    const remoteUrl = (entry as { readonly remoteUrl?: unknown }).remoteUrl;
    const defaultBranch = (entry as { readonly defaultBranch?: unknown })
      .defaultBranch;
    const bundle = (entry as { readonly bundle?: unknown }).bundle;
    if (
      typeof key !== 'string' ||
      (typeof remoteUrl !== 'string' && remoteUrl !== null) ||
      typeof defaultBranch !== 'string'
    ) {
      throw invalid('Repository import entry fields are invalid.');
    }
    if (remoteUrl === null) {
      if (
        typeof bundle !== 'object' ||
        bundle === null ||
        (bundle as { readonly encoding?: unknown }).encoding !== 'base64' ||
        typeof (bundle as { readonly data?: unknown }).data !== 'string'
      ) {
        throw invalid(`Local-only repository ${key} requires a base64 bundle.`);
      }
      return {
        key,
        remoteUrl,
        defaultBranch,
        bundle: bundle as {
          readonly encoding: 'base64';
          readonly data: string;
        },
      };
    }
    if (bundle !== undefined) {
      throw invalid(`Remote repository ${key} must not contain a bundle.`);
    }
    return { key, remoteUrl, defaultBranch };
  });
  return { exportedAt: value.exportedAt, repositories };
}

function decodeBase64Bundle(value: string): Buffer {
  if (
    value.length > 128 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw invalid('Repository bundle is not valid bounded base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw invalid('Repository bundle is not canonical base64.');
  }
  return decoded;
}

function assertOrigin(name: string): void {
  if (name !== 'origin')
    throw invalid('Ello repositories expose only the origin remote.');
}

async function existingPathInside(
  cwd: string,
  target: string,
): Promise<string> {
  const lexical = lexicalPathInside(cwd, target);
  const canonical = await realpath(lexical);
  assertPathInside(cwd, canonical);
  return canonical;
}

function lexicalPathInside(cwd: string, target: string): string {
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target);
  assertPathInside(root, resolved);
  return resolved;
}

function assertPathInside(cwd: string, target: string): void {
  const relative = path.relative(path.resolve(cwd), path.resolve(target));
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
    return;
  throw new AppServerError({
    type: 'pathOutsideWorkspace',
    message: `Path escapes Server workspace: ${target}.`,
    details: { cwd: path.resolve(cwd), path: target },
  });
}

function metadata(target: string, info: Awaited<ReturnType<typeof lstat>>) {
  return {
    path: target,
    kind: info.isSymbolicLink()
      ? ('symlink' as const)
      : info.isDirectory()
        ? ('directory' as const)
        : ('file' as const),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

function page<T>(
  values: readonly T[],
  cursor: string | undefined,
  limit: number,
) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw invalid(`Invalid cursor ${String(cursor)}.`);
  const data = values.slice(offset, offset + limit);
  const next = offset + data.length;
  return {
    data,
    ...(next < values.length ? { nextCursor: String(next) } : {}),
  };
}

function renderThreadMarkdown(snapshot: ThreadSnapshot): string {
  const lines = [
    `# ${snapshot.thread.name || snapshot.thread.id}`,
    '',
    `- Thread: ${snapshot.thread.id}`,
    `- CWD: ${snapshot.thread.cwd}`,
    '',
  ];
  for (const turn of snapshot.turns) {
    lines.push(`## Turn ${turn.id}`, '');
    for (const item of turn.items) lines.push(renderItem(item), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderThreadHtml(snapshot: ThreadSnapshot): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(snapshot.thread.name || snapshot.thread.id)}</title></head><body><pre>${escapeHtml(renderThreadMarkdown(snapshot))}</pre></body></html>`;
}

function renderItem(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage':
    case 'agentMessage':
    case 'plan':
      return `### ${item.type}\n\n${item.text}`;
    case 'commandExecution':
      return `### command\n\n\`${item.command}\`\n\n${item.outputPreview ?? ''}`;
    case 'fileChange':
      return `### files\n\n${item.changes.map((change) => change.path).join('\n')}`;
    case 'toolCall':
      return `### ${item.toolName}\n\n${item.outputPreview ?? item.headline}`;
    case 'reasoning':
      return `### reasoning\n\n${item.summary}`;
    case 'subagent':
      return `### ${item.agentName}\n\n${item.output ?? item.description}`;
    case 'contextCompaction':
      return `### compaction\n\n${item.summary}`;
    case 'notice':
    case 'error':
      return `### ${item.type}\n\n${item.message}`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function invalid(message: string): AppServerError {
  return new AppServerError({ type: 'invalidParams', message });
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  const content = Buffer.from(value, 'utf8');
  if (content.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(content.subarray(0, end));
    } catch {
      // UTF-8 code point 最多四字节，向前收缩直到落在完整字符边界。
    }
  }
  return '';
}

function decodeUtf8(content: Buffer, target: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new AppServerError({
      type: 'invalidParams',
      message: `File is not valid UTF-8 text: ${target}.`,
      cause: error,
    });
  }
}
