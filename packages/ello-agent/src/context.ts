import { randomUUID } from 'node:crypto';

import { ModelConfig, ToolConfig } from './config.js';
import type { Environment } from './environment/index.js';
import type { AgentEvent } from './events.js';
import { UsageSnapshot, type UsageSnapshotEntry } from './usage.js';

/**
 * 生成 12 位十六进制的唯一运行 ID。
 */
export function generateRunId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

/**
 * AgentContext 构造参数。
 */
export interface AgentContextOptions {
  env: Environment;
  modelConfig?: ModelConfig;
  toolConfig?: ToolConfig;
  injectedContextTags?: string[];
  userPrompts?: string[];
  steeringMessages?: string[];
  runId?: string;
  startAt?: Date;
  endAt?: Date | null;
  compactDepth?: number;
  forceInjectInstructions?: boolean;
  subagentHistory?: Map<string, unknown[]>;
}

/**
 * Agent 运行态内核。
 *
 * 持有 Environment 引用, 管理 per-run 状态(runId, 计时, usage, 事件)。
 * 每次 agent 调用前通过 prepareNewRun() 创建隔离的运行态副本。
 */
export class AgentContext {
  readonly env: Environment;
  readonly modelConfig: ModelConfig;
  readonly toolConfig: ToolConfig;
  readonly injectedContextTags: string[];
  readonly userPrompts: string[];
  readonly steeringMessages: string[];
  readonly runId: string;
  readonly startAt: Date;
  readonly compactDepth: number;
  readonly subagentHistory: Map<string, unknown[]>;
  endAt: Date | null;
  forceInjectInstructions: boolean;
  private readonly eventItems: AgentEvent[] = [];
  private usageSnapshotValue: UsageSnapshot | null = null;

  constructor(options: AgentContextOptions) {
    this.env = options.env;
    this.modelConfig = options.modelConfig ?? new ModelConfig();
    this.toolConfig = options.toolConfig ?? new ToolConfig();
    this.injectedContextTags = options.injectedContextTags ?? [
      'runtime-context',
    ];
    this.userPrompts = options.userPrompts ?? [];
    this.steeringMessages = options.steeringMessages ?? [];
    this.runId = options.runId ?? generateRunId();
    this.startAt = options.startAt ?? new Date();
    this.endAt = options.endAt ?? null;
    this.compactDepth = options.compactDepth ?? 0;
    this.forceInjectInstructions = options.forceInjectInstructions ?? false;
    this.subagentHistory = options.subagentHistory ?? new Map();
  }

  /** 返回当前运行的已用毫秒数。 */
  get elapsedMilliseconds(): number {
    const end = this.endAt ?? new Date();
    return Math.max(0, end.getTime() - this.startAt.getTime());
  }

  /**
   * 创建新的 per-run 上下文副本, 共享 env/modelConfig/toolConfig 但重置运行态。
   */
  prepareNewRun(): AgentContext {
    return new AgentContext({
      env: this.env,
      modelConfig: this.modelConfig,
      toolConfig: this.toolConfig,
      injectedContextTags: this.injectedContextTags,
      userPrompts: this.userPrompts,
      steeringMessages: this.steeringMessages,
      compactDepth: this.compactDepth,
      subagentHistory: this.subagentHistory,
    });
  }

  /**
   * 记录事件到当前运行。
   */
  emitEvent(event: AgentEvent): void {
    this.eventItems.push(event);
  }

  /** 返回当前运行已记录的事件副本。 */
  get events(): AgentEvent[] {
    return [...this.eventItems];
  }

  /** 返回当前运行的 usage 快照, 按需创建。 */
  get usageSnapshot(): UsageSnapshot {
    this.usageSnapshotValue ??= new UsageSnapshot(this.runId);
    return this.usageSnapshotValue;
  }

  /**
   * 记录一条 usage entry。
   */
  recordUsage(entry: UsageSnapshotEntry): void {
    this.usageSnapshot.record(entry);
  }

  /**
   * 生成 <runtime-context> XML, 供注入到每次 model request。
   */
  getContextInstructions(): string {
    const parts = [
      '<runtime-context>',
      `  <run-id>${escapeXml(this.runId)}</run-id>`,
      `  <current-time>${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</current-time>`,
      `  <elapsed-time>${(this.elapsedMilliseconds / 1000).toFixed(1)}s</elapsed-time>`,
    ];

    if (this.modelConfig.contextWindow !== null) {
      parts.push('  <model-config>');
      parts.push(
        `    <context-window>${this.modelConfig.contextWindow}</context-window>`,
      );
      parts.push('  </model-config>');
    }

    parts.push('</runtime-context>');
    return parts.join('\n');
  }
}

/**
 * 转义 XML 文本节点。
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
