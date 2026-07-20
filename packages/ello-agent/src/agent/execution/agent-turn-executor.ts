import { loadCodingAgentConfig } from '../../config/index.js';
import { createEntityId } from '../../domain/ids.js';
import type {
  TurnExecutionEvent,
  TurnExecutionHandle,
  TurnExecutionResult,
  TurnExecutor,
  TurnExecutorFactory,
} from '../../domain/ports/turn-executor.js';
import type { SessionModeState } from '../../domain/thread/session-mode.js';
import { createTurnTracing } from '../../observability/turn-tracing.js';
import type {
  ApprovalDecision,
  PendingServerRequest,
  ThreadItem,
  ThreadSnapshot,
  Turn,
  UserInput,
  UserInputResolution,
} from '../../protocol/v1/index.js';
import {
  createRequestUserInputTool,
  REQUEST_USER_INPUT_TOOL_NAME,
  UserInputRequestSchema,
  validateUserInputResolution,
} from '../../server/interaction/user-input/index.js';
import type { CodingStorage } from '../../storage/database/index.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';
import { ThreadTranscriptStore } from '../../storage/threads/transcript-store.js';
import { CheckpointStore } from '../change/checkpoint.js';
import { recordCheckpointChanges } from '../change/recording.js';
import { dynamicSystemSection } from '../context/cache-layout.js';
import { createCodingSystemPromptSection } from '../context/prompts.js';
import { createThreadCompactor } from '../context/thread-compactor.js';
import type {
  Agent,
  AgentRunResult,
  AgentStream,
  EngineEvent,
  AnyAgentTool,
  DeferredApprovalItem,
  DeferredRunItem,
  DeferredToolCallItem,
} from '../engine/index.js';
import {
  createAgent,
  defineDeferredTool,
  defineTool,
  skillIndexContext,
  z,
} from '../engine/index.js';
import { createThreadGoalRuntime } from '../goals/runtime-tools.js';
import { RulesStore } from '../permissions/rules-store.js';
import { readPlanArtifact, writePlanArtifact } from '../plans/artifact.js';
import {
  createProviderRegistry,
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
  type RuntimeRoleModel,
} from '../providers/catalog/index.js';
import { SkillActivationService } from '../skills/activation.js';
import { SkillCatalog } from '../skills/index.js';
import { createActivateSkillTool } from '../skills/tool.js';
import { createAgentRegistry } from '../subagents/registry.js';
import {
  projectApprovalItem,
  projectToolEvent,
} from '../tools/event-projection.js';
import {
  createMetaToolRuntime,
  TOOL_ROUTING_INSTRUCTIONS,
} from '../tools/meta-tools.js';
import {
  createProductionToolRuntime,
  markCoreTool,
} from '../tools/production.js';
import type {
  CodingToolResult,
  ToolMetadata,
} from '../tools/runtime/coding-tool.js';

import { createRuntimeEnvironment } from './runtime-environment.js';

const PLAN_EXIT_TOOL_NAME = 'request_plan_exit';

export interface AgentTurnExecutorFactoryOptions {
  readonly logs: ThreadLogRepository;
  readonly storage: CodingStorage;
}

/** Server bootstrap 使用的唯一生产 executor factory。 */
export function createAgentTurnExecutorFactory(
  options: AgentTurnExecutorFactoryOptions,
): TurnExecutorFactory {
  return (snapshot) =>
    Promise.resolve(
      new AgentTurnExecutor({
        initialThread: snapshot,
        logs: options.logs,
        storage: options.storage,
      }),
    );
}

interface AgentTurnExecutorOptions extends AgentTurnExecutorFactoryOptions {
  readonly initialThread: ThreadSnapshot;
}

class AgentTurnExecutor implements TurnExecutor {
  private readonly externalPaths = new Set<string>();
  private readonly rules: RulesStore;
  private rulesLoaded = false;
  private active: AgentExecutionHandle | undefined;

  constructor(private readonly options: AgentTurnExecutorOptions) {
    this.rules = new RulesStore(options.initialThread.thread.cwd);
  }

