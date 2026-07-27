import path from 'node:path';

import { ensureEmptyDirectory } from './filesystem.js';
import { configureGitWorkspace } from './git-workspace.js';
import { runChecked, runProcess } from './process.js';

const DOCKER_OPTIONS = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 128 * 1024 * 1024,
} as const;

export async function extractImageWorkspace(options: {
  readonly containerName: string;
  readonly image: string;
  readonly workspace: string;
  readonly timeoutMs: number;
}): Promise<string> {
  const workspace = path.resolve(options.workspace);
  await ensureEmptyDirectory(workspace);
  const imageId = await ensureImage(options.image);
  await removeContainer(options.containerName);
  try {
    await runChecked(
      'docker',
      [
        'create',
        '--name',
        options.containerName,
        '--workdir',
        '/app',
        options.image,
      ],
      { cwd: workspace, ...DOCKER_OPTIONS },
    );
    await runChecked(
      'docker',
      ['cp', `${options.containerName}:/app/.`, workspace],
      {
        cwd: workspace,
        timeoutMs: options.timeoutMs,
        killGraceMs: 5_000,
        maxOutputBytes: 256 * 1024 * 1024,
      },
    );
  } finally {
    await removeContainer(options.containerName);
  }
  await configureGitWorkspace(workspace);
  return imageId;
}

export async function removeContainer(name: string): Promise<void> {
  const inspected = await runProcess('docker', ['container', 'inspect', name], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
    killGraceMs: 5_000,
    capture: true,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (inspected.result.exitCode !== 0 || inspected.result.timedOut) {
    const stderr = requiredOutput(inspected.stderr, 'docker container inspect');
    if (!inspected.result.timedOut && stderr.includes('No such container')) {
      return;
    }
    throw new Error(`Docker container inspect failed: ${stderr}`);
  }
  await runChecked('docker', ['rm', '-f', name], {
    cwd: process.cwd(),
    timeoutMs: 120_000,
    killGraceMs: 5_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
}

async function ensureImage(image: string): Promise<string> {
  const inspected = await runProcess(
    'docker',
    ['image', 'inspect', image, '--format', '{{.Id}}'],
    {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      killGraceMs: 5_000,
      capture: true,
      maxOutputBytes: 16 * 1024 * 1024,
    },
  );
  if (inspected.result.exitCode !== 0) {
    const stderr = requiredOutput(inspected.stderr, 'docker image inspect');
    if (inspected.result.timedOut || !stderr.includes('No such image')) {
      throw new Error(`Docker image inspect failed: ${stderr}`);
    }
    await runChecked('docker', ['pull', image], {
      cwd: process.cwd(),
      timeoutMs: 30 * 60_000,
      killGraceMs: 5_000,
      maxOutputBytes: 256 * 1024 * 1024,
    });
  }
  const imageId = (
    await runChecked(
      'docker',
      ['image', 'inspect', image, '--format', '{{.Id}}'],
      {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        killGraceMs: 5_000,
        maxOutputBytes: 16 * 1024 * 1024,
      },
    )
  ).stdout.trim();
  if (imageId === '') throw new Error(`Docker image id is empty: ${image}`);
  return imageId;
}

function requiredOutput(value: string | undefined, operation: string): string {
  if (value === undefined) {
    throw new Error(`${operation} did not return captured stderr.`);
  }
  return value;
}
