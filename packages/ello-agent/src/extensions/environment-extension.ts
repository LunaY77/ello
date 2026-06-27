import type { AgentEnvironment, AgentExtension } from '../public/types.js';

/**
 * 将环境作为扩展挂载。
 *
 * Args:
 *   environment: 已创建的 AgentEnvironment。
 *
 * Returns:
 *   只负责 teardown 时 close environment 的 AgentExtension。
 */
export function createEnvironmentExtension(
  environment: AgentEnvironment,
): AgentExtension {
  return {
    name: 'environment',
    teardown: () => environment.close?.(),
  };
}