  async start(input: {
    readonly thread: ThreadSnapshot;
    readonly turn: Turn;
    readonly userInput: readonly UserInput[];
  }): Promise<TurnExecutionHandle> {
    if (this.active !== undefined) {
      throw new Error(
        `Thread ${input.thread.thread.id} already has an executor run.`,
      );
    }
    if (!this.rulesLoaded) {
      await this.rules.load();
      this.rulesLoaded = true;
    }
    const composition = await composeAgent({
      thread: input.thread,
      logs: this.options.logs,
      storage: this.options.storage,
      rules: this.rules,
      externalPaths: this.externalPaths,
    });
    const handle = new AgentExecutionHandle({
      agent: composition.agent,
      checkpoints: new CheckpointStore(this.options.storage.checkpoints),
      rules: this.rules,
      externalPaths: this.externalPaths,
      acceptPlan: composition.acceptPlan,
      closeAgent: composition.close,
      thread: input.thread,
      turn: input.turn,
      input: input.userInput,
      maxTurns: composition.maxTurns,
    });
    this.active = handle;
    const clearActive = () => {
      if (this.active === handle) this.active = undefined;
    };
    void handle.final.then(clearActive, clearActive);
    return handle;
  }

  async close(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    await active.interrupt('executor closing');
    await active.final;
  }
}

async function composeAgent(input: {
  readonly thread: ThreadSnapshot;
  readonly logs: ThreadLogRepository;
  readonly storage: CodingStorage;
  readonly rules: RulesStore;
  readonly externalPaths: ReadonlySet<string>;
}): Promise<{
  readonly agent: Agent;
  readonly maxTurns: number;
  acceptPlan(): void;
  close(): Promise<void>;
}> {
  const settings = input.thread.settings;
  const config = await loadCodingAgentConfig({
    cwd: input.thread.thread.cwd,
    initial_mode: settings.mode,
  });
  const providerRegistry = createProviderRegistry(config);
  const profileBinding = providerRegistry.resolveRole(
    settings.profile,
    'primary',
  );
  const binding: RuntimeRoleModel = {
    ...profileBinding,
    ref: settings.model,
    model: providerRegistry.getModel(settings.model),
  };
  if (!binding.model.capabilities.toolCall) {
    throw new Error(
      `Coding model '${binding.ref}' does not support tool calls.`,
    );
  }

  const agentRegistry = await createAgentRegistry(config);
  const agentName =
    settings.agent === 'primary' ? config.default_agent : settings.agent;
  const definition = agentRegistry.get(agentName);
  if (
    (definition.mode !== 'primary' && definition.mode !== 'all') ||
    definition.hidden === true
  ) {
    throw new Error(`Agent is not selectable as primary: ${agentName}`);
  }

  const skills = new SkillCatalog(config);
  await skills.initialize();
  const activation = new SkillActivationService(skills);
  let modeState: SessionModeState = {
    mode: settings.mode,
    previousMode: null,
    source: 'resume',
    changedAt: new Date().toISOString(),
  };
  const productionTools = createProductionToolRuntime({
    config,
    storage: input.storage,
    taskBoardScope: {
      type: 'session',
      sessionId: input.thread.thread.id,
    },
    rules: () => input.rules.rules(),
    mode: () => modeState,
    readRoots: () =>
      skills.list().flatMap((skill) => [skill.baseDir, skill.realPath]),
  });
  await productionTools.initialize();
  const selected = selectTools(productionTools.tools, definition.tools);
  const goalRuntime = createThreadGoalRuntime(input.thread.goal);
  const directTools: AnyAgentTool[] = [
    createActivateSkillTool({ service: activation }),
    createRequestUserInputTool(),
    ...goalRuntime.tools,
  ].map(markCoreTool);
  if (settings.mode === 'plan') {
    directTools.push(
      markCoreTool(
        defineTool({
          name: 'write_plan',
          description: 'Persist the complete Markdown plan for this thread.',
          discovery: { aliases: ['save plan'], risk: 'workspace-write' },
          input: z
            .object({
              content: z.string().min(1).describe('Markdown plan content'),
            })
            .strict(),
          execute: async ({ content }) => {
            const artifact = await writePlanArtifact({
              cwd: input.thread.thread.cwd,
              sessionId: input.thread.thread.id,
              content,
            });
            return {
              kind: 'thread-plan-written' as const,
              plan: {
                threadId: input.thread.thread.id,
                status: 'draft' as const,
                contentHash: artifact.contentHash,
                content: artifact.content,
                path: artifact.path,
                updatedAt: new Date().toISOString(),
              },
            };
          },
        }),
      ),
      markCoreTool(
        defineDeferredTool({
          name: PLAN_EXIT_TOOL_NAME,
          description: 'Request approval for the current persisted plan.',
          discovery: { aliases: ['approve plan'], risk: 'workspace-write' },
          input: z.object({}).strict(),
        }),
      ),
    );
  }
  const toolRuntime = createMetaToolRuntime(
    selected,
    directTools,
    config.tools,
  );
  const sections = [
    skillIndexContext({
      skills: skills.list(),
      contextWindow: binding.model.limit.context,
    }),
    createCodingSystemPromptSection(config, {
      model: binding.ref,
      ...(productionTools.memoryIndexLoader === undefined
        ? {}
        : { memoryIndexLoader: productionTools.memoryIndexLoader }),
    }),
    dynamicSystemSection(goalRuntime.systemSection),
    ...(toolRuntime.usesToolRouting
      ? [dynamicSystemSection(() => TOOL_ROUTING_INSTRUCTIONS)]
      : []),
  ];
  const tracing = createTurnTracing(
    config.observability?.langfuse,
    input.thread.thread.id,
  );
  const compactor = createThreadCompactor({
    logs: input.logs,
    config,
    profileName: settings.profile,
    contextWindow: Math.min(
      binding.model.limit.context,
      config.context.max_input_tokens,
    ),
    agentRegistry,
  });
  let agent: Agent;
  try {
    agent = createAgent({
      name: `ello-${definition.name}`,
      model: providerRegistry.resolveLanguageModel(
        binding.ref,
        binding.settings,
      ),
      ...(definition.prompt === undefined
        ? {}
        : { instructions: definition.prompt }),
      modelSettings: modelSettingsFromRole(binding),
      environment: createRuntimeEnvironment(
        config,
        () => input.rules.rules(),
        () => [...input.externalPaths],
        () => skills.list().flatMap((skill) => [skill.baseDir, skill.realPath]),
      ),
      executionTools: toolRuntime.executionTools,
      modelTools: toolRuntime.modelTools,
      transcript: new ThreadTranscriptStore(input.logs),
      compaction: compactor,
      ...(tracing.eventRecorder === undefined
        ? {}
        : { eventRecorder: tracing.eventRecorder }),
      sessionWindow: { maxMessages: 200 },
      modelInputBudget: {
        maxInputTokens: config.context.max_input_tokens,
        reservedOutputTokens: config.context.reserved_output_tokens,
      },
      modelInput: {
        systemSections: sections,
        providerOptions: () => providerOptionsForRole(binding),
        prepare: (modelInput) =>
          prepareModelInputForRuntimeModel(binding.model, modelInput, {
            promptProfile: config.context.system_prompt_profile,
            cwdIdentity: config.cwd,
          }),
      },
      metadata: { threadId: input.thread.thread.id, cwd: config.cwd },
    });
  } catch (error) {
    await tracing.close();
    throw error;
  }
  return {
    agent,
    maxTurns: definition.maxTurns ?? 100,
    acceptPlan: () => {
      modeState = {
        mode: 'ask-before-changes',
        previousMode: modeState.mode,
        source: 'plan-accept',
        changedAt: new Date().toISOString(),
      };
    },
    close: async () => {
      try {
        await agent.close();
      } finally {
        await tracing.close();
      }
    },
  };
}

