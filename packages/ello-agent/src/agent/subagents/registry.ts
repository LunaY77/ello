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
  get(name: string): CodingAgentDefinition;
  list(filter?: {
    readonly mode?: CodingAgentMode;
  }): readonly CodingAgentDefinition[];
  /** primary/all 且非 hidden，供 `/agent` 选择。 */
  selectablePrimaries(): readonly CodingAgentDefinition[];
  /** subagent/all 且非 hidden，供 delegate 提示与校验。 */
  delegatable(): readonly CodingAgentDefinition[];
}

/** 由配置装配 registry：读包内/用户 Markdown、builtin 与 config.agent 映射并合并。 */
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
