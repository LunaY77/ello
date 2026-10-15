import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunManifest } from '../src/domain/contract/index.js';
import { createPlan, selectAll } from '../src/domain/suite/plan.js';
import { loadBenchmarkConfig } from '../src/infra/config/toml-loader.js';
import { repairRunRoot } from '../src/infra/repair.js';
import {
  openSuiteManifest,
  selectAttempt,
  transitionRun,
} from '../src/infra/run-state.js';

import { EXAMPLE_CONFIG_PATH } from './example-config.js';

describe('interrupted attempt salvage', () => {
  it('completes an interrupted attempt whose verdict already landed', async () => {
    const { opened, job, attempt } = await interruptedAttempt();

    const resumed = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 3,
    });

    // 判决已经落盘，resume 必须收割它，而不是作废后重跑 agent。
    expect(resumed.skipReason).toBe('completed');
    expect(resumed.run).toBeUndefined();
    const salvaged = await readRun(attempt.attemptRoot);
    expect(salvaged.status).toBe('completed');
    expect(salvaged.phase).toBe('completed');
    expect(salvaged.harness?.reward).toBe(1);
    expect(salvaged.outcome).toBe('passed');
    expect(salvaged.failure).toBeUndefined();
    expect(salvaged.verifierProcess?.path).toContain('verifier-process.json');
  });

  it('still invalidates and retries when no verdict landed', async () => {
    const { opened, job, attempt } = await interruptedAttempt({
      writeReport: false,
    });

    const resumed = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 3,
    });

    expect(resumed.skipReason).toBeUndefined();
    expect(resumed.run?.attempt).toBe(2);
    const invalidated = await readRun(attempt.attemptRoot);
    expect(invalidated.status).toBe('invalid_infrastructure');
    expect(invalidated.phase).toBe('resume-interrupted-run');
  });

  it('refuses a verdict that does not match the captured patch', async () => {
    const { opened, job, attempt } = await interruptedAttempt({
      reportPatchSha256: 'f'.repeat(64),
    });

    const resumed = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 3,
    });

    expect(resumed.run?.attempt).toBe(2);
    expect((await readRun(attempt.attemptRoot)).status).toBe(
      'invalid_infrastructure',
    );
  });

  it('reports repairable attempts without writing unless applied', async () => {
    const { opened, job, attempt } = await interruptedAttempt();
    const runRoot = opened.manifest.runRoot;

    const dryRun = await repairRunRoot({ runRoot, apply: false });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.repaired).toHaveLength(1);
    expect(dryRun.repaired[0]).toMatchObject({
      taskId: job.taskId,
      agentId: job.agentId,
      reward: 1,
      outcome: 'passed',
      previousStatus: 'verifying',
    });
    // 干跑不能改动任何东西
    expect((await readRun(attempt.attemptRoot)).status).toBe('verifying');

    const applied = await repairRunRoot({ runRoot, apply: true });
    expect(applied.repaired).toHaveLength(1);
    expect((await readRun(attempt.attemptRoot)).status).toBe('completed');

    // 幂等：改完再跑一次不应再有可修的
    const again = await repairRunRoot({ runRoot, apply: true });
    expect(again.repaired).toHaveLength(0);
  });

  it('skips a job whose earlier attempt was salvaged, and closes the dead one', async () => {
    // 打断 -> 未收割 -> 开出 attempt 2；随后 attempt 1 的判决才被收割。
    const { opened, job, attempt } = await interruptedAttempt({
      writeReport: false,
    });
    const retry = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 3,
    });
    expect(retry.run?.attempt).toBe(2);
    await writeReportFor(attempt.attemptRoot, job.taskId, 'a'.repeat(64));
    await writeFile(
      path.join(attempt.attemptRoot, 'run.json'),
      JSON.stringify(
        { ...attempt, status: 'verifying', phase: 'verifier-running' },
        null,
        2,
      ),
    );

    const result = await repairRunRoot({
      runRoot: opened.manifest.runRoot,
      apply: true,
    });
    expect(result.repaired).toHaveLength(1);
    // attempt 2 不会再被执行，必须被收尾，否则 validate 会报 not terminal
    expect(result.closed).toEqual([
      expect.objectContaining({ taskId: job.taskId, attempt: 2 }),
    ]);

    const after = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 3,
    });
    expect(after.skipReason).toBe('completed');
    expect(after.run).toBeUndefined();
  });

  it('lists attempts that need a verifier rerun as unsalvageable', async () => {
    const { opened } = await interruptedAttempt({ writeReport: false });

    const result = await repairRunRoot({
      runRoot: opened.manifest.runRoot,
      apply: false,
    });

    expect(result.repaired).toHaveLength(0);
    expect(result.unsalvageable[0]?.reason).toContain('verifier');
  });
});