interface AgentExecutionHandleOptions {
  readonly agent: Agent;
  readonly checkpoints: CheckpointStore;
  readonly rules: RulesStore;
  readonly externalPaths: Set<string>;
  acceptPlan(): void;
  closeAgent(): Promise<void>;
  readonly thread: ThreadSnapshot;
  readonly turn: Turn;
  readonly input: readonly UserInput[];
  readonly maxTurns: number;
}

interface PendingInteraction {
  readonly deferred: DeferredApprovalItem | DeferredToolCallItem;
  readonly method: PendingServerRequest['method'];
  readonly result: Promise<unknown>;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

class AgentExecutionHandle implements TurnExecutionHandle {
  readonly events: AsyncIterable<TurnExecutionEvent>;
  readonly final: Promise<TurnExecutionResult>;

  private readonly queue = new AsyncQueue<TurnExecutionEvent>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly messageText = new Map<string, string>();
  private readonly items = new Map<string, ThreadItem>();
  private activeStream: AgentStream | undefined;
  private interruptReason: string | undefined;
  private currentPlan: ThreadSnapshot['plan'];

  constructor(private readonly options: AgentExecutionHandleOptions) {
    this.currentPlan = options.thread.plan;
    this.events = this.queue;
    this.final = this.drive();
  }

