/**
 * 环境 feature 组合策略文件系统、本地 shell 和资源 registry。
 *
 * 该工厂不读取业务状态，所有动态授权通过路径视图函数在 I/O 时取得。
 */
import type { AgentEnvironment } from '../agent/engine/contracts.js';

import type { CreateEnvironmentOptions } from './contracts.js';
import { createPolicyFileSystem } from './filesystem.js';
import { DefaultAgentResourceRegistry } from './resources.js';
import { createPolicyShell } from './shell.js';

/**
 * 组合一个拥有文件系统、shell 和资源生命周期的 Agent 环境。
 *
 * Args:
 * - `options`: 工作目录、动态路径视图和本地 shell 组合选项。
 *
 * Returns:
 * - 返回与单个 Agent run 生命周期一致的环境实例。
 */
export function createEnvironment(
  options: CreateEnvironmentOptions,
): AgentEnvironment {
  if (options.shell !== undefined && options.shellExecutable !== undefined) {
    throw new Error(
      'Environment accepts either a shell instance or a shell executable.',
    );
  }
  const fileSystem = createPolicyFileSystem(
    options.cwd,
    options.paths.read,
    options.paths.write,
  );
  const shell =
    options.shell ??
    createPolicyShell(
      options.cwd,
      options.paths.write,
      options.shellExecutable,
    );
  const resources = new DefaultAgentResourceRegistry();
  const environment: AgentEnvironment = {
    fileSystem,
    shell,
    resources,
    async setup() {
      resources.bind(environment);
      await resources.setupAll();
    },
    getInstructions: options.includeInstructions
      ? async () => {
          const sections = [
            await fileSystem.getContextInstructions?.(),
            await shell.getContextInstructions?.(),
            await resources.getContextInstructions?.(),
          ].filter(
            (section): section is string =>
              typeof section === 'string' && section.length > 0,
          );
          return sections.length === 0
            ? null
            : `<environment-context>\n${sections.join('\n\n')}\n</environment-context>`;
        }
      : () => null,
    close: () => resources.closeAll(),
  };
  resources.bind(environment);
  return environment;
}
