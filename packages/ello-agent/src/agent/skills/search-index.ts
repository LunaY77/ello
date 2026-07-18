import type { AgentSkill } from '../engine/index.js';
import { WeightedSearchIndex } from '../tools/weighted-search-index.js';

export interface SkillSearchResult {
  readonly skill: AgentSkill;
  readonly matchedBy: readonly string[];
  readonly score: number;
}

export class SkillSearchIndex {
  private readonly index: WeightedSearchIndex<AgentSkill>;

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

  search(query: string, limit: number): SkillSearchResult[] {
    return this.index.search(query, limit).map((result) => ({
      skill: result.value,
      matchedBy: result.matchedBy,
      score: result.score,
    }));
  }
}
