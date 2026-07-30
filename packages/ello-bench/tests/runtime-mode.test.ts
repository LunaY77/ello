import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { NormalizedToolCall } from '../src/domain/contract/index.js';
import { auditExternalTools } from '../src/domain/evidence/routing-audit.js';
import { createRuntimeBoundaryInstruction } from '../src/infra/agent/runtime-boundary.js';
import { createBenchmarkAgentRuntime } from '../src/infra/runtime.js';
import type { AgentRunContext } from '../src/ports/agent.js';

import { FakeContainerHandle } from './fake-container.js';

describe('container benchmark runtime boundary', () => {
  it('instructs external Agents to stay inside the assigned container', () => {
    const boundary = createRuntimeBoundaryInstruction({
      container: { workspace: '/app' },
    } as AgentRunContext);

    expect(boundary).toContain('inside the assigned task container');
    expect(boundary).toContain('working directory is /app');
    expect(boundary).toContain('do not invoke Docker');
    expect(boundary).not.toContain('host workspace');
  });

  it('accepts direct container shell calls and rejects nested Docker calls', () => {
    const direct = auditExternalTools({
      workspace: '/app',
      parserCoverage: 'complete',
      tools: [shellTool('git status')],
    });
    const docker = auditExternalTools({
      workspace: '/app',
      parserCoverage: 'complete',
      tools: [shellTool('docker exec task bash -c "git status"')],
    });

    expect(direct).toMatchObject({
      status: 'passed',
      shellCalls: 1,
      routedShellCalls: 1,
    });
    expect(docker).toMatchObject({
      status: 'failed',
      violations: [expect.objectContaining({ kind: 'docker_shell' })],
    });
  });

  it('routes Ello shell and filesystem operations through ContainerHandle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-container-runtime-'));
    const workspace = path.join(root, 'workspace');
    const containerRoot = path.join(root, 'container');
    const rawRoot = path.join(root, 'raw');
    await mkdir(workspace, { recursive: true });
    const container = new FakeContainerHandle(workspace, containerRoot);
    const runtime = createBenchmarkAgentRuntime({
      workspace,
      rawRoot,
      container,
    });
    try {
      const environment = runtime.createEnvironment({
        config: { cwd: '/app' },
      } as Parameters<typeof runtime.createEnvironment>[0]);

      await environment.fileSystem.writeText(
        'nested/from-fs.txt',
        'filesystem\n',
      );
      const result = await environment.shell.run(
        'printf "container runtime\\n" > from-shell.txt',
      );
      await environment.close?.();

      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(
        await readFile(path.join(workspace, 'nested', 'from-fs.txt'), 'utf8'),
      ).toBe('filesystem\n');
      expect(
        await readFile(path.join(workspace, 'from-shell.txt'), 'utf8'),
      ).toBe('container runtime\n');
      await expect(
        environment.fileSystem.readText('../escape'),
      ).rejects.toThrow('escapes workspace');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses a thread recorder across provider recovery tracing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-container-runtime-'));
    const workspace = path.join(root, 'workspace');
    const containerRoot = path.join(root, 'container');
    const rawRoot = path.join(root, 'raw');
    await mkdir(workspace, { recursive: true });
    const runtime = createBenchmarkAgentRuntime({
      workspace,
      rawRoot,
      container: new FakeContainerHandle(workspace, containerRoot),
    });
    try {
      const initial = runtime.createTracing({
        threadId: 'thr_main',
      } as Parameters<typeof runtime.createTracing>[0]);
      await initial.eventRecorder.record(
        {
          type: 'run.started',
          runId: 'run_1',
          sequence: 1,
          occurredAt: '2026-07-23T00:00:00.000Z',
        },
        {},
      );
      await initial.close();

      const recovered = runtime.createTracing({
        threadId: 'thr_main',
      } as Parameters<typeof runtime.createTracing>[0]);
      expect(recovered.eventRecorder).toBe(initial.eventRecorder);
      await recovered.eventRecorder.record(
        {
          type: 'turn.started',
          runId: 'run_1',
          sequence: 2,
          occurredAt: '2026-07-23T00:00:01.000Z',
          turnIndex: 1,
        },
        {},
      );
      await recovered.close();

      const eventLogPath = path.join(rawRoot, 'engine-events-thr_main.jsonl');
      expect(
        (await readFile(eventLogPath, 'utf8')).trim().split('\n'),
      ).toHaveLength(2);
      expect(
        JSON.parse(await readFile(`${eventLogPath}.complete.json`, 'utf8')),
      ).toMatchObject({ eventCount: 2, runCount: 1, turnCount: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function shellTool(command: string): NormalizedToolCall {
  return {
    id: 'shell-1',
    name: 'Bash',
    category: 'shell',
    status: 'completed',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    command,
    paths: [],
    mutating: false,
  };
}