  async steer(input: readonly UserInput[]): Promise<void> {
    const stream = this.activeStream;
    if (stream === undefined)
      throw new Error('Turn is not accepting steering.');
    stream.steer({
      role: 'user',
      content: input.map(formatUserInput).join('\n'),
    });
  }

  interrupt(reason: string): Promise<void> {
    this.interruptReason = reason;
    this.activeStream?.abort(reason);
    for (const interaction of this.pending.values()) {
      interaction.reject(new Error(`Turn interrupted: ${reason}`));
    }
    return Promise.resolve();
  }

  resolveServerRequest(requestId: string, result: unknown): Promise<void> {
    const interaction = this.requireInteraction(requestId);
    interaction.resolve(result);
    return Promise.resolve();
  }

  rejectServerRequest(
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void> {
    const interaction = this.requireInteraction(requestId);
    interaction.reject(new Error(`${error.code}: ${error.message}`));
    return Promise.resolve();
  }

  private async drive(): Promise<TurnExecutionResult> {
    let usage = emptyUsage();
    try {
      let stream = this.options.agent.stream(
        { prompt: this.options.input.map(formatUserInput).join('\n') },
        this.runOptions(),
      );
      while (true) {
        this.activeStream = stream;
        for await (const event of stream) await this.project(event);
        const result = await stream.final;
        usage = addUsage(usage, result.usage);
        await this.options.checkpoints.seal(result.id);
        await this.completeOpenItems();
        if (
          this.interruptReason !== undefined ||
          result.finishReason === 'interrupted'
        ) {
          this.queue.end();
          return {
            status: 'interrupted',
            usage,
            reason: this.interruptReason ?? 'agent interrupted',
          };
        }
        const pending = result.pending ?? [];
        if (pending.length === 0) {
          this.queue.end();
          if (isFailure(result)) {
            return {
              status: 'failed',
              usage,
              error: {
                code: 'AGENT_RUN_FAILED',
                message: `Agent finished with ${result.finishReason}.`,
              },
            };
          }
          return { status: 'completed', usage };
        }
        const resolution = await this.resolveDeferred(pending);
        stream = this.options.agent.resume(
          {
            deferred: pending,
            approvals: resolution.approvals,
            toolResults: resolution.toolResults,
          },
          this.runOptions(),
        );
      }
    } catch (error) {
      this.queue.fail(error);
      return {
        status: this.interruptReason === undefined ? 'failed' : 'interrupted',
        usage,
        ...(this.interruptReason === undefined
          ? {
              error: {
                code: 'AGENT_EXECUTION_FAILED',
                message: errorMessage(error),
              },
            }
          : { reason: this.interruptReason }),
      } as TurnExecutionResult;
    } finally {
      this.activeStream = undefined;
      await this.options.closeAgent();
    }
  }

  private runOptions() {
    return {
      sessionId: this.options.thread.thread.id,
      maxTurns: this.options.maxTurns,
      metadata: {
        threadId: this.options.thread.thread.id,
        turnId: this.options.turn.id,
      },
    } as const;
  }

  private async project(rawEvent: EngineEvent): Promise<void> {
    const event = projectToolEvent(rawEvent);
    switch (event.type) {
      case 'message.started': {
        const item: ThreadItem = {
          type: 'agentMessage',
          id: event.messageId,
          turnId: this.options.turn.id,
          createdAt: event.occurredAt,
          text: '',
          phase: 'final',
          status: 'inProgress',
        };
        this.messageText.set(event.messageId, '');
        this.items.set(item.id, item);
        this.queue.push({ type: 'itemStarted', item });
        return;
      }
      case 'message.delta':
        this.messageText.set(
          event.messageId,
          `${this.messageText.get(event.messageId) ?? ''}${event.text}`,
        );
        this.queue.push({
          type: 'itemDelta',
          itemId: event.messageId,
          delta: { type: 'agentMessage', text: event.text },
        });
        return;
      case 'tool.started': {
        const existing = this.items.get(event.toolCallId);
        if (existing !== undefined) {
          if ('status' in existing && existing.status === 'inProgress') {
            // 审批恢复会再次发 started；沿用审批前已持久化的 item，不能制造重复 id。
            return;
          }
          throw new Error(
            `Tool item ${event.toolCallId} started more than once.`,
          );
        }
        const item = startedToolItem(
          event.toolCallId,
          this.options.turn,
          event.name,
          event.input,
          event.occurredAt,
          this.options.thread.thread.cwd,
        );
        this.items.set(item.id, item);
        this.queue.push({ type: 'itemStarted', item });
        return;
      }
      case 'tool.completed': {
        recordCheckpointChanges({
          checkpoints: this.options.checkpoints,
          cwd: this.options.thread.thread.cwd,
          toolCallId: event.toolCallId,
          output: event.output,
        });
        const current = this.items.get(event.toolCallId);
        if (current !== undefined) {
          const item = completedToolItem(
            current,
            event.output,
            event.occurredAt,
          );
          this.items.set(item.id, item);
          this.queue.push({ type: 'itemCompleted', item });
        }
        const plan = writtenPlan(event.output);
        if (plan !== undefined) {
          this.currentPlan = plan;
          this.queue.push({ type: 'planUpdated', plan });
        }
        const goal = writtenGoal(event.output);
        if (goal !== undefined) {
          this.queue.push({ type: 'goalUpdated', goal });
        }
        return;
      }
      case 'tool.failed': {
        const current = this.items.get(event.toolCallId);
        if (current !== undefined) {
          const item = failItem(current, event.error.message);
          this.items.set(item.id, item);
          this.queue.push({ type: 'itemCompleted', item });
        }
        return;
      }
      case 'approval.required':
        this.createApprovalRequest(event.item, event.occurredAt);
        return;
      case 'tool.deferred':
        this.createDeferredRequest(event.item, event.occurredAt);
        return;
      case 'context.compaction': {
        const item: ThreadItem = {
          type: 'contextCompaction',
          id: createEntityId('item'),
          turnId: this.options.turn.id,
          createdAt: event.occurredAt,
          summary: `${event.beforeMessageCount} -> ${event.afterMessageCount} messages`,
          tokensBefore: 0,
          status: 'completed',
        };
        this.queue.push({
          type: 'itemStarted',
          item: { ...item, status: 'inProgress' },
        });
        this.queue.push({ type: 'itemCompleted', item });
        return;
      }
      case 'run.completed':
        // 一个 Turn 可能因审批或 deferred tool 产生多个 Engine run；最终统一发布累加值。
        return;
      case 'run.failed': {
        const item: ThreadItem = {
          type: 'error',
          id: createEntityId('item'),
          turnId: this.options.turn.id,
          createdAt: event.occurredAt,
          code: event.error.name || 'AGENT_ERROR',
          message: event.error.message,
        };
        this.queue.push({ type: 'itemStarted', item });
        this.queue.push({ type: 'itemCompleted', item });
        return;
      }
      default:
        return;
    }
  }

  private createApprovalRequest(
    deferred: DeferredApprovalItem,
    createdAt: string,
  ): void {
    const projected = projectApprovalItem(deferred);
    const metadata = readRecord(projected.metadata);
    const requestMetadata = readRecord(metadata.request);
    const requestId = createEntityId('srvreq');
    const itemId = projected.toolCallId;
    const method = approvalMethod(projected.toolName, requestMetadata);
    const base = {
      threadId: this.options.thread.thread.id,
      turnId: this.options.turn.id,
      itemId,
      reason:
        projected.reason ?? readString(metadata.reason) ?? 'Approval required.',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    } as const;
    const params =
      method === 'item/commandExecution/requestApproval'
        ? {
            ...base,
            command: [
              readString(requestMetadata.command) ?? projected.toolName,
            ],
            cwd:
              readString(requestMetadata.cwd) ?? this.options.thread.thread.cwd,
          }
        : method === 'item/fileChange/requestApproval'
          ? {
              ...base,
              paths: readStringArray(
                metadata.patterns,
                this.options.thread.thread.cwd,
              ),
              summary: projected.reason ?? `Run ${projected.toolName}`,
            }
          : {
              ...base,
              permission: readString(metadata.permission) ?? projected.toolName,
              scope: 'session' as const,
            };
    this.registerInteraction(requestId, projected, method, params, createdAt);
  }

  private createDeferredRequest(
    deferred: DeferredToolCallItem,
    createdAt: string,
  ): void {
    const requestId = createEntityId('srvreq');
    if (deferred.toolName === REQUEST_USER_INPUT_TOOL_NAME) {
      const input = UserInputRequestSchema.parse(deferred.input);
      this.registerInteraction(
        requestId,
        deferred,
        'item/tool/requestUserInput',
        {
          threadId: this.options.thread.thread.id,
          turnId: this.options.turn.id,
          itemId: deferred.toolCallId,
          reason: 'The agent needs user input to continue.',
          questions: input.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            multiple: question.multiSelect,
            options: question.options,
          })),
        },
        createdAt,
      );
      return;
    }
    if (deferred.toolName === PLAN_EXIT_TOOL_NAME) {
      const plan = this.currentPlan;
      if (plan === null)
        throw new Error('Plan approval requested before a plan exists.');
      this.currentPlan = {
        ...plan,
        status: 'awaitingApproval',
        updatedAt: new Date().toISOString(),
      };
      this.queue.push({ type: 'planUpdated', plan: this.currentPlan });
      this.registerInteraction(
        requestId,
        deferred,
        'item/plan/requestApproval',
        {
          threadId: this.options.thread.thread.id,
          turnId: this.options.turn.id,
          itemId: deferred.toolCallId,
          reason: 'Approve the current plan.',
          availableDecisions: ['accept', 'decline', 'cancel'],
          contentHash: this.currentPlan.contentHash,
          preview: this.currentPlan.content.slice(0, 4_000),
        },
        createdAt,
      );
      return;
    }
    throw new Error(`Unsupported deferred tool: ${deferred.toolName}`);
  }

  private registerInteraction(
    requestId: string,
    deferred: DeferredApprovalItem | DeferredToolCallItem,
    method: PendingServerRequest['method'],
    params: Record<string, unknown>,
    createdAt: string,
  ): void {
    let resolveResult: (result: unknown) => void = () => undefined;
    let rejectResult: (error: Error) => void = () => undefined;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => undefined);
    this.pending.set(requestId, {
      deferred,
      method,
      result,
      resolve: resolveResult,
      reject: rejectResult,
    });
    this.queue.push({
      type: 'serverRequest',
      request: {
        id: requestId,
        method,
        threadId: this.options.thread.thread.id,
        turnId: this.options.turn.id,
        itemId: deferred.toolCallId,
        params,
        createdAt,
      },
    });
  }

  private async resolveDeferred(deferred: readonly DeferredRunItem[]): Promise<{
    readonly approvals: Record<
      string,
      { readonly approved: boolean; readonly reason?: string }
    >;
    readonly toolResults: Record<string, unknown>;
  }> {
    const approvals: Record<
      string,
      { readonly approved: boolean; readonly reason?: string }
    > = {};
    const toolResults: Record<string, unknown> = {};
    for (const item of deferred) {
      if (item.kind === 'interrupted') {
        throw new Error(
          'Interrupted deferred items cannot be resumed by a Client.',
        );
      }
      const entry = [...this.pending.entries()].find(
        ([, candidate]) => candidate.deferred.toolCallId === item.toolCallId,
      );
      if (entry === undefined) {
        throw new Error(
          `Deferred item ${item.toolCallId} has no Server Request.`,
        );
      }
      const [requestId, interaction] = entry;
      const result = await interaction.result;
      this.pending.delete(requestId);
      if (item.kind === 'approval') {
        const decision = readApprovalDecision(result);
        if (decision.decision === 'acceptForSession') {
          await this.options.rules.addAllowRule(item, 'session');
        }
        if (
          decision.decision === 'accept' ||
          decision.decision === 'acceptForSession'
        ) {
          for (const externalDir of approvalExternalDirs(item)) {
            this.options.externalPaths.add(externalDir);
          }
        }
        approvals[item.toolCallId] = {
          approved:
            decision.decision === 'accept' ||
            decision.decision === 'acceptForSession',
          ...(decision.decision === 'decline'
            ? { reason: 'Declined by client.' }
            : decision.decision === 'cancel'
              ? { reason: 'Cancelled by client.' }
              : {}),
        };
      } else if (item.kind === 'tool-call') {
        if (item.toolName === REQUEST_USER_INPUT_TOOL_NAME) {
          toolResults[item.toolCallId] = validateUserInputResolution(
            UserInputRequestSchema.parse(item.input),
            result as UserInputResolution,
          );
        } else {
          const decision = readApprovalDecision(result);
          if (
            decision.decision === 'accept' ||
            decision.decision === 'acceptForSession'
          ) {
            const plan = this.currentPlan;
            if (plan === null) {
              throw new Error('Plan disappeared before approval.');
            }
            const artifact = await readPlanArtifact(
              this.options.thread.thread.cwd,
              this.options.thread.thread.id,
            );
            if (artifact.contentHash !== plan.contentHash) {
              throw new Error('Plan content hash is stale.');
            }
          }
          toolResults[item.toolCallId] = planResult(decision);
          if (this.currentPlan !== null) {
            this.currentPlan = {
              ...this.currentPlan,
              status:
                decision.decision === 'accept' ||
                decision.decision === 'acceptForSession'
                  ? 'accepted'
                  : 'rejected',
              updatedAt: new Date().toISOString(),
            };
            this.queue.push({ type: 'planUpdated', plan: this.currentPlan });
            if (this.currentPlan.status === 'accepted') {
              this.options.acceptPlan();
              this.queue.push({
                type: 'settingsUpdated',
                settings: {
                  ...this.options.thread.settings,
                  mode: 'ask-before-changes',
                },
              });
            }
          }
        }
      }
    }
    return { approvals, toolResults };
  }

  private async completeOpenItems(): Promise<void> {
    const pendingItemIds = new Set(
      [...this.pending.values()].map(
        (interaction) => interaction.deferred.toolCallId,
      ),
    );
    for (const [id, current] of this.items) {
      if ('status' in current && current.status !== 'inProgress') continue;
      // 等待 Client 决定的工具尚未执行，必须保留 inProgress 到 resume 终态事件。
      if (pendingItemIds.has(id)) continue;
      const item =
        current.type === 'agentMessage'
          ? {
              ...current,
              text: this.messageText.get(id) ?? current.text,
              status: 'completed' as const,
            }
          : completeItem(current);
      this.items.set(id, item);
      this.queue.push({ type: 'itemCompleted', item });
    }
  }

  private requireInteraction(requestId: string): PendingInteraction {
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) {
      throw new Error(`Unknown or resolved Server Request ${requestId}.`);
    }
    return interaction;
  }
}

