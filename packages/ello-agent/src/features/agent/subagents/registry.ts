/**
 * 本文件负责 agent feature 的“registry”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { CodingAgentConfig } from '../../config/index.js';

import { builtinAgents } from './builtin.js';
import { loadMarkdownAgents } from './markdown-loader.js';
import {
  agentDefinitionFromConfigEntry,
  type CodingAgentDefinition,
  type CodingAgentMode,
} from './schema.js';

/**
 * agent registry：按 name 索引合并后的 agent 定义，并按 mode 过滤。
 *
 * 合并优先级 bundled-md < builtin < config < global-md < project-md，同名高优先级覆盖低优先级
 * （dedupe 保留最后一个）。未知 name 直接抛错，不静默兜底。
 */
export interface AgentRegistry {
  /**
   * 读取 产品 Agent `registry` 模块 的 `get` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `name`: `get` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `get` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  get(name: string): CodingAgentDefinition;
  /**
   * 读取 产品 Agent `registry` 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `filter`: `list` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(filter?: {
    readonly mode?: CodingAgentMode;
  }): readonly CodingAgentDefinition[];
  /**
   * primary/all 且非 hidden，供 `/agent` 选择。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  selectablePrimaries(): readonly CodingAgentDefinition[];
  /**
   * subagent/all 且非 hidden，供 delegate 提示与校验。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  delegatable(): readonly CodingAgentDefinition[];
}

/**
 * 由配置装配 registry：读包内/用户 Markdown、builtin 与 config.agent 映射并合并。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 *
 * Returns:
 * - Promise 在 产品 Agent `registry` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 产品 Agent `registry` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function createAgentRegistry(
  config: CodingAgentConfig,
): Promise<AgentRegistry> {
  const configAgents = Object.entries(config.agent).map(([name, entry]) =>
    agentDefinitionFromConfigEntry(name, entry, 'config'),
  );
  const markdownAgents = await loadMarkdownAgents(config.cwd);
  const bundledAgents = markdownAgents.filter(
    (def) => def.source === 'bundled',
  );
  const userMarkdownAgents = markdownAgents.filter(
    (def) => def.source !== 'bundled',
  );
  const merged = dedupeByName([
    ...bundledAgents,
    ...builtinAgents(),
    ...configAgents,
    ...userMarkdownAgents,
  ]);
  const byName = new Map(merged.map((def) => [def.name, def]));

  return {
    get(name) {
      const def = byName.get(name);
      if (def === undefined) {
        throw new Error(`Unknown agent: ${name}`);
      }
      return def;
    },
    list(filter) {
      return filter?.mode === undefined
        ? merged
        : merged.filter((def) => def.mode === filter.mode);
    },
    selectablePrimaries() {
      return merged.filter(
        (def) =>
          (def.mode === 'primary' || def.mode === 'all') && def.hidden !== true,
      );
    },
    delegatable() {
      return merged.filter(
        (def) =>
          (def.mode === 'subagent' || def.mode === 'all') &&
          def.hidden !== true,
      );
    },
  };
}

/** 同名保留最后一个，实现 registry 合并顺序中的覆盖语义。 */
function dedupeByName(
  definitions: readonly CodingAgentDefinition[],
): CodingAgentDefinition[] {
  const byName = new Map<string, CodingAgentDefinition>();
  for (const def of definitions) {
    byName.set(def.name, def);
  }
  return [...byName.values()];
}
