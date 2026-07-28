import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentRunContext } from '../src/agents/adapter.js';
import { auditExternalTools } from '../src/agents/routing-audit.js';
import { createRuntimeBoundaryInstruction } from '../src/agents/runtime-boundary.js';
import type { NormalizedToolCall } from '../src/contracts.js';
import { createBenchmarkAgentRuntime } from '../src/runtime.js';

describe('local benchmark runtime boundary', () => {
  it('instructs external Agents to use the host workspace without Docker', () => {
    const boundary = createRuntimeBoundaryInstruction({
      runtime: 'local',
      workspace: '/tmp/benchmark-workspace',
    } as AgentRunContext);

    expect(boundary).toContain('directly in the current workspace on the host');
    expect(boundary).toContain('Do not use Docker');
    expect(boundary).not.toContain('docker exec');
  });

  it('accepts direct shell calls and rejects Docker calls', () => {
    const direct = auditExternalTools({
      runtime: 'local',
      workspace: '/tmp/benchmark-workspace',
      parserCoverage: 'complete',
      tools: [shellTool('git status')],
    });
    const docker = auditExternalTools({
      runtime: 'local',
      workspace: '/tmp/benchmark-workspace',
      parserCoverage: 'complete',
      tools: [shellTool('docker exec task bash -c "git status"')],
    });
    const absoluteDocker = auditExternalTools({
      runtime: 'local',
      workspace: '/tmp/benchmark-workspace',
      parserCoverage: 'complete',
      tools: [shellTool('/usr/local/bin/docker-compose up')],
    });

    expect(direct).toMatchObject({
      status: 'passed',
      shellCalls: 1,
      routedShellCalls: 1,
    });
    expect(docker.status).toBe('failed');
    expect(docker.violations).toEqual([
      expect.objectContaining({ kind: 'docker_shell' }),
    ]);
    expect(absoluteDocker.status).toBe('failed');
  });

  it('gives Ello a direct host shell scoped to the workspace', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ello-local-runtime-'));
    const runtime = createBenchmarkAgentRuntime({
      runtime: 'local',
      workspace,
      rawRoot: path.join(workspace, 'raw'),
    });
    const environment = runtime.createEnvironment({
      config: { cwd: workspace },
    } as unknown as Parameters<typeof runtime.createEnvironment>[0]);

    const result = await environment.shell.run(
      'printf "local runtime\\n" > ello-output.txt',
    );
    await environment.close?.();

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await readFile(path.join(workspace, 'ello-output.txt'), 'utf8')).toBe(
      'local runtime\n',
    );
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