function startedToolItem(
  id: string,
  turn: Turn,
  name: string,
  input: unknown,
  createdAt: string,
  defaultCwd: string,
): ThreadItem {
  const values = readRecord(input);
  if (name === 'bash') {
    return {
      type: 'commandExecution',
      id,
      turnId: turn.id,
      createdAt,
      command: readString(values.command) ?? name,
      cwd: readString(values.cwd) ?? defaultCwd,
      status: 'inProgress',
    };
  }
  if (['write', 'edit', 'apply_patch'].includes(name)) {
    return {
      type: 'fileChange',
      id,
      turnId: turn.id,
      createdAt,
      changes: [],
      status: 'inProgress',
    };
  }
  const serializedInput = jsonValue(input);
  return {
    type: 'toolCall',
    id,
    turnId: turn.id,
    createdAt,
    toolName: name,
    headline: toolHeadline(name, input),
    status: 'inProgress',
    ...(serializedInput === undefined
      ? {}
      : { metadata: { input: serializedInput } }),
  };
}

function completedToolItem(
  item: ThreadItem,
  output: unknown,
  _completedAt: string,
): ThreadItem {
  const result = codingToolResult(output);
  if (item.type === 'commandExecution') {
    return {
      ...item,
      status: 'completed',
      ...(result === undefined
        ? { outputPreview: preview(output) }
        : {
            outputPreview: result.output,
            exitCode: numberValue(result.metadata.exitCode),
            durationMs: nonNegativeNumber(result.metadata.durationMs),
          }),
    };
  }
  if (item.type === 'fileChange') {
    return {
      ...item,
      status: 'completed',
      changes: fileChanges(result?.metadata),
    };
  }
  if (item.type === 'toolCall') {
    return {
      ...item,
      status: 'completed',
      outputPreview: result?.output ?? preview(output),
    };
  }
  return completeItem(item);
}

