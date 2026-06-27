import type {
  AgentMessage,
  AgentObserver,
  AgentToolSet,
  ContextBundle,
  ContextDiagnostics,
  ContextReducer,
  ContextReductionReport,
  ContextSource,
  MaybePromise,
  ModelCallPlan,
  ModelCallPlanner,
  AgentRunContext,
} from '../public/types.js';

export interface DefaultModelCallPlannerOptions<TContext = unknown> {
  readonly instructions?: string;
  readonly contextSources: readonly ContextSource<TContext>[];
  readonly reducers: readonly ContextReducer<TContext>[];
  readonly tools?: AgentToolSet;
  readonly observers?: readonly AgentObserver<TContext>[];
}

export class DefaultModelCallPlanner<TContext = unknown>
  implements ModelCallPlanner<TContext>
{
  constructor(private readonly options: DefaultModelCallPlannerOptions<TContext>) {}

  async plan(ctx: AgentRunContext<TContext>): Promise<ModelCallPlan> {
    const bundles: ContextBundle[] = [];
    if (this.options.instructions !== undefined) {
      bundles.push({
        kind: 'system',
        source: 'agent.instructions',
        priority: 1000,
        scope: 'run',
        retention: 'fixed',
        persist: 'never',
        text: this.options.instructions,
      });
    }

    for (const source of this.options.contextSources) {
      const loaded = await source.load(ctx);
      bundles.push(...loaded);
    }
    await notifyAll(this.options.observers, (observer) =>
      observer.onContextLoaded?.({ bundles }, ctx),
    );

    let current = bundles;
    const reports: ContextReductionReport[] = [];
    for (const reducer of this.options.reducers) {
      const before = current;
      const output = await reducer.reduce({
        bundles: current,
        ctx,
        budget: ctx.state.budget,
      });
      current = output.bundles;
      reports.push(output.report);
      await notifyAll(this.options.observers, (observer) =>
        observer.onContextReduced?.(
          { before, after: current, report: output.report },
          ctx,
        ),
      );
    }

    const plan = compileModelCallPlan({
      bundles: current,
      reports,
      ...(this.options.tools !== undefined ? { tools: this.options.tools } : {}),
    });
    await notifyAll(this.options.observers, (observer) =>
      observer.onModelCallPlanned?.(plan, ctx),
    );
    return plan;
  }
}

export function compileModelCallPlan(options: {
  readonly bundles: readonly ContextBundle[];
  readonly tools?: AgentToolSet;
  readonly reports?: readonly ContextReductionReport[];
}): ModelCallPlan {
  const ordered = [...options.bundles].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.source.localeCompare(right.source);
  });

  const systemParts: string[] = [];
  const messages: AgentMessage[] = [];
  const activeTools = new Set<string>();
  const providerOptions: Record<string, unknown> = {};

  for (const bundle of ordered) {
    if (bundle.kind === 'system') {
      systemParts.push(bundle.text);
    } else if (bundle.kind === 'message') {
      messages.push(bundle.message);
    } else if (bundle.kind === 'memory') {
      messages.push({
        role: 'user',
        content: `<memory type="${bundle.memoryType}">\n${bundle.text}\n</memory>`,
      });
    } else if (bundle.kind === 'tool-context') {
      for (const name of bundle.activeTools ?? []) {
        activeTools.add(name);
      }
      if (bundle.toolInstructions !== undefined) {
        systemParts.push(bundle.toolInstructions);
      }
    } else {
      providerOptions[bundle.source] = bundle.data;
    }
  }

  const beforeMessageCount = options.bundles.filter(
    (bundle) => bundle.kind === 'message',
  ).length;
  const diagnostics: ContextDiagnostics = {
    bundles: ordered.map((bundle) => ({
      source: bundle.source,
      kind: bundle.kind,
      priority: bundle.priority,
      scope: bundle.scope,
      retention: bundle.retention,
      persist: bundle.persist,
      tokenEstimate: estimateBundleTokens(bundle),
    })),
    reducerReports: [...(options.reports ?? [])],
    summaryCount: (options.reports ?? []).reduce(
      (sum, report) => sum + (report.summaryCount ?? 0),
      0,
    ),
    beforeMessageCount,
    afterMessageCount: messages.length,
    beforeTokenEstimate: estimateBundlesTokens(options.bundles),
    afterTokenEstimate: estimateMessagesTokens(messages) + estimateTextTokens(systemParts.join('\n\n')),
  };

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages,
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(activeTools.size > 0 ? { activeTools: [...activeTools] } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    diagnostics,
  };
}

export function createStateContextSource(): ContextSource {
  return {
    name: 'agent.state',
    load(ctx) {
      return ctx.state.messages.map((message, index) => ({
        kind: 'message',
        source: index === 0 ? 'agent.state.first' : 'agent.state',
        priority: 500,
        scope: 'run',
        retention: 'compressible',
        persist: 'session',
        message,
      }));
    },
  };
}

export function createEnvironmentContextSource(): ContextSource {
  return {
    name: 'agent.environment',
    async load(ctx) {
      const instructions = await ctx.environment.getInstructions?.();
      if (!instructions) {
        return [];
      }
      return [
        {
          kind: 'system',
          source: 'agent.environment',
          priority: 900,
          scope: 'run',
          retention: 'fixed',
          persist: 'never',
          text: instructions,
        },
      ];
    },
  };
}

export function estimateBundlesTokens(bundles: readonly ContextBundle[]): number {
  return bundles.reduce((sum, bundle) => sum + estimateBundleTokens(bundle), 0);
}

export function estimateBundleTokens(bundle: ContextBundle): number {
  if (bundle.kind === 'system' || bundle.kind === 'memory') {
    return estimateTextTokens(bundle.text);
  }
  if (bundle.kind === 'message') {
    return estimateTextTokens(messageText(bundle.message));
  }
  if (bundle.kind === 'tool-context') {
    return estimateTextTokens(
      `${bundle.activeTools?.join(',') ?? ''}\n${bundle.toolInstructions ?? ''}`,
    );
  }
  return estimateTextTokens(JSON.stringify(bundle.data));
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTextTokens(messageText(message)), 0);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content ?? '');
}

async function notifyAll<TContext>(
  observers: readonly AgentObserver<TContext>[] | undefined,
  notify: (observer: AgentObserver<TContext>) => MaybePromise<void>,
): Promise<void> {
  for (const observer of observers ?? []) {
    await notify(observer);
  }
}
