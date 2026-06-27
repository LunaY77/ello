import type {
  AgentMessage,
  AgentModel,
  ContextBundle,
  ContextReducer,
} from '../public/types.js';

import {
  compileModelCallPlan,
  estimateBundleTokens,
  estimateBundlesTokens,
} from './planner.js';

export interface TrimHistoryReducerOptions {
  readonly maxMessages: number;
}

export function trimHistoryReducer(
  options: TrimHistoryReducerOptions,
): ContextReducer {
  return {
    name: 'trim-history',
    reduce(input) {
      const messageBundles = input.bundles.filter(
        (bundle): bundle is Extract<ContextBundle, { kind: 'message' }> =>
          bundle.kind === 'message',
      );
      if (messageBundles.length <= options.maxMessages) {
        return {
          bundles: input.bundles,
          report: baseReport('trim-history', input.bundles, input.bundles),
        };
      }

      const keep = new Set(
        messageBundles.slice(-options.maxMessages).map((bundle) => bundle),
      );
      const bundles = input.bundles.filter(
        (bundle) => bundle.kind !== 'message' || keep.has(bundle),
      );
      return {
        bundles,
        report: {
          ...baseReport('trim-history', input.bundles, bundles),
          metadata: { droppedMessages: messageBundles.length - options.maxMessages },
        },
      };
    },
  };
}

export interface TokenBudgetReducerOptions {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens?: number;
}

export function tokenBudgetReducer(
  options: TokenBudgetReducerOptions,
): ContextReducer {
  return {
    name: 'token-budget',
    reduce(input) {
      const available = Math.max(
        0,
        options.maxInputTokens - (options.reservedOutputTokens ?? 0),
      );
      const bundles = [...input.bundles];
      while (estimateBundlesTokens(bundles) > available) {
        const dropIndex = findDropCandidate(bundles);
        if (dropIndex === -1) {
          break;
        }
        bundles.splice(dropIndex, 1);
      }
      return {
        bundles,
        report: baseReport('token-budget', input.bundles, bundles),
      };
    },
  };
}

export interface SummarizeHistoryReducerOptions {
  readonly model: AgentModel;
  readonly triggerTokens: number;
  readonly keepMessages: number;
  readonly summaryPrompt?: string;
}

export function summarizeHistoryReducer(
  options: SummarizeHistoryReducerOptions,
): ContextReducer {
  return {
    name: 'summarize-history',
    reduce(input) {
      void options.model;
      const beforeTokens = estimateBundlesTokens(input.bundles);
      if (beforeTokens < options.triggerTokens) {
        return {
          bundles: input.bundles,
          report: baseReport('summarize-history', input.bundles, input.bundles),
        };
      }

      const messageBundles = input.bundles.filter(
        (bundle): bundle is Extract<ContextBundle, { kind: 'message' }> =>
          bundle.kind === 'message',
      );
      const oldMessages = messageBundles.slice(0, -options.keepMessages);
      if (oldMessages.length === 0) {
        return {
          bundles: input.bundles,
          report: baseReport('summarize-history', input.bundles, input.bundles),
        };
      }

      const summary = createExtractiveSummary(
        oldMessages.map((bundle) => bundle.message),
        options.summaryPrompt,
      );
      const remove = new Set<ContextBundle>(oldMessages);
      const firstRemovedIndex = input.bundles.findIndex((bundle) => remove.has(bundle));
      const bundles = input.bundles.filter((bundle) => !remove.has(bundle));
      bundles.splice(Math.max(0, firstRemovedIndex), 0, {
        kind: 'memory',
        source: 'summarize-history',
        priority: 450,
        scope: 'session',
        retention: 'compressible',
        persist: 'session',
        text: summary,
        memoryType: 'working',
      });

      return {
        bundles,
        report: {
          ...baseReport('summarize-history', input.bundles, bundles),
          summaryCount: 1,
          metadata: { summarizedMessages: oldMessages.length },
        },
      };
    },
  };
}

export interface SummarySessionCompactorOptions {
  readonly maxMessages: number;
  readonly keepMessages: number;
}

export function createSummarySessionCompactor(
  options: SummarySessionCompactorOptions,
) {
  return {
    name: 'summary-session-compactor',
    async maybeCompact(sessionId, store, ctx) {
      const messages = await store.load(sessionId);
      if (messages.length <= options.maxMessages || store.replace === undefined) {
        return null;
      }
      const summarized = messages.slice(0, -options.keepMessages);
      const kept = messages.slice(-options.keepMessages);
      const summary: AgentMessage = {
        role: 'user',
        content: `<session-summary>\n${createExtractiveSummary(summarized)}\n</session-summary>`,
      };
      const next = [summary, ...kept];
      await store.replace(sessionId, next, { compactor: 'summary-session-compactor' });
      void ctx;
      return {
        compactor: 'summary-session-compactor',
        beforeMessageCount: messages.length,
        afterMessageCount: next.length,
      };
    },
  } satisfies import('../public/types.js').SessionCompactor;
}

function findDropCandidate(bundles: readonly ContextBundle[]): number {
  const droppable = bundles
    .map((bundle, index) => ({ bundle, index }))
    .filter(({ bundle }) => bundle.retention === 'droppable');
  if (droppable.length > 0) {
    return droppable.sort((left, right) => left.bundle.priority - right.bundle.priority)[0]
      ?.index ?? -1;
  }
  const compressible = bundles
    .map((bundle, index) => ({ bundle, index }))
    .filter(({ bundle }) => bundle.retention === 'compressible');
  return (
    compressible.sort((left, right) => left.bundle.priority - right.bundle.priority)[0]
      ?.index ?? -1
  );
}

function createExtractiveSummary(
  messages: readonly AgentMessage[],
  prompt = 'Summarize previous session messages.',
): string {
  const plan = compileModelCallPlan({
    bundles: messages.map((message, index) => ({
      kind: 'message',
      source: 'summary.input',
      priority: index,
      scope: 'session',
      retention: 'compressible',
      persist: 'session',
      message,
    })),
  });
  const text = plan.messages
    .map((message) => `${message.role}: ${stringifyContent((message as { content?: unknown }).content)}`)
    .join('\n');
  return `${prompt}\n\n${text}`.slice(0, 4000);
}

function stringifyContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function baseReport(
  reducer: string,
  before: readonly ContextBundle[],
  after: readonly ContextBundle[],
) {
  return {
    reducer,
    beforeBundleCount: before.length,
    afterBundleCount: after.length,
    beforeTokenEstimate: estimateBundlesTokens(before),
    afterTokenEstimate: estimateBundlesTokens(after),
  };
}

export { estimateBundleTokens, estimateBundlesTokens };
