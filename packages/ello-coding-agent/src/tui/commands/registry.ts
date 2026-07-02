/**
 * 统一命令注册表。
 *
 * 验收要求「`/` commands 和快捷键来自统一 command registry」。为避免和 CLI 共享的
 * {@link slashCommands} 形成两套平行定义，这里不重新声明命令，而是 **在 slashCommands
 * 之上叠加 UI 元数据**（分组、关键词、快捷键、稳定 id）。command palette 与 inline `/`
 * 补全都消费本注册表，执行时仍回到 `handleSlashCommand` 派发，单一事实源。
 */
import { slashCommands } from '../../slash-commands.js';
import { scoreCandidate } from '../store/autocomplete.js';

export interface TuiCommand {
  /** 稳定点分 id（如 `session.fork`），与文档 command palette 列表对齐。 */
  readonly id: string;
  /** palette 中展示的标题。 */
  readonly title: string;
  /** 分组名，用于 palette 分节。 */
  readonly group: string;
  /** 模糊搜索关键词（除 id/title 外的同义词）。 */
  readonly keywords: readonly string[];
  /** 可选快捷键展示串（如 `ctrl+t`）。 */
  readonly shortcut?: string;
  /** 派发用的 slash 名（去掉前导 `/`）。 */
  readonly slash: string;
  /** 命令描述（取自 slashCommands）。 */
  readonly description: string;
}

interface CommandMeta {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
}

/** slash 名 → UI 元数据。新增 slash 命令时在此补一行即可进入 palette。 */
const META: Record<string, CommandMeta> = {
  help: { id: 'help.open', group: 'General', title: 'Help', keywords: ['?'] },
  clear: {
    id: 'session.clear',
    group: 'Session',
    title: 'Clear context',
    keywords: ['reset'],
  },
  models: {
    id: 'model.switch',
    group: 'Model',
    title: 'Switch model',
    keywords: ['catalog'],
  },
  profiles: {
    id: 'model.profile',
    group: 'Model',
    title: 'Switch profile',
    keywords: ['suite'],
  },
  settings: {
    id: 'config.open',
    group: 'General',
    title: 'Settings',
    keywords: ['config', 'preferences'],
  },
  resume: {
    id: 'session.list',
    group: 'Session',
    title: 'Resume session',
    keywords: ['open'],
  },
  tasks: {
    id: 'task.list',
    group: 'Tasks',
    title: 'Tasks',
    keywords: ['todo'],
  },
  skills: { id: 'skill.list', group: 'Skills', title: 'Skills', keywords: [] },
  skill: {
    id: 'skill.invoke',
    group: 'Skills',
    title: 'Invoke skill',
    keywords: ['run'],
  },
  'skill-search': {
    id: 'skill.search',
    group: 'Skills',
    title: 'Search skills',
    keywords: [],
  },
  'skill-create': {
    id: 'skill.create',
    group: 'Skills',
    title: 'Create skill',
    keywords: ['new'],
  },
  workspace: {
    id: 'workspace.list',
    group: 'Workspace',
    title: 'Workspace',
    keywords: [],
  },
  new: {
    id: 'session.new',
    group: 'Session',
    title: 'New session',
    keywords: [],
  },
  session: {
    id: 'session.current',
    group: 'Session',
    title: 'Current session',
    keywords: [],
  },
  tree: {
    id: 'session.tree',
    group: 'Session',
    title: 'Session tree',
    keywords: ['branch'],
  },
  fork: {
    id: 'session.fork',
    group: 'Session',
    title: 'Fork session',
    keywords: ['branch'],
  },
  compact: {
    id: 'session.compact',
    group: 'Session',
    title: 'Compact session',
    keywords: ['summarize'],
  },
  tools: {
    id: 'tools.list',
    group: 'General',
    title: 'List tools',
    keywords: [],
  },
  permissions: {
    id: 'config.permissions',
    group: 'General',
    title: 'Permission rules',
    keywords: ['rules'],
  },
  memory: {
    id: 'context.memory',
    group: 'Context',
    title: 'Project memory',
    keywords: [],
  },
  export: {
    id: 'session.export',
    group: 'Session',
    title: 'Export session',
    keywords: ['save'],
  },
  theme: {
    id: 'theme.switch',
    group: 'View',
    title: 'Switch theme',
    keywords: ['color', 'dark', 'light'],
    shortcut: 'ctrl+t',
  },
  quit: {
    id: 'app.quit',
    group: 'General',
    title: 'Quit',
    keywords: ['exit'],
    shortcut: 'ctrl+q',
  },
};

let cached: readonly TuiCommand[] | undefined;

/** 构建（并缓存）统一命令列表。 */
export function buildCommands(): readonly TuiCommand[] {
  if (cached !== undefined) {
    return cached;
  }
  cached = slashCommands.map((command) => {
    const meta = META[command.name];
    const id = meta?.id ?? command.name;
    const group = meta?.group ?? 'General';
    const title = meta?.title ?? humanize(command.name);
    const keywords = [...(command.aliases ?? []), ...(meta?.keywords ?? [])];
    return {
      id,
      title,
      group,
      keywords,
      slash: command.name,
      description: command.description,
      ...(meta?.shortcut !== undefined ? { shortcut: meta.shortcut } : {}),
    };
  });
  return cached;
}

function humanize(name: string): string {
  return name
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/**
 * 按查询过滤+排序命令。
 *
 * 空查询返回原序（palette 首屏按分组展示）；非空时对 id/title/keywords/slash 取
 * 最高匹配分，复用 autocomplete 的 {@link scoreCandidate}，保证全 TUI 一致的排序手感。
 */
export function filterCommands(
  commands: readonly TuiCommand[],
  query: string,
): readonly TuiCommand[] {
  const q = query.trim();
  if (q === '') {
    return commands;
  }
  return commands
    .map((command) => ({ command, score: bestScore(command, q) }))
    .filter((entry) => entry.score !== Number.NEGATIVE_INFINITY)
    .sort(
      (a, b) => b.score - a.score || a.command.id.localeCompare(b.command.id),
    )
    .map((entry) => entry.command);
}

function bestScore(command: TuiCommand, query: string): number {
  const haystacks = [
    command.id,
    command.title,
    command.slash,
    ...command.keywords,
  ];
  return Math.max(
    ...haystacks.map((candidate) => scoreCandidate(query, candidate)),
  );
}

/** 按 group 聚合，保持各组内原序，供 palette 分节渲染。 */
export function groupCommands(commands: readonly TuiCommand[]): readonly {
  readonly group: string;
  readonly commands: readonly TuiCommand[];
}[] {
  const order: string[] = [];
  const buckets = new Map<string, TuiCommand[]>();
  for (const command of commands) {
    let bucket = buckets.get(command.group);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(command.group, bucket);
      order.push(command.group);
    }
    bucket.push(command);
  }
  return order.map((group) => ({
    group,
    commands: buckets.get(group) ?? [],
  }));
}

/** 按 id 查命令。 */
export function findCommandById(id: string): TuiCommand | undefined {
  return buildCommands().find((command) => command.id === id);
}
