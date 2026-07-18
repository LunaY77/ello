import { exec } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { CodingAgentConfig } from '../../config/index.js';
import type {
  AgentEnvironment,
  AgentFileSystem,
  AgentShell,
} from '../engine/index.js';
import { createLocalShellEnvironment } from '../environment/index.js';
import {
  isPathInside,
  resolveAbsolute,
} from '../permissions/engine.js';

const execAsync = promisify(exec);

type PolicyFileSystem = AgentFileSystem & {
  resolvePath(targetPath: string): string;
  stat(targetPath: string): ReturnType<typeof stat>;
};

/**
 * 模型工具使用的动态文件与 shell 边界。持久权限和本次 thread 临时授权会在每次
 * 调用时重新读取，审批成功后不需要重建整个 Agent。
 */
export function createRuntimeEnvironment(
  config: CodingAgentConfig,
  rules: () => readonly {
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }[],
  threadExternalPaths: () => readonly string[],
  skillReadRoots: () => readonly string[],
): AgentEnvironment {
  const base = createLocalShellEnvironment({
    cwd: config.cwd,
    allowedPaths: [config.cwd],
  });
  const writePaths = () =>
    runtimeAllowedPaths(config.cwd, rules(), threadExternalPaths());
  const readPaths = () => [...writePaths(), ...skillReadRoots()];
  const fileSystem = createPolicyFileSystem(
    config.cwd,
    readPaths,
    writePaths,
  );
  const shell = createPolicyShell(config.cwd, writePaths);
  const environment: AgentEnvironment = {
    ...base,
    fileSystem,
    shell,
    getInstructions: () => null,
  };
  base.resources?.bind?.(environment);
  return environment;
}

function runtimeAllowedPaths(
  cwd: string,
  rules: readonly {
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }[],
  threadExternalPaths: readonly string[],
): readonly string[] {
  const roots = [cwd, ...threadExternalPaths];
  for (const rule of rules) {
    if (rule.permission === 'external_directory' && rule.action === 'allow') {
      roots.push(resolveAbsolute(cwd, rule.pattern));
    }
  }
  return [...new Set(roots.map((root) => canonicalTarget(path.resolve(root))))];
}

function createPolicyFileSystem(
  cwd: string,
  readPaths: () => readonly string[],
  writePaths: () => readonly string[],
): PolicyFileSystem {
  return {
    resolvePath(targetPath) {
      return resolveAllowedTarget(cwd, targetPath, readPaths());
    },
    readText(targetPath) {
      return readFile(resolveAllowedTarget(cwd, targetPath, readPaths()), 'utf8');
    },
    async writeText(targetPath, content) {
      const resolved = resolveAllowedTarget(cwd, targetPath, writePaths());
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
    },
    async listDir(targetPath) {
      return (
        await readdir(resolveAllowedTarget(cwd, targetPath, readPaths()))
      ).sort();
    },
    stat(targetPath) {
      return stat(resolveAllowedTarget(cwd, targetPath, readPaths()));
    },
  };
}

function createPolicyShell(
  cwd: string,
  allowedPaths: () => readonly string[],
): AgentShell {
  return {
    async run(command, options = {}) {
      const resolvedCwd = resolveAllowedTarget(
        cwd,
        options.cwd ?? cwd,
        allowedPaths(),
      );
      try {
        const result = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: options.timeout,
          env:
            options.env === undefined
              ? process.env
              : { ...process.env, ...options.env },
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
          readonly stdout?: string;
          readonly stderr?: string;
          readonly code?: number | string;
          readonly killed?: boolean;
        };
        return {
          exitCode:
            failure.killed === true
              ? -1
              : typeof failure.code === 'number'
                ? failure.code
                : 1,
          stdout: failure.stdout ?? '',
          stderr:
            failure.killed === true
              ? 'timeout'
              : (failure.stderr ?? failure.message),
        };
      }
    },
  };
}

function resolveAllowedTarget(
  cwd: string,
  target: string,
  allowedPaths: readonly string[],
): string {
  const resolved = canonicalTarget(resolveAbsolute(cwd, target));
  if (!allowedPaths.some((allowedPath) => isPathInside(allowedPath, resolved))) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

function canonicalTarget(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  let parent = path.dirname(target);
  while (!existsSync(parent) && path.dirname(parent) !== parent) {
    parent = path.dirname(parent);
  }
  return path.join(realpathSync(parent), path.relative(parent, target));
}
