import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { glob } from 'tinyglobby';

import type { CodingAgentConfig } from '../config/index.js';

import {
  estimateTextTokens,
  type ContextDiagnostic,
  type ContextSource,
  type ContextSourceLoadResult,
} from './source-registry.js';

const URL_CACHE = new Map<
  string,
  { readonly text: string; readonly at: number }
>();
const URL_CACHE_TTL_MS = 5 * 60 * 1000;
const URL_TIMEOUT_MS = 5_000;
const MAX_URL_CHARS = 120_000;

interface InstructionSpec {
  readonly value: string;
  readonly bucket: 'global' | 'project' | 'extra' | 'nearby';
  readonly priority: number;
}

/** 加载配置声明的 instruction sources，支持 path、glob 和 URL。 */
export async function loadInstructionSources(
  config: CodingAgentConfig,
): Promise<ContextSourceLoadResult> {
  const diagnostics: ContextDiagnostic[] = [];
  const sources: ContextSource[] = [];
  const seenOrigins = new Set<string>();

  for (const spec of instructionSpecs(config)) {
    if (isUrl(spec.value)) {
      const loaded = await loadUrlInstruction(spec);
      diagnostics.push(...(loaded.diagnostics ?? []));
      sources.push(...dedupeByOrigin(loaded.sources, seenOrigins));
      continue;
    }

    const matches = await resolveInstructionPaths(config.cwd, spec);
    for (const file of matches) {
      const text = await readInstructionFile(file);
      if (text === null || !text.trim()) {
        continue;
      }
      const origin = path.resolve(file);
      if (seenOrigins.has(origin)) {
        continue;
      }
      seenOrigins.add(origin);
      sources.push({
        id: `instruction:${origin}`,
        type: 'instruction',
        title: instructionTitle(config.cwd, spec, origin),
        priority: spec.priority,
        content: text.trim(),
        origin,
        tokensEstimate: estimateTextTokens(text),
      });
    }
  }

  return { sources, diagnostics };
}

/**
 * 兼容旧 API：只返回项目指令正文。
 *
 * 新 pipeline 以 {@link loadInstructionSources} 为准；这里保留给外部调用方和测试。
 */
export async function loadProjectInstructions(cwd: string): Promise<string> {
  const candidates = ['AGENTS.md', '.ello/ELLO.md', '.ello/instructions.md'];
  const parts = await Promise.all(
    candidates.map(async (candidate) => {
      const file = path.resolve(cwd, candidate);
      const text = await readInstructionFile(file);
      return text !== null && text.trim()
        ? `# ${candidate}\n${text.trim()}`
        : null;
    }),
  );
  return parts.filter((part): part is string => part !== null).join('\n\n');
}

function instructionSpecs(config: CodingAgentConfig): InstructionSpec[] {
  const instructions = config.context.instructions;
  return [
    ...instructions.global.map((value) => ({
      value,
      bucket: 'global' as const,
      priority: 100,
    })),
    ...instructions.project.map((value) => ({
      value,
      bucket: 'project' as const,
      priority: 120,
    })),
    ...instructions.extra.map((value) => ({
      value,
      bucket: 'extra' as const,
      priority: 140,
    })),
  ];
}

async function resolveInstructionPaths(
  cwd: string,
  spec: InstructionSpec,
): Promise<string[]> {
  const expanded = expandHome(spec.value);
  const base = spec.bucket === 'global' ? homedir() : cwd;
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(base, expanded);
  if (!looksLikeGlob(expanded)) {
    return [resolved];
  }

  const pattern = normalizeGlobPath(expanded);
  const matches = await glob(pattern, {
    cwd: path.isAbsolute(expanded) ? '/' : base,
    absolute: true,
    dot: true,
    onlyFiles: true,
  });
  return matches.map((item: string) => path.resolve(item)).sort();
}

async function readInstructionFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read instruction file: ${file}`, {
      cause: error,
    });
  }
}

async function loadUrlInstruction(
  spec: InstructionSpec,
): Promise<ContextSourceLoadResult> {
  const cached = URL_CACHE.get(spec.value);
  if (cached !== undefined && Date.now() - cached.at < URL_CACHE_TTL_MS) {
    return {
      sources: [
        {
          id: `instruction:${spec.value}`,
          type: 'instruction',
          title: `Instruction URL: ${spec.value}`,
          priority: spec.priority,
          content: cached.text,
          origin: spec.value,
          tokensEstimate: estimateTextTokens(cached.text),
        },
      ],
    };
  }

  try {
    const response = await fetch(spec.value, {
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    });
    if (!response.ok) {
      return staleUrlResult(
        spec,
        cached,
        `Instruction URL returned HTTP ${response.status}`,
      );
    }
    const text = (await response.text()).slice(0, MAX_URL_CHARS).trim();
    URL_CACHE.set(spec.value, { text, at: Date.now() });
    return {
      sources: text
        ? [
            {
              id: `instruction:${spec.value}`,
              type: 'instruction',
              title: `Instruction URL: ${spec.value}`,
              priority: spec.priority,
              content: text,
              origin: spec.value,
              tokensEstimate: estimateTextTokens(text),
            },
          ]
        : [],
    };
  } catch (error) {
    return staleUrlResult(
      spec,
      cached,
      `Failed to fetch instruction URL: ${errorMessage(error)}`,
    );
  }
}

function staleUrlResult(
  spec: InstructionSpec,
  cached: { readonly text: string; readonly at: number } | undefined,
  message: string,
): ContextSourceLoadResult {
  if (cached === undefined) {
    throw new Error(message);
  }
  return {
    sources: [
      {
        id: `instruction:${spec.value}`,
        type: 'instruction',
        title: `Instruction URL: ${spec.value}`,
        priority: spec.priority,
        content: cached.text,
        origin: spec.value,
        tokensEstimate: estimateTextTokens(cached.text),
        stale: true,
      },
    ],
    diagnostics: [{ level: 'warn', origin: spec.value, message }],
  };
}

function dedupeByOrigin(
  sources: readonly ContextSource[],
  seenOrigins: Set<string>,
): ContextSource[] {
  const result: ContextSource[] = [];
  for (const source of sources) {
    const origin = source.origin ?? source.id;
    if (seenOrigins.has(origin)) {
      continue;
    }
    seenOrigins.add(origin);
    result.push(source);
  }
  return result;
}

function instructionTitle(
  cwd: string,
  spec: InstructionSpec,
  origin: string,
): string {
  const display = origin.startsWith(cwd)
    ? path.relative(cwd, origin)
    : origin.replace(homedir(), '~');
  switch (spec.bucket) {
    case 'global':
      return `Global instructions: ${display}`;
    case 'project':
      return `Project instructions: ${display}`;
    case 'extra':
      return `Extra instructions: ${display}`;
    case 'nearby':
      return `Nearby instructions: ${display}`;
  }
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(homedir(), value.slice(2))
    : value;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}

function looksLikeGlob(value: string): boolean {
  return /[*?[\]{}]/u.test(value);
}

function normalizeGlobPath(value: string): string {
  return value.split(path.sep).join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
