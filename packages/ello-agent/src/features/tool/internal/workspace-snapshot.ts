/**
 * 本文件提供一次性 workspace 摘要，替代模型反复执行全仓目录、Git 和依赖扫描。
 */
import { z } from 'zod';

import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';

import {
  createCodingToolResult,
  defineCodingTool,
} from './runtime/coding-tool.js';
import { processOutputText, requireFs, requireProcesses } from './shared.js';

const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
];

const MANIFESTS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'pom.xml',
  'build.gradle',
];

/**
 * 创建只读 workspace snapshot 工具。
 *
 * Args:
 * - `config`: 当前 run 的稳定 workspace 配置。
 * - `decide`: 与 read/search 共用的权限判定器。
 *
 * Returns:
 * - 返回包含仓库状态、根目录、依赖锁和建议验证命令的单个工具。
 */
export function createWorkspaceSnapshotTools(
  config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return [
    defineCodingTool({
      name: 'workspace_snapshot',
      description:
        'Return one bounded workspace snapshot containing Git head/status, root entries, dependency manifests, lockfiles, and likely build/test commands. Use it at the start of a coding task or after compaction instead of repeating broad directory and repository scans.',
      discovery: {
        aliases: ['repository snapshot', 'workspace summary'],
        risk: 'readonly',
      },
      input: z
        .object({
          include_untracked: z.boolean().default(true),
        })
        .strict(),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'read',
            patterns: ['workspace_snapshot'],
            always: ['workspace_snapshot'],
            paths: [config.cwd],
            metadata: { kind: 'read', path: config.cwd },
          },
          ctx.agent,
        ),
      capabilities: () => ({
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
        interruptible: true,
        telemetryTag: 'workspace.snapshot',
      }),
      execute: async ({ include_untracked }, ctx) => {
        const fs = requireFs(ctx.agent);
        const processes = requireProcesses(ctx.agent);
        const [entries, head, branch, status] = await Promise.all([
          fs.listDir(config.cwd),
          processes.exec({
            command: 'git rev-parse HEAD',
            cwd: config.cwd,
            maxRuntimeMs: 10_000,
          }),
          processes.exec({
            command: 'git branch --show-current',
            cwd: config.cwd,
            maxRuntimeMs: 10_000,
          }),
          processes.exec({
            command: include_untracked
              ? 'git status --short --branch'
              : 'git status --short --branch --untracked-files=no',
            cwd: config.cwd,
            maxRuntimeMs: 10_000,
          }),
        ]);
        const headText = processOutputText(head.stdout, 'stdout');
        const branchText = processOutputText(branch.stdout, 'stdout');
        const statusText = processOutputText(status.stdout, 'stdout');
        const sortedEntries = [...entries].sort();
        const manifests = MANIFESTS.filter((name) =>
          sortedEntries.includes(name),
        );
        const lockfiles = LOCKFILES.filter((name) =>
          sortedEntries.includes(name),
        );
        const snapshot = {
          schema: 'ello.workspace-snapshot.v1',
          cwd: config.cwd,
          git: {
            available: head.exitCode === 0,
            head: head.exitCode === 0 ? headText.trim() : null,
            branch: branch.exitCode === 0 ? branchText.trim() : null,
            status: statusText.trim().split('\n').filter(Boolean),
          },
          rootEntries: sortedEntries.slice(0, 200),
          rootEntriesTruncated: sortedEntries.length > 200,
          manifests,
          lockfiles,
          verificationCommands: verificationCommands(manifests),
        };
        return createCodingToolResult({
          title: 'Workspace snapshot',
          output: JSON.stringify(snapshot, null, 2),
          metadata: {
            kind: 'workspace',
            cwd: config.cwd,
            paths: sortedEntries.slice(0, 200),
            manifests,
            lockfiles,
            dirty: snapshot.git.status.some((line) => !line.startsWith('##')),
          },
        });
      },
    }),
  ];
}

function verificationCommands(manifests: readonly string[]): readonly string[] {
  const commands: string[] = [];
  if (manifests.includes('package.json')) {
    commands.push('pnpm test', 'pnpm typecheck', 'pnpm lint');
  }
  if (manifests.includes('Cargo.toml')) {
    commands.push('cargo test', 'cargo check');
  }
  if (manifests.includes('go.mod')) commands.push('go test ./...');
  if (
    manifests.includes('pyproject.toml') ||
    manifests.includes('requirements.txt')
  ) {
    commands.push('pytest');
  }
  return commands;
}
