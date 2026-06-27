import type { AgentStreamEvent } from '../public/events.js';
import type { AgentExtension } from '../public/types.js';

export interface CreateObservabilityExtensionOptions {
  readonly onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

/**
 * 默认 observability 扩展。
 *
 * Args:
 *   options.onEvent: 每个 AgentStreamEvent 触发时调用的 sink。
 *
 * Returns:
 *   AgentExtension，可接日志、指标或 OpenTelemetry 上报。
 *
 * @example
 * ```ts
 * const obs = createObservabilityExtension({
 *   onEvent: (event) => console.log(event.type),
 * });
 * ```
 */
export function createObservabilityExtension(
  options: CreateObservabilityExtensionOptions = {},
): AgentExtension {
  return {
    name: 'observability',
    ...(options.onEvent !== undefined
      ? { onEvent: (event: AgentStreamEvent) => options.onEvent?.(event) }
      : {}),
  };
}
