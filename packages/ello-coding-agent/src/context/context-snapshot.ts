import { createHash } from 'node:crypto';

import type { CodingAgentConfig } from '../config/index.js';
import type { MemoryIndexLoader } from '../memory/index-loader.js';

import { loadInstructionSources } from './instructions.js';
import {
  estimateTextTokens,
  loadContextBundle,
  renderContextSources,
  type ContextBundle,
  type ContextEvent,
  type ContextSource,
  type ContextSourceLoadResult,
} from './source-registry.js';

export interface ContextSnapshotDeps {
  readonly activeSkills?: () => Promise<readonly string[]> | readonly string[];
  readonly onContextEvent?: (event: ContextEvent) => void;
  readonly memoryIndexLoader?: MemoryIndexLoader;
}

export interface ContextSnapshotView extends ContextBundle {
  readonly fingerprint: string;
  readonly stableSystem: string;
  readonly dynamicSystem: string;
}

/**
 * 单个 user run 的上下文快照。环境与 instruction 只加载一次，技能段按回合刷新。
 */
export class ContextSnapshot {
  private stableBundle: Promise<ContextBundle> | undefined;
  private activeSkillFingerprint: string | undefined;

  constructor(
    private readonly config: CodingAgentConfig,
    private readonly deps: ContextSnapshotDeps,
    private readonly promptProfile: string,
    private readonly basePromptHash: string,
    private readonly includeMemory = false,
  ) {}

  async render(): Promise<ContextSnapshotView> {
    const stable = await this.loadStableBundle();
    const active = await loadActiveSkillsSource(this.deps);
    const sources = [...stable.sources, ...active.sources].sort(compareSource);
    const stableSystem = renderContextSources(stable.sources);
    const dynamicSystem = renderContextSources(active.sources);
    const diagnostics = [...stable.diagnostics, ...(active.diagnostics ?? [])];
    this.emitActiveSkillChange(active.sources);
    return {
      sources,
      system: [stableSystem, dynamicSystem].filter(Boolean).join('\n\n'),
      diagnostics,
      stableSystem,
      dynamicSystem,
      fingerprint: snapshotFingerprint({
        promptProfile: this.promptProfile,
        basePromptHash: this.basePromptHash,
        sources,
      }),
    };
  }

  private loadStableBundle(): Promise<ContextBundle> {
    if (this.stableBundle === undefined) {
      const loaders = [
        () => loadEnvironmentSource(this.config),
        () => loadInstructionSources(this.config),
      ];
      if (this.includeMemory) {
        const memory = this.deps.memoryIndexLoader;
        if (memory === undefined) {
          throw new Error('Memory is enabled without a MemoryIndexLoader.');
        }
        loaders.push(() => memory.load());
      }
      this.stableBundle = loadContextBundle(loaders, this.deps.onContextEvent);
    }
    return this.stableBundle;
  }

  private emitActiveSkillChange(sources: readonly ContextSource[]): void {
    const fingerprint = snapshotFingerprint({ sources });
    if (fingerprint === this.activeSkillFingerprint) {
      return;
    }
    this.activeSkillFingerprint = fingerprint;
    for (const source of sources) {
      this.deps.onContextEvent?.({ type: 'context.source.loaded', source });
    }
  }
}

async function loadEnvironmentSource(
  config: CodingAgentConfig,
): Promise<ContextSourceLoadResult> {
  const allowed =
    config.allowedPaths.length > 0
      ? [...config.allowedPaths].sort().join('\n')
      : config.cwd;
  const content = [
    '<file-system>',
    `  <working-directory>${config.cwd}</working-directory>`,
    `  <allowed-paths>\n${indent(allowed)}\n  </allowed-paths>`,
    '</file-system>',
    '<shell>',
    `  <working-directory>${config.cwd}</working-directory>`,
    `  <allowed-paths>\n${indent(allowed)}\n  </allowed-paths>`,
    '</shell>',
    '<approval>',
    // runtime 构建时 config.initialMode 已被替换为当前 session mode，而非启动快照。
    `  <mode>${config.initialMode}</mode>`,
    `  <guidance>${modeGuidance(config.initialMode)}</guidance>`,
    '</approval>',
    'Stay within the allowed paths unless the user explicitly broadens the scope.',
  ].join('\n');
  return {
    sources: [
      {
        id: 'environment:runtime',
        type: 'environment',
        title: 'Runtime environment',
        priority: 60,
        content,
        origin: config.cwd,
        tokensEstimate: estimateTextTokens(content),
      },
    ],
  };
}

async function loadActiveSkillsSource(
  deps: ContextSnapshotDeps,
): Promise<ContextSourceLoadResult> {
  const skills =
    deps.activeSkills === undefined ? [] : [...(await deps.activeSkills())];
  const content = skills.map((skill) => `- ${skill}`).join('\n');
  return {
    sources:
      content.length === 0
        ? []
        : [
            {
              id: 'skills:active',
              type: 'skill',
              title: 'Active skills',
              priority: 300,
              content,
              tokensEstimate: estimateTextTokens(content),
            },
          ],
  };
}

function compareSource(left: ContextSource, right: ContextSource): number {
  return left.priority === right.priority
    ? left.id.localeCompare(right.id)
    : left.priority - right.priority;
}

function modeGuidance(mode: CodingAgentConfig['initialMode']): string {
  // 提示词只解释行为边界；真正的安全约束仍由 permission policy 强制执行。
  const guidance: Record<CodingAgentConfig['initialMode'], string> = {
    default:
      'File edits and command execution require explicit user approval each time. Inspect available context first; use request_user_input only for user-owned ambiguity that materially changes the implementation.',
    plan: 'Investigate first. If a key architecture, scope, or preference choice can only be answered by the user, call request_user_input with a recommended option. Only write the session plan with write_plan, then call request_plan_exit; never use request_user_input to approve Plan Mode exit. Business files, shell commands, and network access are denied.',
    'accept-edits':
      'File edits are auto-approved; higher-risk actions still need approval. Inspect available context first; use request_user_input only for user-owned ambiguity that materially changes the implementation.',
    bypass:
      'All approvals are bypassed; act carefully because changes apply without a prompt. Inspect available context first; use request_user_input only for user-owned ambiguity that materially changes the implementation.',
  };
  return guidance[mode];
}

function indent(value: string): string {
  return value
    .split('\n')
    .map((line) => `    <path>${line}</path>`)
    .join('\n');
}

function snapshotFingerprint(value: {
  readonly promptProfile?: string;
  readonly basePromptHash?: string;
  readonly sources: readonly ContextSource[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...(value.promptProfile !== undefined
          ? { promptProfile: value.promptProfile }
          : {}),
        ...(value.basePromptHash !== undefined
          ? { basePromptHash: value.basePromptHash }
          : {}),
        sources: value.sources.map((source) => ({
          id: source.id,
          type: source.type,
          priority: source.priority,
          origin: source.origin,
          stale: source.stale === true,
          contentHash: createHash('sha256')
            .update(source.content)
            .digest('hex'),
        })),
      }),
    )
    .digest('hex');
}