function failItem(item: ThreadItem, message: string): ThreadItem {
  if (item.type === 'commandExecution') {
    return { ...item, status: 'failed', outputPreview: message };
  }
  if (item.type === 'fileChange' || item.type === 'toolCall') {
    return { ...item, status: 'failed' };
  }
  return item;
}

function completeItem(item: ThreadItem): ThreadItem {
  switch (item.type) {
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
    case 'subagent':
    case 'contextCompaction':
      return { ...item, status: 'completed' };
    case 'userMessage':
    case 'notice':
    case 'error':
      return item;
  }
}

function codingToolResult(value: unknown): CodingToolResult | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { readonly kind?: unknown }).kind !== 'coding-tool-result'
  ) {
    return undefined;
  }
  return value as CodingToolResult;
}

function writtenPlan(
  value: unknown,
): NonNullable<ThreadSnapshot['plan']> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { readonly kind?: unknown }).kind !== 'thread-plan-written'
  ) {
    return undefined;
  }
  return (value as { readonly plan: NonNullable<ThreadSnapshot['plan']> }).plan;
}

function writtenGoal(
  value: unknown,
): NonNullable<ThreadSnapshot['goal']> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { readonly kind?: unknown }).kind !== 'thread-goal-updated'
  ) {
    return undefined;
  }
  return (value as { readonly goal: NonNullable<ThreadSnapshot['goal']> }).goal;
}

