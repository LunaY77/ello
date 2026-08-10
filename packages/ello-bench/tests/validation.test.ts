import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RunManifestSchema,
  SuiteManifestSchema,
} from '../src/domain/contract/index.js';
import { sha256, stableJson } from '../src/domain/hash.js';
import { getBenchmarkSuite } from '../src/infra/corpus/suite.js';
import { writeJsonAtomic } from '../src/infra/io.js';
import { generateSuiteReport } from '../src/infra/report/fs-report.js';
import { normalizeEventCaptureSource } from '../src/infra/rounds.js';
import { validateRunRoot } from '../src/infra/validation/fs-validation.js';

describe('run root validation', () => {
  it('uses the recorded container path space when re-auditing file tools', async () => {
    const fixture = await createFixture();
    const run = JSON.parse(await readFile(fixture.runPath, 'utf8')) as {
      workspace: string;
    };

    expect(run.workspace).not.toBe('/app');
    await expect(validateRunRoot(fixture.runRoot)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('recomputes published reports from terminal attempt evidence', async () => {
    const fixture = await createFixture();

    await expect(validateRunRoot(fixture.runRoot)).resolves.toMatchObject({
      valid: true,
      attempts: 1,
      completed: 1,
      invalid: 0,
      report: true,
    });

    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8')) as {
      scoredJobs: number;
    };
    await writeJsonAtomic(fixture.reportPath, { ...report, scoredJobs: 0 });
    await expect(validateRunRoot(fixture.runRoot)).rejects.toThrow(
      'does not match run evidence',
    );
  });

  it('rejects completed artifacts outside the attempt root', async () => {
    const fixture = await createFixture();
    const run = JSON.parse(await readFile(fixture.runPath, 'utf8')) as {
      patch: { path: string };
    };
    const outsidePatch = path.join(
      await mkdtemp(path.join(tmpdir(), 'ello-bench-outside-')),
      'model.patch',
    );
    await writeFile(outsidePatch, '', 'utf8');
    await writeJsonAtomic(fixture.runPath, {
      ...run,
      patch: { ...run.patch, path: outsidePatch },
    });

    await expect(validateRunRoot(fixture.runRoot)).rejects.toThrow(
      'escapes run root',
    );
  });

  it('rejects Ello runtime provenance with a mismatched prompt mode', async () => {
    const fixture = await createFixture();
    const run = JSON.parse(await readFile(fixture.runPath, 'utf8')) as {
      agentRuntime: { promptMode: 'rapid' | 'thorough' };
    };
    await writeJsonAtomic(fixture.runPath, {
      ...run,
      agentRuntime: { ...run.agentRuntime, promptMode: 'thorough' },
    });

    await expect(validateRunRoot(fixture.runRoot)).rejects.toThrow(
      'Ello runtime provenance mismatch',
    );
  });

  it('accepts a retry created before an interrupted attempt was salvaged', async () => {
    const fixture = await createFixture();
    await appendInvalidRetry(fixture, {
      kind: 'runner',
      phase: 'resume-interrupted-run',
      message: 'Runner stopped while attempt was in state verifying.',
    });
    await generateSuiteReport(fixture.runRoot);

    await expect(validateRunRoot(fixture.runRoot)).resolves.toMatchObject({
      valid: true,
      attempts: 2,
      completed: 1,
      invalid: 1,
    });
  });

  it('rejects an ordinary retry after a completed attempt', async () => {
    const fixture = await createFixture();
    await appendInvalidRetry(fixture, {
      kind: 'runner',
      phase: 'manual-retry',
      message: 'Retry requested after completion.',
    });

    await expect(validateRunRoot(fixture.runRoot)).rejects.toThrow(
      'Attempt follows a completed run',
    );
  });
});

async function appendInvalidRetry(
  fixture: {
    readonly runRoot: string;
    readonly runPath: string;
  },
  retryReason: {
    readonly kind: 'runner';
    readonly phase: string;
    readonly message: string;
  },
): Promise<void> {
  const previous = RunManifestSchema.parse(
    JSON.parse(await readFile(fixture.runPath, 'utf8')) as unknown,
  );
  const attemptId = sha256(`${previous.attemptId}:retry`).slice(0, 24);
  const attemptRoot = path.join(
    path.dirname(path.dirname(fixture.runPath)),
    `attempt-2-${attemptId}`,
  );
  const runPath = path.join(attemptRoot, 'run.json');
  const failure = {
    kind: 'runner' as const,
    phase: 'resume-interrupted-run',
    message: 'Runner stopped while retry was in state preparing.',
  };
  await mkdir(attemptRoot, { recursive: true });
  await writeJsonAtomic(
    runPath,
    RunManifestSchema.parse({
      schema: previous.schema,
      attemptId,
      attempt: 2,
      retryOf: previous.attemptId,
      retryReason,
      job: previous.job,
      configHash: previous.configHash,
      status: 'invalid_infrastructure',
      phase: failure.phase,
      startedAt: '2026-07-23T00:00:03.000Z',
      completedAt: '2026-07-23T00:00:04.000Z',
      attemptRoot,
      workspace: path.join(attemptRoot, 'workspace'),
      agentStateRoot: path.join(attemptRoot, 'agent-state'),
      executionRuntime: 'docker',
      failure,
    }),
  );

  const suitePath = path.join(fixture.runRoot, 'suite-manifest.json');
  const suite = SuiteManifestSchema.parse(
    JSON.parse(await readFile(suitePath, 'utf8')) as unknown,
  );
  await writeJsonAtomic(
    suitePath,
    SuiteManifestSchema.parse({
      ...suite,
      updatedAt: '2026-07-23T00:00:04.000Z',
      attempts: {
        ...suite.attempts,
        [previous.job.jobId]: [fixture.runPath, runPath],
      },
    }),
  );
}

async function createFixture(): Promise<{
  readonly runRoot: string;
  readonly runPath: string;
  readonly reportPath: string;
}> {
  const runRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-validation-'));
  const attemptRoot = path.join(
    runRoot,
    'runs',
    'task-a',
    'ello',
    'r1',
    'attempt',
  );
  const rawRoot = path.join(attemptRoot, 'raw');
  await mkdir(rawRoot, { recursive: true });
  const eventLogPath = path.join(rawRoot, 'engine-events-thr_main.jsonl');
  const identity = {
    runId: 'run-1',
    turnIndex: 0,
    modelCallId: 'call-1',
    agentName: 'build',
    modelSelector: 'primary_model',
    configuredModel: 'benchmark-pro',
    protocol: 'openai',
    apiModel: 'model-pro',
  };
  const eventSource = `${[
    capture(1, 'run.started', {}),
    capture(2, 'turn.started', {}),
    capture(3, 'model.started', {
      occurredAt: '2026-07-23T00:00:00.000Z',
      identity,
      diagnostics: { toolsetFingerprint: 'a'.repeat(64) },
    }),
    capture(4, 'model.completed', {
      occurredAt: '2026-07-23T00:00:01.000Z',
      identity,
      response: {
        finishReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          toolCalls: 0,
        },
      },
    }),
  ]
    .map(JSON.stringify)
    .join('\n')}\n`;
  await writeFile(eventLogPath, eventSource, 'utf8');
  const eventCapture = {
    schema: 'ello.benchmark.event-capture.complete.v1' as const,
    eventLogPath,
    eventCount: 4,
    runCount: 1,
    turnCount: 1,
    modelCallCount: 1,
    sha256: sha256(eventSource),
  };
  await writeJsonAtomic(`${eventLogPath}.complete.json`, eventCapture);

  const roundsPath = path.join(rawRoot, 'rounds.jsonl');
  const normalized = normalizeEventCaptureSource(eventSource, false);
  await writeFile(
    roundsPath,
    `${normalized.rounds.map(JSON.stringify).join('\n')}\n`,
    'utf8',
  );
  const invocationPath = path.join(rawRoot, 'agent-invocation.json');
  const agentStdoutPath = path.join(rawRoot, 'agent-stdout.jsonl');
  const agentStderrPath = path.join(rawRoot, 'agent-stderr.log');
  await Promise.all([
    writeJsonAtomic(invocationPath, {
      schema: 'ello.benchmark.agent-invocation.v1',
      agentId: 'ello',
    }),
    writeFile(agentStdoutPath, '', 'utf8'),
    writeFile(agentStderrPath, '', 'utf8'),
  ]);
  const client = {
    command: 'node',
    args: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 2000,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
  const agentProcessPath = path.join(rawRoot, 'agent-process.json');
  await writeJsonAtomic(agentProcessPath, {
    schema: 'ello.benchmark.agent-process.v1',
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: '2026-07-23T00:00:02.000Z',
    process: client,
    invocation: await fileEvidence(invocationPath),
    stdout: await fileEvidence(agentStdoutPath),
    stderr: await fileEvidence(agentStderrPath),
  });
  const agentProcess = {
    path: agentProcessPath,
    sha256: sha256(await readFile(agentProcessPath)),
  };
  const agentEvidencePath = path.join(rawRoot, 'agent-evidence.json');
  await writeJsonAtomic(agentEvidencePath, {
    schema: 'ello.benchmark.agent-evidence.v1',
    agentId: 'ello',
    kind: 'ello',
    observedModel: 'model-pro',
    terminalStatus: 'completed',
    providerFailure: false,
    parserCoverage: 'complete',
    terminalStopReason: 'stop',
    unknownFields: [],
    rawSource: await fileEvidence(eventLogPath),
    rounds: await fileEvidence(roundsPath),
    roundCount: normalized.rounds.length,
    usage: normalized.usage,
    effectiveTools: {
      enabled: ['command_run'],
      toolsetFingerprint: 'a'.repeat(64),
    },
    threads: [
      {
        threadId: 'thr_main',
        kind: 'main',
        rawSource: await fileEvidence(eventLogPath),
        rounds: await fileEvidence(roundsPath),
        roundCount: normalized.rounds.length,
        usage: normalized.usage,
      },
    ],
    threadUsage: {
      main: normalized.usage,
      subagents: {
        status: 'complete',
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        toolCalls: 0,
      },
      combined: normalized.usage,
    },
    tools: {
      total: 0,
      failed: 0,
      read: 0,
      search: 0,
      edit: 0,
      shell: 0,
      other: 0,
      timeToFirstMutationMs: null,
    },
  });
  const agentEvidence = {
    path: agentEvidencePath,
    sha256: sha256(await readFile(agentEvidencePath)),
  };
  const toolAuditPath = path.join(rawRoot, 'tool-audit.json');
  await writeJsonAtomic(toolAuditPath, {
    schema: 'ello.benchmark.tool-audit.v1',
    status: 'passed',
    parserCoverage: 'complete',
    observedToolCalls: 0,
    shellCalls: 0,
    routedShellCalls: 0,
    fileCalls: 0,
    violations: [],
  });
  const toolAudit = {
    path: toolAuditPath,
    sha256: sha256(await readFile(toolAuditPath)),
  };
  const patchPath = path.join(rawRoot, 'model.patch');
  await writeFile(patchPath, '', 'utf8');
  const patchSha256 = sha256('');
  const stdoutPath = path.join(rawRoot, 'harness', 'stdout.log');
  const stderrPath = path.join(rawRoot, 'harness', 'stderr.log');
  await mkdir(path.dirname(stdoutPath), { recursive: true });
  await Promise.all([
    writeFile(stdoutPath, 'verifier output\n', 'utf8'),
    writeFile(stderrPath, '', 'utf8'),
  ]);
  const verifierProcessPath = path.join(rawRoot, 'harness', 'process.json');
  await writeJsonAtomic(verifierProcessPath, {
    schema: 'ello.benchmark.verifier-process.v1',
    startedAt: '2026-07-23T00:00:01.000Z',
    completedAt: '2026-07-23T00:00:02.000Z',
    process: {
      command: 'docker',
      args: ['run'],
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1000,
      stdoutBytes: Buffer.byteLength('verifier output\n'),
      stderrBytes: 0,
    },
    testResults: { baselineExitCode: 0, newTestsExitCode: 0 },
    stdout: {
      path: stdoutPath,
      sha256: sha256('verifier output\n'),
      bytes: Buffer.byteLength('verifier output\n'),
    },
    stderr: { path: stderrPath, sha256: sha256(''), bytes: 0 },
  });
  const verifierProcess = {
    path: verifierProcessPath,
    sha256: sha256(await readFile(verifierProcessPath)),
  };
  const baselinePreflightProcess = verifierProcess;
  const phaseTimingsPath = path.join(rawRoot, 'phase-timings.json');
  await writeJsonAtomic(phaseTimingsPath, {
    schema: 'ello.benchmark.phase-timings.v1',
    phases: [
      {
        phase: 'agent-running',
        startedAt: '2026-07-23T00:00:00.000Z',
        completedAt: '2026-07-23T00:00:01.000Z',
        durationMs: 1000,
        status: 'completed',
      },
      {
        phase: 'verifier-running',
        startedAt: '2026-07-23T00:00:01.000Z',
        completedAt: '2026-07-23T00:00:02.000Z',
        durationMs: 1000,
        status: 'completed',
      },
    ],
  });
  const harnessPath = path.join(rawRoot, 'harness', 'report.json');
  const harness = {
    schema: 'ello.benchmark.harness.v1' as const,
    taskId: 'task-a',
    status: 'passed' as const,
    reward: 1 as const,
    verifierProcess,
    baselinePreflightProcess,
    baselinePreflightExitCode: 0,
    verifierImage: 'example/image:fixed',
    verifierImageId: 'sha256:image',
    modelPatchSha256: patchSha256,
    appliedPatchSha256: patchSha256,
    verifierCapturedPatchSha256: patchSha256,
    baselineTestExitCode: 0,
    newTestsExitCode: 0,
    hiddenPatchChangedFiles: ['task_test.go'],
    patchConflictFiles: [],
    reportPath: harnessPath,
    completedAt: '2026-07-23T00:00:02.000Z',
  };
  await writeJsonAtomic(harnessPath, harness);

  const agent = elloAgent();
  const agentConfigHash = sha256(stableJson(agent));
  const job = {
    schema: 'ello.benchmark.job.v2' as const,
    jobId: '1111111111111111',
    taskId: 'task-a',
    agentId: 'ello',
    agentConfigHash,
    replicate: 1,
  };
  const run = RunManifestSchema.parse({
    schema: 'ello.benchmark.run.v2',
    attemptId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    attempt: 1,
    job,
    configHash: 'c'.repeat(64),
    status: 'completed',
    phase: 'completed',
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: '2026-07-23T00:00:02.000Z',
    attemptRoot,
    workspace: path.join(attemptRoot, 'workspace'),
    agentStateRoot: path.join(attemptRoot, 'agent-state'),
    agent,
    agentRuntime: {
      schema: 'ello.benchmark.agent-runtime.v1',
      agentId: agent.id,
      displayName: agent.displayName,
      agentConfigHash,
      adapterContractVersion: '2',
      expectedModel: agent.models[agent.primaryModel].apiModel,
      observedModel: agent.models[agent.primaryModel].apiModel,
      configSha256: agentConfigHash,
      kind: agent.kind,
      primaryModel: agent.primaryModel,
      auxiliaryModel: agent.auxiliaryModel,
      promptMode: agent.promptMode,
      enabledTools: ['command_run'],
      toolsetFingerprint: 'a'.repeat(64),
    },
    provenance: {
      scope: 'ello',
      elloRevision: '7'.repeat(40),
      sourceTree: '6'.repeat(40),
      lockfileSha256: '5'.repeat(64),
      nodeVersion: '24.0.0',
      pnpmVersion: '11.0.0',
      platform: 'linux',
      architecture: 'x64',
      packages: { agent: '1.0.0', tui: '1.0.0', bench: '1.0.0' },
    },
    task: resolvedTask(),
    imageId: 'sha256:image',
    containerName: 'ello-bench-agent',
    baselineTree: 'b'.repeat(40),
    client,
    agentProcess,
    agentEvidence,
    toolAudit,
    patch: {
      path: patchPath,
      sha256: patchSha256,
      bytes: 0,
      changedFiles: [],
      baselineTree: 'b'.repeat(40),
    },
    verifierProcess,
    baselinePreflightProcess,
    baselinePreflightExitCode: 0,
    phaseTimingsPath,
    harness,
    outcome: 'passed',
  });
  const runPath = path.join(attemptRoot, 'run.json');
  await writeJsonAtomic(runPath, run);
  const suite = SuiteManifestSchema.parse({
    schema: 'ello.benchmark.suite-manifest.v3',
    suite: getBenchmarkSuite('deep-swe-v1.1').metadata,
    report: {
      schema: 'ello.benchmark.report-config.v2',
      renderCharts: false,
      publishability: {
        requireCompleteMatrix: true,
        requireCompleteUsage: true,
        requireToolAudit: true,
      },
    },
    configHash: run.configHash,
    planHash: '7'.repeat(64),
    agents: [agent],
    selection: { taskIds: ['task-a'], agentIds: ['ello'] },
    runRoot,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:02.000Z',
    jobs: [job],
    attempts: { [job.jobId]: [runPath] },
  });
  await writeJsonAtomic(path.join(runRoot, 'suite-manifest.json'), suite);
  await generateSuiteReport(runRoot);
  return {
    runRoot,
    runPath,
    reportPath: path.join(runRoot, 'results', 'suite-report.json'),
  };
}

function capture(
  sequence: number,
  event: string,
  payload: Record<string, unknown>,
) {
  return {
    schema: 'ello.benchmark.event-capture.v1',
    sequence,
    event,
    payload,
  };
}

function elloAgent() {
  return {
    id: 'ello',
    displayName: 'Ello',
    kind: 'ello' as const,
    models: {
      'benchmark-pro': {
        protocol: 'openai' as const,
        endpoint: 'responses' as const,
        apiModel: 'model-pro',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        contextWindow: 128000,
        maxOutputTokens: 16000,
        reasoningEffort: 'medium' as const,
      },
      'benchmark-flash': {
        protocol: 'openai' as const,
        endpoint: 'responses' as const,
        apiModel: 'model-flash',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        contextWindow: 128000,
        maxOutputTokens: 8000,
        reasoningEffort: 'low' as const,
      },
    },
    primaryModel: 'benchmark-pro',
    auxiliaryModel: 'benchmark-flash',
    promptMode: 'rapid' as const,
    features: {
      subagents: false,
    },
  };
}

function resolvedTask() {
  return {
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
    agentTimeoutMs: 1000,
    verifierTimeoutMs: 1000,
    environment: {
      image: 'example/image:fixed',
      allowInternet: false,
      buildTimeoutMs: 1000,
      cpus: 1,
      memoryMb: 1024,
      storageMb: 1024,
    },
    instructionSha256: 'e'.repeat(64),
    verifierScriptSha256: 'f'.repeat(64),
    verifierPatchSha256: '0'.repeat(64),
  };
}

async function fileEvidence(filePath: string) {
  const content = await readFile(filePath);
  return {
    path: filePath,
    sha256: sha256(content),
    bytes: content.byteLength,
  };
}
