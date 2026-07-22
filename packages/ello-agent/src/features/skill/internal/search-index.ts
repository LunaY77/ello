/**
 * 本文件负责 skill feature 的“search-index”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { WeightedSearchIndex } from '../../../infra/weighted-search-index.js';
import type { AgentSkill } from '../../agent/engine/index.js';

export interface SkillSearchResult {
  readonly skill: AgentSkill;
  readonly matchedBy: readonly string[];
  readonly score: number;
}

export class SkillSearchIndex {
  private readonly index: WeightedSearchIndex<AgentSkill>;

  /**
   * 创建 `SkillSearchIndex`，由该实例独占 Skill `search-index` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `skills`: `constructor SkillSearchIndex` 所需的业务值；函数按声明读取，不补造缺失内容。
   */
  constructor(skills: readonly AgentSkill[]) {
    this.index = new WeightedSearchIndex(
      skills,
      (skill) => [
        { name: 'name', weight: 8, text: skill.name },
        { name: 'description', weight: 3, text: skill.description },
        { name: 'source', weight: 1, text: skill.source },
      ],
      (skill) => skill.name,
    );
  }

  /**
   * 在 Skill `search-index` 模块 中执行 `search` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `query`: `search` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `limit`: 当前操作使用的数量上限；超出限制时直接失败或按契约截断。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  search(query: string, limit: number): SkillSearchResult[] {
    return this.index.search(query, limit).map((result) => ({
      skill: result.value,
      matchedBy: result.matchedBy,
      score: result.score,
    }));
  }
}