function fileChanges(metadata: ToolMetadata | undefined) {
  const changes = metadata?.fileChanges;
  if (!Array.isArray(changes)) return [];
  return changes.map((change) => ({
    path: change.path,
    kind:
      change.kind === 'added'
        ? ('add' as const)
        : change.kind === 'deleted'
          ? ('delete' as const)
          : change.movePath === undefined
            ? ('modify' as const)
            : ('rename' as const),
    ...(change.movePath === undefined ? {} : { oldPath: change.path }),
    additions: change.additions,
    deletions: change.deletions,
    diff: change.unifiedDiff,
  }));
}

function approvalMethod(
  toolName: string,
  request: Record<string, unknown>,
):
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval' {
  if (toolName === 'bash' || request.kind === 'shell') {
    return 'item/commandExecution/requestApproval';
  }
  if (
    ['write', 'edit', 'apply_patch'].includes(toolName) ||
    request.kind === 'edit'
  ) {
    return 'item/fileChange/requestApproval';
  }
  return 'item/permissions/requestApproval';
}

function selectTools(
  tools: readonly AnyAgentTool[],
  whitelist: readonly string[] | undefined,
): AnyAgentTool[] {
  if (whitelist === undefined) return [...tools];
  const available = new Set(tools.map((tool) => tool.name));
  const missing = whitelist.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown tool in agent definition: ${missing.join(', ')}`);
  }
  const selected = new Set(whitelist);
  return tools.filter((tool) => selected.has(tool.name));
}

function readApprovalDecision(value: unknown): ApprovalDecision {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('decision' in value) ||
    !['accept', 'acceptForSession', 'decline', 'cancel'].includes(
      String(value.decision),
    )
  ) {
    throw new Error('Invalid approval response.');
  }
  return value as ApprovalDecision;
}

function approvalExternalDirs(item: DeferredApprovalItem): readonly string[] {
  const externalDirs = item.metadata?.externalDirs;
  if (externalDirs === undefined) return [];
  if (
    !Array.isArray(externalDirs) ||
    externalDirs.some(
      (entry) => typeof entry !== 'string' || entry.length === 0,
    )
  ) {
    throw new Error('Approval externalDirs metadata must be a string array.');
  }
  return externalDirs as readonly string[];
}

function planResult(decision: ApprovalDecision): string {
  return decision.decision === 'accept' ||
    decision.decision === 'acceptForSession'
    ? 'Plan accepted. Continue by executing the approved plan.'
    : decision.decision === 'decline'
      ? 'Plan declined.'
      : 'Plan approval cancelled.';
}

function toolHeadline(name: string, input: unknown): string {
  const text = preview(input);
  return text === '' ? name : `${name} ${text}`.slice(0, 240);
}

function preview(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 4_000 ? `${text.slice(0, 4_000)}...` : text;
}

function jsonValue(value: unknown): unknown | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function formatUserInput(input: UserInput): string {
  switch (input.type) {
    case 'text':
      return input.text;
    case 'file':
      return `@${input.path}`;
    case 'image':
      return `[image ${input.artifactId} ${input.mediaType}]`;
  }
}

function isFailure(result: AgentRunResult): boolean {
  return ['content-filter', 'error', 'no-progress', 'unknown'].includes(
    result.finishReason,
  );
}

function emptyUsage() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
}

function addUsage(
  left: ReturnType<typeof emptyUsage>,
  right: ReturnType<typeof emptyUsage>,
): ReturnType<typeof emptyUsage> {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown, fallback: string): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.length > 0
      ? value
      : [fallback]
    : [fallback];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) throw new Error('Cannot push to a completed event queue.');
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
