import type {
  AgentMessage,
  ContextBundle,
  ContextReducer,
  ContextReductionOutput,
} from '@ello/agent';

/** 默认输入 token 预算，给没有 provider context window 信息的本地运行兜底。 */
const DEFAULT_MAX_INPUT_TOKENS = 64_000;

/** 工具结果超过该长度时会折叠成摘要，避免长 stdout 污染后续上下文。 */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 8_000;

/** reducer 构造参数。 */
export interface CodingContextReducerOptions {
  readonly maxInputTokens?: number;
  readonly toolResultMaxChars?: number;
}

/**
 * 创建 coding-agent 使用的 context reducers。
 *
 * reducers 在 product 层组合，因为 token lane、tool result 折叠和 compact
 * 策略都属于 coding 产品体验；`@ello/agent` 只消费标准 ContextReducer。
 */
export function createCodingContextReducers(
  options: CodingContextReducerOptions = {},
): ContextReducer[] {
  return [
    createToolResultReducer(options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS),
    createTokenBudgetReducer(options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS),
  ];
}

/**
 * 折叠过长 tool result。
 *
 * 保留开头、结尾和长度信息，既让模型知道工具输出被截断，也避免后续 turn
 * 反复携带巨量 stdout/stderr 或文件内容。
 */
export function createToolResultReducer(maxChars: number): ContextReducer {
  return {
    name: 'coding.tool-result-reducer',
    reduce(input): ContextReductionOutput {
      let summaryCount = 0;
      const bundles = input.bundles.map((bundle) => {
        if (bundle.kind !== 'message' || !isToolMessage(bundle.message)) {
          return bundle;
        }
        const text = messageText(bundle.message);
        if (text.length <= maxChars) {
          return bundle;
        }
        summaryCount += 1;
        return {
          ...bundle,
          message: {
            ...bundle.message,
            content: summarizeLongText(text, maxChars),
          } as AgentMessage,
        };
      });
      return {
        bundles,
        report: {
          reducer: 'coding.tool-result-reducer',
          beforeBundleCount: input.bundles.length,
          afterBundleCount: bundles.length,
          beforeTokenEstimate: estimateBundles(input.bundles),
          afterTokenEstimate: estimateBundles(bundles),
          summaryCount,
        },
      };
    },
  };
}

/**
 * 按粗略 token 预算裁剪可丢弃/可压缩上下文。
 *
 * 固定上下文优先保留；超过预算时先丢 `droppable` 低优先级 bundle，再丢
 * `compressible` 低优先级 bundle。该 reducer 不替代 summary compact，只负责
 * 每轮模型调用前的最后防线。
 */
export function createTokenBudgetReducer(maxInputTokens: number): ContextReducer {
  return {
    name: 'coding.token-budget-reducer',
    reduce(input): ContextReductionOutput {
      const budget = input.budget.maxInputTokens ?? maxInputTokens;
      const before = estimateBundles(input.bundles);
      if (before <= budget) {
        return {
          bundles: input.bundles,
          report: {
            reducer: 'coding.token-budget-reducer',
            beforeBundleCount: input.bundles.length,
            afterBundleCount: input.bundles.length,
            beforeTokenEstimate: before,
            afterTokenEstimate: before,
            metadata: { budget },
          },
        };
      }

      const kept: ContextBundle[] = [];
      const candidates = [...input.bundles].sort((left, right) => {
        const leftRank = retentionRank(left.retention);
        const rightRank = retentionRank(right.retention);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return right.priority - left.priority;
      });
      let total = 0;
      for (const bundle of candidates) {
        const estimate = estimateBundle(bundle);
        if (bundle.retention !== 'fixed' && total + estimate > budget) {
          continue;
        }
        kept.push(bundle);
        total += estimate;
      }
      const keptIds = new Set(kept.map(bundleKey));
      const ordered = input.bundles.filter((bundle) => keptIds.has(bundleKey(bundle)));
      return {
        bundles: ordered,
        report: {
          reducer: 'coding.token-budget-reducer',
          beforeBundleCount: input.bundles.length,
          afterBundleCount: ordered.length,
          beforeTokenEstimate: before,
          afterTokenEstimate: estimateBundles(ordered),
          metadata: { budget, dropped: input.bundles.length - ordered.length },
        },
      };
    },
  };
}

function retentionRank(retention: ContextBundle['retention']): number {
  if (retention === 'fixed') return 0;
  if (retention === 'compressible') return 1;
  return 2;
}

function isToolMessage(message: AgentMessage): boolean {
  return message.role === 'tool';
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function summarizeLongText(text: string, maxChars: number): string {
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head);
  return [
    `<tool-result truncated="true" originalChars="${text.length}">`,
    text.slice(0, head),
    '\n... truncated middle ...\n',
    text.slice(text.length - tail),
    '</tool-result>',
  ].join('');
}

function estimateBundles(bundles: readonly ContextBundle[]): number {
  return bundles.reduce((sum, bundle) => sum + estimateBundle(bundle), 0);
}

function estimateBundle(bundle: ContextBundle): number {
  if (bundle.kind === 'system' || bundle.kind === 'memory') {
    return estimateText(bundle.text);
  }
  if (bundle.kind === 'message') {
    return estimateText(messageText(bundle.message));
  }
  if (bundle.kind === 'tool-context') {
    return estimateText(`${bundle.activeTools?.join(',') ?? ''}\n${bundle.toolInstructions ?? ''}`);
  }
  return estimateText(JSON.stringify(bundle.data));
}

function estimateText(text: string): number {
  return Math.ceil(text.length / 4);
}

function bundleKey(bundle: ContextBundle): string {
  return bundle.id ?? `${bundle.source}:${bundle.kind}:${bundle.priority}:${JSON.stringify(bundle)}`;
}
