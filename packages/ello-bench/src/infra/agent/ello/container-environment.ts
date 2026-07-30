import path from 'node:path';

import type {
  AgentEnvironment,
  AgentFileSystem,
  AgentShell,
} from '@ello/agent/runtime';

import type { ContainerHandle } from '../../../ports/container.js';

export function createContainerEnvironment(options: {
  readonly container: ContainerHandle;
}): AgentEnvironment {
  const fileSystem = createContainerFileSystem(options.container);
  const shell = createContainerShell(options.container);
  return {
    fileSystem,
    shell,
    setup: () => undefined,
    getInstructions: async () =>
      [
        '<environment-context>',
        '<file-system>',
        `  <working-directory>${options.container.workspace}</working-directory>`,
        `  <allowed-path>${options.container.workspace}</allowed-path>`,
        '</file-system>',
        await shell.getContextInstructions?.(),
        '</environment-context>',
      ]
        .filter((line): line is string => line !== undefined && line !== null)
        .join('\n'),
    close: async () => shell.close?.(),
  };
}

function createContainerFileSystem(
  container: ContainerHandle,
): AgentFileSystem {
  return {
    resolvePath: (target) => resolveContainerPath(container.workspace, target),
    async readText(target) {
      const resolved = resolveContainerPath(container.workspace, target);
      const result = await container.exec(['cat', '--', resolved], {
        cwd: container.workspace,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      requireSuccess(result, `read ${resolved}`);
      return result.stdout ?? '';
    },
    async writeText(target, content) {
      const resolved = resolveContainerPath(container.workspace, target);
      const result = await container.exec(
        [
          'sh',
          '-c',
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          'ello-bench-write',
          resolved,
        ],
        { cwd: container.workspace, input: content, timeoutMs: 30_000 },
      );
      requireSuccess(result, `write ${resolved}`);
    },
    async listDir(target) {
      const resolved = resolveContainerPath(container.workspace, target);
      const result = await container.exec(
        [
          'find',
          resolved,
          '-mindepth',
          '1',
          '-maxdepth',
          '1',
          '-printf',
          '%f\n',
        ],
        { cwd: container.workspace, timeoutMs: 30_000 },
      );
      requireSuccess(result, `list ${resolved}`);
      return (result.stdout ?? '')
        .split('\n')
        .filter((entry) => entry !== '')
        .sort();
    },
    async stat(target) {
      const resolved = resolveContainerPath(container.workspace, target);
      const result = await container.exec(
        [
          'sh',
          '-c',
          'test -e "$1" && { test -d "$1" && printf d || printf f; }',
          'ello-bench-stat',
          resolved,
        ],
        { cwd: container.workspace, timeoutMs: 30_000 },
      );
      requireSuccess(result, `stat ${resolved}`);
      const directory = result.stdout === 'd';
      return { isDirectory: () => directory };
    },
    getContextInstructions: () =>
      [
        '<file-system>',
        `  <working-directory>${container.workspace}</working-directory>`,
        `  <allowed-path>${container.workspace}</allowed-path>`,
        '</file-system>',
      ].join('\n'),
  };
}

function createContainerShell(container: ContainerHandle): AgentShell {
  return {
    async run(command, options = {}) {
      const result = await container.exec(['sh', '-lc', command], {
        cwd: resolveContainerPath(
          container.workspace,
          options.cwd ?? container.workspace,
        ),
        ...(options.env === undefined ? {} : { env: options.env }),
        timeoutMs: options.timeout ?? 120_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      return {
        exitCode: result.process.exitCode ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.process.timedOut,
      };
    },
    getContextInstructions: () =>
      [
        '<shell>',
        `  <container>${container.name}</container>`,
        `  <working-directory>${container.workspace}</working-directory>`,
        '</shell>',
      ].join('\n'),
  };
}

function resolveContainerPath(root: '/app', target: string): string {
  const resolved = path.posix.resolve(root, target);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Container path escapes workspace: ${target}`);
  }
  return resolved;
}

function requireSuccess(
  result: Awaited<ReturnType<ContainerHandle['exec']>>,
  operation: string,
): void {
  if (result.process.exitCode !== 0 || result.process.timedOut) {
    throw new Error(
      `Container ${operation} failed: ${result.stderr ?? `exit ${String(result.process.exitCode)}`}`,
    );
  }
}