async function interruptedAttempt(
  options: {
    readonly writeReport?: boolean;
    readonly reportPatchSha256?: string;
  } = {},
) {
  const runRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-salvage-'));
  const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);
  const plan = createPlan(config, selectAll(config));
  const opened = await openSuiteManifest({ runRoot, config, plan });
  const job = plan.jobs[0];
  if (job === undefined) throw new Error('Missing planned job.');
  const selected = await selectAttempt({
    suitePath: opened.path,
    suite: opened.manifest,
    job,
    maxInfrastructureRetries: 3,
  });
  if (selected.run === undefined) throw new Error('Missing attempt.');

  const patchSha256 = 'a'.repeat(64);
  const harnessRoot = path.join(selected.run.attemptRoot, 'raw', 'harness');
  await mkdir(harnessRoot, { recursive: true });
  const agentProcessPath = path.join(
    selected.run.attemptRoot,
    'raw',
    'agent',
    'process.json',
  );
  await mkdir(path.dirname(agentProcessPath), { recursive: true });
  await writeFile(
    agentProcessPath,
    JSON.stringify(agentProcessArtifact(), null, 2),
  );
  const patchPath = path.join(selected.run.attemptRoot, 'raw', 'model.patch');
  await writeFile(patchPath, 'diff --git a/a.txt b/a.txt\n');

  const preparing = await transitionRun(selected.run, 'preparing', {
    phase: 'prepare-workspace',
    startedAt: new Date().toISOString(),
    ...completionEvidence(selected.run.attemptRoot, agentProcessPath),
  });
  const running = await transitionRun(preparing, 'running', {
    phase: 'agent-running',
    agentProcess: { path: agentProcessPath, sha256: 'b'.repeat(64) },
  });
  const capturing = await transitionRun(running, 'capturing', {
    phase: 'capture-patch',
  });
  // 停在 verifying：正是 runner 被 OOM/重启打断时的状态
  const attempt = await transitionRun(capturing, 'verifying', {
    phase: 'verifier-running',
    patch: {
      path: patchPath,
      sha256: patchSha256,
      bytes: 26,
      changedFiles: ['a.txt'],
      baselineTree: 'c'.repeat(40),
    },
  });

  if (options.writeReport !== false) {
    await writeReportFor(
      selected.run.attemptRoot,
      job.taskId,
      options.reportPatchSha256 ?? patchSha256,
    );
  }
  return { opened, job, attempt };
}

async function writeReportFor(
  attemptRoot: string,
  taskId: string,
  modelPatchSha256: string,
): Promise<void> {
  const harnessRoot = path.join(attemptRoot, 'raw', 'harness');
  await mkdir(harnessRoot, { recursive: true });
  const reportPath = path.join(harnessRoot, 'report.json');
  const verifierProcessPath = path.join(harnessRoot, 'verifier-process.json');
  await writeFile(verifierProcessPath, JSON.stringify({ ok: true }));
  await writeFile(
    reportPath,
    JSON.stringify(
      harnessReport({
        taskId,
        reportPath,
        verifierProcessPath,
        modelPatchSha256,
      }),
      null,
      2,
    ),
  );
}

/**
 * RunManifestSchema 对 completed 有完整性约束。收割逻辑只有在 attempt 真的攒齐
 * 这些证据时才允许把它记成 completed，所以 fixture 必须把它们都带上。
 */
