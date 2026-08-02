import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { AgentRunContext } from '../../../ports/agent.js';
import { AgentAdapterError } from '../error.js';
import {
  installExternalExecutable,
  type ExternalRuntimeInspection,
} from '../external.js';

interface CodexPackageLayout {
  readonly root: string;
  readonly executable: string;
}

const CODEX_TARGETS = {
  'linux:arm64': {
    packageName: '@openai/codex-linux-arm64',
    target: 'aarch64-unknown-linux-musl',
  },
  'linux:x64': {
    packageName: '@openai/codex-linux-x64',
    target: 'x86_64-unknown-linux-musl',
  },
} as const;

export async function installCodexExecutable(
  context: AgentRunContext,
  runtime: ExternalRuntimeInspection,
  expectedVersion: string,
): Promise<string> {
  const layout = await resolveCodexPackageLayout(
    runtime.executablePath,
    expectedVersion,
  );
  if (layout === undefined) {
    return await installExternalExecutable(context, runtime, 'codex');
  }

  const containerRoot = `/tmp/ello-bench/${context.attemptId}/codex-runtime`;
  const prepared = await context.container.exec(
    ['mkdir', '-p', path.posix.dirname(containerRoot)],
    { cwd: context.container.workspace, timeoutMs: 30_000 },
  );
  if (prepared.process.exitCode !== 0 || prepared.process.timedOut) {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot create Codex runtime directory in container: ${prepared.stderr ?? ''}`,
    );
  }
  try {
    await context.container.copyIn(layout.root, containerRoot);
  } catch (error) {
    throw new AgentAdapterError(
      'agent_setup',
      'Cannot copy Codex package runtime into container.',
      { cause: error },
    );
  }
  const executable = `${containerRoot}/${layout.executable}`;
  const permission = await context.container.exec(
    ['chmod', '0500', executable],
    { cwd: context.container.workspace, timeoutMs: 30_000 },
  );
  if (permission.process.exitCode !== 0 || permission.process.timedOut) {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot make Codex executable in container: ${permission.stderr ?? ''}`,
    );
  }
  const smoke = await context.container.exec([executable, '--version'], {
    cwd: context.container.workspace,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  const observedVersion = (smoke.stdout ?? smoke.stderr ?? '').trim();
  if (
    smoke.process.exitCode !== 0 ||
    smoke.process.timedOut ||
    observedVersion !== `codex-cli ${expectedVersion}`
  ) {
    throw new AgentAdapterError(
      'agent_setup',
      `Codex package runtime failed its container version check: ${observedVersion}.`,
    );
  }
  return executable;
}

async function resolveCodexPackageLayout(
  executablePath: string,
  expectedVersion: string,
): Promise<CodexPackageLayout | undefined> {
  const canonicalExecutable = await realpath(executablePath);
  const directRoot = path.dirname(path.dirname(canonicalExecutable));
  const direct = await readPackageLayout(directRoot, expectedVersion);
  if (
    direct !== undefined &&
    canonicalExecutable === path.join(direct.root, direct.executable)
  ) {
    return direct;
  }

  if (
    path.basename(canonicalExecutable) !== 'codex.js' ||
    path.basename(path.dirname(canonicalExecutable)) !== 'bin'
  ) {
    return undefined;
  }
  const packageRoot = path.dirname(path.dirname(canonicalExecutable));
  const manifest = await readJson(path.join(packageRoot, 'package.json'));
  if (manifest?.name !== '@openai/codex') return undefined;
  const target =
    CODEX_TARGETS[
      `${process.platform}:${process.arch}` as keyof typeof CODEX_TARGETS
    ];
  if (target === undefined) {
    throw new AgentAdapterError(
      'agent_setup',
      `Codex npm runtime does not support ${process.platform}/${process.arch} benchmark hosts.`,
    );
  }

  let vendorRoot: string;
  try {
    const platformManifest = createRequire(canonicalExecutable).resolve(
      `${target.packageName}/package.json`,
    );
    vendorRoot = path.join(path.dirname(platformManifest), 'vendor');
  } catch {
    vendorRoot = path.join(packageRoot, 'vendor');
  }
  const layout = await readPackageLayout(
    path.join(vendorRoot, target.target),
    expectedVersion,
  );
  if (layout === undefined) {
    throw new AgentAdapterError(
      'agent_setup',
      `Codex npm runtime is missing its ${target.target} package layout.`,
    );
  }
  return layout;
}

async function readPackageLayout(
  root: string,
  expectedVersion: string,
): Promise<CodexPackageLayout | undefined> {
  const metadata = await readJson(path.join(root, 'codex-package.json'));
  if (metadata === undefined) return undefined;
  if (
    metadata.layoutVersion !== 1 ||
    metadata.variant !== 'codex' ||
    metadata.version !== expectedVersion ||
    typeof metadata.entrypoint !== 'string' ||
    metadata.entrypoint !== 'bin/codex'
  ) {
    throw new AgentAdapterError(
      'agent_setup',
      `Codex package layout does not match version ${expectedVersion}.`,
    );
  }
  const executable = path.join(root, metadata.entrypoint);
  const executableMetadata = await stat(executable).catch(() => undefined);
  if (executableMetadata?.isFile() !== true) {
    throw new AgentAdapterError(
      'agent_setup',
      `Codex package executable is missing: ${executable}.`,
    );
  }
  return { root, executable: metadata.entrypoint };
}

async function readJson(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const source = await readFile(filePath, 'utf8').catch(() => undefined);
  if (source === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch (error) {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot parse Codex package metadata: ${filePath}.`,
      { cause: error },
    );
  }
}
