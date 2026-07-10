import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  defineTool,
  type AgentMessage,
  type AnyAgentTool,
  type ModelAdapter,
} from '@ello/agent';
import { glob } from 'tinyglobby';
import { z } from 'zod';

import { runInternalToolAgent } from '../agents/agent-runner.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { CodingAgentConfig } from '../config/index.js';
import { isPathInside } from '../permission/engine.js';
import type { ProviderRegistry } from '../provider/index.js';
import type { JsonlSessionRepository } from '../session/repository.js';

import type { MemoryIndexLoader } from './index-loader.js';
import { renderDreamPrompt, renderMemoryPrompt } from './prompt.js';
import type { MemoryToolPort } from './tools.js';
import { createMemoryTools } from './tools.js';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export async function runDreamJob(input: {
  readonly config: CodingAgentConfig;
  readonly registry: AgentRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionRepository: JsonlSessionRepository;
  readonly memory: MemoryToolPort;
  readonly indexLoader: MemoryIndexLoader;
  readonly modelAdapter?: ModelAdapter;
}): Promise<{ readonly changes: number; readonly summary: string }> {
  let changes = 0;
  const tools: AnyAgentTool[] = [
    ...createMemoryTools({
      port: input.memory,
      onMutation: () => {
        changes += 1;
        input.indexLoader.invalidate();
      },
    }),
    ...createDreamReadTools(input.config, input.sessionRepository),
  ];
  const result = await runInternalToolAgent({
    definition: input.registry.get('dream'),
    instructions: [
      renderMemoryPrompt(input.memory.repository.roots),
      renderDreamPrompt({
        roots: input.memory.repository.roots,
        sessionDir: input.config.sessionDir,
      }),
    ].join('\n\n'),
    prompt: 'Perform the four dream phases now.',
    tools,
    maxTurns: input.registry.get('dream').maxTurns ?? 16,
    config: input.config,
    providerRegistry: input.providerRegistry,
    ...(input.modelAdapter !== undefined
      ? { modelAdapter: input.modelAdapter }
      : {}),
  });
  return { changes, summary: result.output || result.text || '' };
}

function createDreamReadTools(
  config: CodingAgentConfig,
  sessions: JsonlSessionRepository,
): AnyAgentTool[] {
  return [
    defineTool({
      name: 'session_list_recent',
      description: 'List a bounded catalog of sessions updated recently.',
      input: z
        .object({
          days: z.number().int().min(1).max(30),
          limit: z.number().int().min(1).max(50),
        })
        .strict(),
      execute: async ({ days, limit }) => {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        return (await sessions.list())
          .filter(
            (session) =>
              session.updatedAt !== undefined &&
              Date.parse(session.updatedAt) >= cutoff,
          )
          .slice(0, limit);
      },
    }),
    defineTool({
      name: 'session_search',
      description:
        'Search recent session messages using a required narrow query, date range, and result limit.',
      input: z
        .object({
          query: z.string().trim().min(2),
          from: DateSchema,
          to: DateSchema,
          limit: z.number().int().min(1).max(100),
        })
        .strict(),
      execute: async ({ query, from, to, limit }) => {
        const start = Date.parse(`${from}T00:00:00.000Z`);
        const end = Date.parse(`${to}T23:59:59.999Z`);
        if (start > end) {
          throw new Error(
            'session_search from date must not be after to date.',
          );
        }
        const needle = query.toLocaleLowerCase();
        const matches: Array<{
          readonly sessionId: string;
          readonly updatedAt: string;
          readonly role: AgentMessage['role'];
          readonly snippet: string;
        }> = [];
        for (const summary of await sessions.list()) {
          if (summary.updatedAt === undefined) {
            continue;
          }
          const updated = Date.parse(summary.updatedAt);
          if (updated < start || updated > end) {
            continue;
          }
          const loaded = await sessions.load(summary.sessionId);
          for (const message of loaded.messages) {
            const text = messageText(message);
            const position = text.toLocaleLowerCase().indexOf(needle);
            if (position < 0) {
              continue;
            }
            matches.push({
              sessionId: summary.sessionId,
              updatedAt: summary.updatedAt,
              role: message.role,
              snippet: text.slice(Math.max(0, position - 120), position + 360),
            });
            if (matches.length === limit) {
              return matches;
            }
          }
        }
        return matches;
      },
    }),
    defineTool({
      name: 'repo_current_read',
      description:
        'Read one current repository file to verify a specific remembered claim.',
      input: z
        .object({
          path: z.string().min(1),
          maxChars: z.number().int().min(1).max(100_000),
        })
        .strict(),
      execute: async ({ path: targetPath, maxChars }) => {
        const target = await resolveRepoFile(config, targetPath);
        const content = await readFile(target, 'utf8');
        if (content.length > maxChars) {
          throw new Error(
            `repo_current_read result exceeds maxChars for ${targetPath}.`,
          );
        }
        return { path: target, content };
      },
    }),
    defineTool({
      name: 'repo_current_search',
      description:
        'Search current repository files using a required glob and bounded result limit.',
      input: z
        .object({
          query: z.string().trim().min(2),
          glob: z.string().min(1),
          limit: z.number().int().min(1).max(100),
        })
        .strict(),
      execute: async ({ query, glob: pattern, limit }) => {
        const files = await glob(pattern, {
          cwd: config.cwd,
          absolute: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          dot: true,
        });
        const needle = query.toLocaleLowerCase();
        const matches: Array<{
          readonly path: string;
          readonly line: number;
          readonly text: string;
        }> = [];
        for (const file of files.sort()) {
          const target = await resolveRepoFile(config, file);
          const lines = (await readFile(target, 'utf8')).split('\n');
          for (const [index, line] of lines.entries()) {
            if (!line.toLocaleLowerCase().includes(needle)) {
              continue;
            }
            matches.push({
              path: path.relative(config.cwd, target),
              line: index + 1,
              text: line,
            });
            if (matches.length === limit) {
              return matches;
            }
          }
        }
        return matches;
      },
    }),
  ];
}

async function resolveRepoFile(
  config: CodingAgentConfig,
  targetPath: string,
): Promise<string> {
  const target = path.resolve(config.cwd, targetPath);
  if (!isPathInside(config.cwd, target)) {
    throw new Error(`Repository path escapes cwd: ${targetPath}`);
  }
  for (const root of [
    config.context.memory.private_dir,
    config.context.memory.team_dir,
  ]) {
    if (isPathInside(root, target)) {
      throw new Error(
        `Repository tools cannot access memory roots: ${targetPath}`,
      );
    }
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Repository path is not a regular file: ${targetPath}`);
  }
  const resolved = await realpath(target);
  if (!isPathInside(config.cwd, resolved)) {
    throw new Error(
      `Repository path escapes cwd through symlink: ${targetPath}`,
    );
  }
  return resolved;
}

function messageText(message: AgentMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}