function completionEvidence(attemptRoot: string, agentProcessPath: string) {
  const agent = {
    id: 'ello',
    displayName: 'Ello',
    kind: 'ello' as const,
    models: {
      primary: {
        protocol: 'openai' as const,
        endpoint: 'responses' as const,
        apiModel: 'model',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'API_KEY',
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        reasoningEffort: 'high' as const,
      },
    },
    primaryModel: 'primary',
    auxiliaryModel: 'primary',
    features: { subagents: false },
  };
  const client = {
    command: '/opt/ello-agent/ello',
    args: ['--print'],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1000,
    stdoutBytes: 10,
    stderrBytes: 0,
  };
  return {
    task: {
      schema: 'ello.benchmark.resolved-task.v2' as const,
      benchmark: 'deep-swe' as const,
      taskId: 'task-a',
      extId: 'external',
      displayTitle: 'Task',
      displayDescription: 'Description',
      originalTitle: 'Original',
      category: 'feature_request',
      language: 'go' as const,
      repositoryUrl: 'https://github.com/example/project',
      baseCommitHash: 'd'.repeat(40),
      agentTimeoutMs: 1_000,
      verifierTimeoutMs: 1_000,
      environment: {
        image: 'example/image:fixed',
        allowInternet: false,
        buildTimeoutMs: 1_000,
        cpus: 1,
        memoryMb: 1_024,
        storageMb: 1_024,
      },
      instructionSha256: 'e'.repeat(64),
      verifierScriptSha256: 'f'.repeat(64),
      verifierPatchSha256: '0'.repeat(64),
    },
    agent,
    agentRuntime: {
      schema: 'ello.benchmark.agent-runtime.v1' as const,
      agentId: agent.id,
      displayName: agent.displayName,
      agentConfigHash: '1'.repeat(64),
      configSha256: '7'.repeat(64),
      adapterContractVersion: '2' as const,
      kind: 'ello' as const,
      expectedModel: 'model',
      observedModel: 'model',
      primaryModel: 'primary',
      auxiliaryModel: 'primary',
      promptMode: 'thorough' as const,
      enabledTools: ['command_run'] as ['command_run'],
      toolsetFingerprint: '8'.repeat(64),
    },
    provenance: {
      scope: 'ello' as const,
      elloRevision: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      lockfileSha256: '3'.repeat(64),
      nodeVersion: '24.0.0',
      pnpmVersion: '11.0.0',
      platform: 'linux',
      architecture: 'x64',
      packages: { agent: '1', tui: '1', bench: '1' },
    },
    client,
    agentEvidence: {
      path: `${agentProcessPath}.evidence`,
      sha256: '4'.repeat(64),
    },
    toolAudit: { path: `${agentProcessPath}.tools`, sha256: '5'.repeat(64) },
    phaseTimingsPath: path.join(attemptRoot, 'raw', 'phase-timings.json'),
    imageId: `sha256:${'6'.repeat(64)}`,
    containerName: 'ello-bench-fixture-agent',
    baselineTree: 'c'.repeat(40),
  };
}

function agentProcessArtifact() {
  return {
    schema: 'ello.benchmark.agent-process.v1',
    startedAt: '2026-08-09T02:43:40.062Z',
    completedAt: '2026-08-09T03:18:21.795Z',
    process: {
      command: '/opt/ello-agent/claude-code',
      args: ['--print'],
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1000,
      stdoutBytes: 10,
      stderrBytes: 0,
    },
    invocation: {
      path: '/tmp/invocation.json',
      sha256: 'd'.repeat(64),
      bytes: 2,
    },
    stdout: { path: '/tmp/stdout.log', sha256: 'e'.repeat(64), bytes: 10 },
    stderr: { path: '/tmp/stderr.log', sha256: 'f'.repeat(64), bytes: 0 },
  };
}

function harnessReport(options: {
  readonly taskId: string;
  readonly reportPath: string;
  readonly verifierProcessPath: string;
  readonly modelPatchSha256: string;
}) {
  const sha = '0'.repeat(64);
  return {
    schema: 'ello.benchmark.harness.v1',
    taskId: options.taskId,
    status: 'passed',
    reward: 1,
    verifierProcess: {
      path: options.verifierProcessPath,
      sha256: sha,
    },
    verifierRuntime: 'docker',
    verifierImage: 'example/image:tag',
    verifierImageId: `sha256:${sha}`,
    modelPatchSha256: options.modelPatchSha256,
    appliedPatchSha256: options.modelPatchSha256,
    verifierCapturedPatchSha256: options.modelPatchSha256,
    verifierGeneratedPatchSha256: null,
    baselineTestExitCode: 0,
    newTestsExitCode: 0,
    hiddenPatchChangedFiles: ['a_test.txt'],
    patchConflictFiles: [],
    modelPatchChangedFiles: ['a.txt'],
    verifierAssertions: [
      {
        id: 'reward',
        scope: 'reward',
        status: 'passed',
        exitCode: null,
        source: 'harness',
      },
    ],
    lastAgentVerificationRound: 3,
    reportPath: options.reportPath,
    completedAt: '2026-08-09T04:05:26.985Z',
  };
}

async function readRun(attemptRoot: string): Promise<RunManifest> {
  const { readJsonFile } = await import('../src/infra/io.js');
  const { RunManifestSchema } = await import('../src/domain/contract/index.js');
  return readJsonFile(path.join(attemptRoot, 'run.json'), RunManifestSchema);
}
