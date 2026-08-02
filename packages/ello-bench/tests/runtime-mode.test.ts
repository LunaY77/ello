import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { NormalizedToolCall } from '../src/domain/contract/index.js';
import { auditExternalTools } from '../src/domain/evidence/routing-audit.js';
import { createContainerProcessRegistry } from '../src/infra/agent/ello/container-processes.js';
import { createRuntimeBoundaryInstruction } from '../src/infra/agent/runtime-boundary.js';
import { createBenchmarkAgentRuntime } from '../src/infra/runtime.js';
import type { AgentRunContext } from '../src/ports/agent.js';
import type {
  ContainerProcess,
  ContainerProcessExit,
  ContainerProcessSignal,
} from '../src/ports/container.js';

import { FakeContainerHandle } from './fake-container.js';

describe('container benchmark runtime boundary', () => {
  it('separates the provider-facing control process from task execution', () => {
    const boundary = createRuntimeBoundaryInstruction({
      container: { name: 'bench-container', workspace: '/app' },
    } as AgentRunContext);

    expect(boundary).toContain('Agent control process runs on the benchmark host');
    expect(boundary).toContain(
      "docker exec -w /app bench-container bash -c '<command>'",
    );
    expect(boundary).toContain('Do not run repository shell commands on the host');
  });

  it('accepts only shell calls routed to the assigned task container', () => {
    const direct = auditExternalTools({
      workspace: '/app',
      parserCoverage: 'complete',
      tools: [shellTool('git status')],
      containerName: 'bench-container',
      containerWorkspace: '/app',
    });
    const routed = auditExternalTools({
      workspace: '/app',
      parserCoverage: 'complete',
      tools: [
        shellTool(
          "docker exec -w /app bench-container bash -c 'git status'",
        ),
      ],
      containerName: 'bench-container',
      containerWorkspace: '/app',
    });

    expect(direct).toMatchObject({
      status: 'failed',
      violations: [expect.objectContaining({ kind: 'host_shell' })],
    });
    expect(routed).toMatchObject({
      status: 'passed',
      shellCalls: 1,
      routedShellCalls: 1,
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
      rawRoot,
      container,
    });
    try {
      const environment = await runtime.environments.attach(
        {
          environmentRef: runtime.defaultEnvironmentRef,
          workingDirectory: '/app',
        },
        runtime.environmentGrant,
      );

      await environment.fileSystem.writeText(
        'nested/from-fs.txt',
        'filesystem\n',
      );
      await environment.fileSystem.writeFile(
        'nested/binary.bin',
        Uint8Array.from([0, 255, 1]),
      );
      const result = await environment.processes.exec({
        command: 'printf "container runtime\\n" > from-shell.txt',
        maxRuntimeMs: 10_000,
      });
      const directory = await environment.fileSystem.listDir('nested');
      const binary = await environment.fileSystem.readFile('nested/binary.bin');
      const stat = await environment.fileSystem.stat('nested/from-fs.txt');

      expect(environment).toMatchObject({
        environmentRef: container.name,
        generation: 1,
        workingDirectory: '/app',
        grant: { isolation: 'none' },
      });
      expect(await environment.getInstructions()).toContain(
        '<isolation>container</isolation>',
      );
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(directory).toEqual(['binary.bin', 'from-fs.txt']);
      expect(binary).toEqual(Uint8Array.from([0, 255, 1]));
      expect(stat).toMatchObject({ kind: 'file', size: 11 });
      expect(
        await readFile(path.join(workspace, 'nested', 'from-fs.txt'), 'utf8'),
      ).toBe('filesystem\n');
      expect(
        await readFile(path.join(workspace, 'from-shell.txt'), 'utf8'),
      ).toBe('container runtime\n');
      expect(environment.fileSystem.resolvePath('../tmp')).toBe('/tmp');
      await environment.fileSystem.remove('nested/binary.bin');
      await expect(
        environment.fileSystem.stat('nested/binary.bin'),
      ).rejects.toThrow('Container stat');
      await environment.close();
      expect(() => environment.fileSystem.resolvePath('.')).toThrow(
        'Environment Handle is closed',
      );
    } finally {
      await runtime.environments.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the task image PATH for Ello shell commands', async () => {
    const container = new FakeContainerHandle('/tmp', '/tmp');
    const registry = createContainerProcessRegistry(
      container,
      container.name,
      1,
    );
    const processes = registry.createHandle('owner', '/app', () => undefined);
    try {
      const result = await processes.exec({
        command: 'printf "%s" "$PATH"',
        env: { PATH: '/root/.cargo/bin:/usr/bin' },
        maxRuntimeMs: 10_000,
      });

      expect(Buffer.from(result.stdout.data).toString('utf8')).toBe(
        '/root/.cargo/bin:/usr/bin',
      );
    } finally {
      await registry.close();
    }
  });

  it('manages bounded background process output and stdin in the container', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-container-process-'));
    const workspace = path.join(root, 'workspace');
    const rawRoot = path.join(root, 'raw');
    await mkdir(workspace, { recursive: true });
    const runtime = createBenchmarkAgentRuntime({
      rawRoot,
      container: new FakeContainerHandle(
        workspace,
        path.join(root, 'container'),
      ),
    });
    try {
      const environment = await runtime.environments.attach(
        {
          environmentRef: runtime.defaultEnvironmentRef,
          workingDirectory: '/app',
        },
        runtime.environmentGrant,
      );
      const processRef = await environment.processes.spawn({
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.on("data", x => { process.stdout.write("0123456789"); process.stderr.write(x) })',
        ],
        lifecycle: 'background',
        maxRuntimeMs: 10_000,
        outputLimitBytes: 5,
      });
      await environment.processes.write(processRef, Buffer.from('input'));
      await environment.processes.closeStdin(processRef);
      await expect(
        environment.processes.wait(processRef),
      ).resolves.toMatchObject({ exitCode: 0, timedOut: false });

      const first = await environment.processes.inspect(processRef, {
        maxBytes: 3,
      });
      expect(Buffer.from(first.stdout.data).toString('utf8')).toBe('567');
      expect(first.stdout).toMatchObject({
        cursor: 5,
        nextCursor: 8,
        totalBytes: 10,
        truncatedBytes: 5,
        complete: false,
      });
      const second = await environment.processes.inspect(processRef, {
        stdoutCursor: first.stdout.nextCursor,
        stderrCursor: first.stderr.nextCursor,
        maxBytes: 3,
      });
      expect(Buffer.from(second.stdout.data).toString('utf8')).toBe('89');
      expect(second.stdout.complete).toBe(true);
      expect(Buffer.from(second.stderr.data).toString('utf8')).toBe('ut');
      expect(second.stderr.complete).toBe(true);
      await environment.close();
    } finally {
      await runtime.environments.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates and forgets a process when initial stdin delivery fails', async () => {
    const container = new InitialInputFailureContainer();
    const registry = createContainerProcessRegistry(
      container,
      container.name,
      1,
    );
    const processes = registry.createHandle('owner', '/app', () => undefined);

    await expect(
      processes.spawn({
        command: 'failing-input',
        args: [],
        input: Buffer.from('input'),
        lifecycle: 'attached',
      }),
    ).rejects.toThrow('initial stdin failed');
    expect(container.signals).toEqual(['SIGTERM']);

    await expect(registry.close()).resolves.toBeUndefined();
    expect(container.signals).toEqual(['SIGTERM']);
  });

  it('reuses a thread recorder across provider recovery tracing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-container-runtime-'));
    const workspace = path.join(root, 'workspace');
    const containerRoot = path.join(root, 'container');
    const rawRoot = path.join(root, 'raw');
    await mkdir(workspace, { recursive: true });
    const runtime = createBenchmarkAgentRuntime({
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
      await runtime.environments.close();
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

class InitialInputFailureContainer extends FakeContainerHandle {
  readonly signals: ContainerProcessSignal[] = [];
  private readonly processExit: Promise<ContainerProcessExit>;
  private finishProcess!: (exit: ContainerProcessExit) => void;

  constructor() {
    super('/tmp', '/tmp');
    this.processExit = new Promise((resolve) => {
      this.finishProcess = resolve;
    });
  }

  override spawn(): Promise<ContainerProcess> {
    return Promise.resolve({
      exit: this.processExit,
      write: () => Promise.reject(new Error('initial stdin failed')),
      closeStdin: () => Promise.resolve(),
      signal: (signal) => {
        this.signals.push(signal);
        this.finishProcess({ exitCode: null, signal, durationMs: 1 });
        return Promise.resolve();
      },
    });
  }
}
