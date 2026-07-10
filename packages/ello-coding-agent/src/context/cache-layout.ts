import type { SystemSection } from '@ello/agent';

const DYNAMIC_OPEN = '<cache-dynamic>';
const DYNAMIC_CLOSE = '</cache-dynamic>';
const DYNAMIC_BLOCK = /<cache-dynamic>\n([\s\S]*?)\n<\/cache-dynamic>/gu;

export interface SystemCacheSegments {
  readonly stable: string;
  readonly dynamic: string;
}

/** 把高变化 system 内容标记为稳定前缀之后的动态后缀。 */
export function dynamicSystemSection(section: SystemSection): SystemSection {
  return async (run) => {
    const content = await section(run);
    return content === null || content === undefined || content === ''
      ? null
      : wrapDynamicSystemContent(content);
  };
}

export function wrapDynamicSystemContent(content: string): string {
  const normalized = content.trim();
  if (normalized === '') {
    throw new Error('Dynamic system content must not be empty.');
  }
  if (normalized.includes(DYNAMIC_OPEN) || normalized.includes(DYNAMIC_CLOSE)) {
    throw new Error('Dynamic system content contains a reserved cache tag.');
  }
  return `${DYNAMIC_OPEN}\n${normalized}\n${DYNAMIC_CLOSE}`;
}

/** 解析 cache layout，并拒绝动态块之后再次出现稳定文本。 */
export function splitSystemCacheSegments(system: string): SystemCacheSegments {
  const matches = [...system.matchAll(DYNAMIC_BLOCK)];
  if (matches.length === 0) {
    return { stable: system.trim(), dynamic: '' };
  }
  const firstIndex = matches[0]!.index;
  if (firstIndex === undefined) {
    throw new Error('Dynamic system block is missing its source index.');
  }
  const stable = system.slice(0, firstIndex).trim();
  if (stable === '') {
    throw new Error('Stable system prefix must precede dynamic context.');
  }
  const dynamic: string[] = [];
  let cursor = firstIndex;
  for (const match of matches) {
    const index = match.index;
    if (index === undefined) {
      throw new Error('Dynamic system block is missing its source index.');
    }
    if (system.slice(cursor, index).trim() !== '') {
      throw new Error('Stable system content must not follow dynamic context.');
    }
    dynamic.push(match[1]!.trim());
    cursor = index + match[0].length;
  }
  if (system.slice(cursor).trim() !== '') {
    throw new Error('Stable system content must not follow dynamic context.');
  }
  return { stable, dynamic: dynamic.join('\n\n') };
}

export function joinSystemCacheSegments(segments: SystemCacheSegments): string {
  return segments.dynamic === ''
    ? segments.stable
    : `${segments.stable}\n\n${segments.dynamic}`;
}
