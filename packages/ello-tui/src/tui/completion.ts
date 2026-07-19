import type { AgentSkill } from '../api/protocol-types.js';

import { buildCommands } from './commands/registry.js';
import type { ComposerSuggestion } from './component/Composer.js';
import { detectTrigger, scoreCandidate } from './store/autocomplete.js';

const MAX_SKILL_DESCRIPTION_LENGTH = 44;

export function completeInput(
  input: string,
  models: readonly string[],
  files: readonly string[],
  skills: readonly AgentSkill[] = [],
  cursor: { readonly line: number; readonly column: number } = {
    line: input.split('\n').length - 1,
    column: input.split('\n').at(-1)?.length ?? 0,
  },
  skillFrecency: ReadonlyMap<string, number> = new Map(),
): readonly ComposerSuggestion[] | undefined {
  const line = input.split('\n')[cursor.line] ?? '';
  const trigger = detectTrigger(line.slice(0, cursor.column));
  if (trigger?.kind === 'skill') {
    // replaceFrom/replaceTo 只覆盖当前 token；光标后的同一行内容必须原样保留。
    return skills
      .map((skill) => ({
        skill,
        score:
          Math.max(
            scoreCandidate(trigger.query, skill.name),
            scoreCandidate(
              trigger.query,
              skill.description ?? skill.title ?? '',
            ) - 100,
          ) + (skillFrecency.get(skill.name) ?? 0),
      }))
      .filter((item) => Number.isFinite(item.score))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.skill.name.localeCompare(right.skill.name),
      )
      .map(({ skill }) => ({
        value: `$${skill.name}`,
        label: `$${skill.name}`,
        description: `${skill.metadata.source ?? 'skill'} · ${clipDescription(skill.description ?? skill.title ?? '', MAX_SKILL_DESCRIPTION_LENGTH)}`,
        replaceFrom: trigger.tokenStart,
        replaceTo: tokenEnd(line, cursor.column),
        appendSpace: true,
      }));
  }
  const trimmedLeft = input.trimStart();
  if (trimmedLeft.startsWith('/profiles ')) {
    const query = trimmedLeft.slice('/profiles '.length).toLowerCase();
    return models
      .filter((item) => item.toLowerCase().includes(query))
      .map((item) => `/profiles ${item}`);
  }
  if (trimmedLeft.startsWith('/')) {
    const query = trimmedLeft.slice(1).toLowerCase();
    return buildCommands()
      .filter(
        (command) =>
          query === '' ||
          command.slash.toLowerCase().startsWith(query) ||
          command.keywords.some((keyword) =>
            keyword.toLowerCase().startsWith(query),
          ),
      )
      .map((command) => ({
        value: `/${command.slash}`,
        label: `/${command.slash}`,
        description: command.description,
      }));
  }
  if (files.length > 0) {
    return files;
  }
  return undefined;
}

function clipDescription(description: string, maxLength: number): string {
  const singleLine = description.replace(/\s+/gu, ' ').trim();
  return singleLine.length > maxLength
    ? `${singleLine.slice(0, maxLength - 3)}...`
    : singleLine;
}

function tokenEnd(line: string, cursorColumn: number): number {
  const suffix = line.slice(cursorColumn);
  const whitespace = suffix.search(/\s/u);
  return whitespace === -1 ? line.length : cursorColumn + whitespace;
}
