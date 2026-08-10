import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HarnessReportSchema,
  RunManifestSchema,
  SuiteManifestSchema,
} from '../src/domain/contract/index.js';
import { sha256, stableJson } from '../src/domain/hash.js';
import { classifyAttempt } from '../src/domain/scoring/attempt-outcome.js';
import { getBenchmarkSuite } from '../src/infra/corpus/suite.js';
import { writeJsonAtomic } from '../src/infra/io.js';
import { generateSuiteReport } from '../src/infra/report/fs-report.js';

describe('suite report', () => {
  it('separates valid results from infrastructure failures', async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-report-'));
    const completedPath = path.join(runRoot, 'run-completed.json');
    const invalidPath = path.join(runRoot, 'run-invalid.json');
    const roundsPath = path.join(runRoot, 'rounds.jsonl');
    const phaseTimingsPath = path.join(runRoot, 'phase-timings.json');
    await writeFile(
      roundsPath,
      `${JSON.stringify({
        schema: 'ello.benchmark.round.v2',
        round: 1,
        requestId: 'call-1',
        provider: 'openai',
        model: 'model',
        startedAt: '2026-07-23T00:00:00.000Z',
        firstTokenAt: null,
        completedAt: '2026-07-23T00:00:01.000Z',
        status: 'completed',
        finishReason: 'stop',
        usage: {
          status: 'complete',
          requests: 1,
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          toolCalls: 0,
        },
        toolCalls: [],
        durationMs: 1000,
        firstTokenLatencyMs: null,
      })}\n`,
      'utf8',
    );
    await writeJsonAtomic(phaseTimingsPath, {
      schema: 'ello.benchmark.phase-timings.v1',
      phases: [
        {
          phase: 'agent-running',
          startedAt: '2026-07-23T00:00:00.000Z',
          completedAt: '2026-07-23T00:00:02.000Z',
          durationMs: 2000,
          status: 'completed',
        },
      ],
    });
    const verifierProcess = {
      path: path.join(runRoot, 'verifier-process.json'),
      sha256: '2'.repeat(64),
    };
    const agentEvidencePath = path.join(runRoot, 'agent-evidence.json');
    const roundsContent = await readFile(roundsPath);
    await writeJsonAtomic(agentEvidencePath, {
      schema: 'ello.benchmark.agent-evidence.v1',
      agentId: 'ello',
      kind: 'ello',
      observedModel: 'model',
      terminalStatus: 'completed',
      providerFailure: false,
      parserCoverage: 'complete',
      terminalStopReason: null,
      unknownFields: [],
      rawSource: {
        path: path.join(runRoot, 'events.jsonl'),
        sha256: sha256(''),
        bytes: 0,
      },
      rounds: {
        path: roundsPath,
        sha256: sha256(roundsContent),
        bytes: roundsContent.byteLength,
      },
      roundCount: 1,
      usage: {
        status: 'complete',
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        toolCalls: 0,
      },
      threads: [
        {
          threadId: 'thr_main',
          kind: 'main',
          rawSource: {
            path: path.join(runRoot, 'events.jsonl'),
            sha256: sha256(''),
            bytes: 0,
          },
          rounds: {
            path: roundsPath,
            sha256: sha256(roundsContent),
            bytes: roundsContent.byteLength,
          },
          roundCount: 1,
          usage: {
            status: 'complete',
            requests: 1,
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            toolCalls: 0,
          },
        },
      ],
      threadUsage: {
        main: {
          status: 'complete',
          requests: 1,
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          toolCalls: 0,
        },
        subagents: zeroUsage(),
        combined: {
          status: 'complete',
          requests: 1,
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          toolCalls: 0,
        },
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
    const toolAuditPath = path.join(runRoot, 'tool-audit.json');
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
    const completed = RunManifestSchema.parse({
      ...baseRun(
        runRoot,
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        '1111111111111111',
        'task-a',
        'ello',
      ),
      status: 'completed',
      phase: 'completed',
      startedAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:00:02.000Z',
      task: resolvedTask('task-a'),
      imageId: 'sha256:image',
      containerName: 'ello-bench-agent',
      baselineTree: 'b'.repeat(40),
      client: processResult(2000),
      agentRuntime: elloRuntime(),
      agentProcess: {
        path: path.join(runRoot, 'agent-process.json'),
        sha256: '3'.repeat(64),
      },
      agentEvidence: {
        path: agentEvidencePath,
        sha256: sha256(await readFile(agentEvidencePath)),
      },
      toolAudit: {
        path: toolAuditPath,
        sha256: sha256(await readFile(toolAuditPath)),
      },
      patch: {
        path: path.join(runRoot, 'model.patch'),
        sha256: 'a'.repeat(64),
        bytes: 0,
        changedFiles: [],
        baselineTree: 'b'.repeat(40),
      },
      verifierProcess,
      phaseTimingsPath,
      harness: {
        schema: 'ello.benchmark.harness.v1',
        taskId: 'task-a',
        status: 'passed',
        reward: 1,
        verifierProcess,
        verifierImage: 'example/image:fixed',
        verifierImageId: 'sha256:image',
        modelPatchSha256: 'a'.repeat(64),
        appliedPatchSha256: 'a'.repeat(64),
        verifierCapturedPatchSha256: 'a'.repeat(64),
        baselineTestExitCode: 0,
        newTestsExitCode: 0,
        hiddenPatchChangedFiles: ['task_test.go'],
        patchConflictFiles: [],
        reportPath: path.join(runRoot, 'harness.json'),
        completedAt: '2026-07-23T00:00:02.000Z',
      },
      outcome: 'passed',
    });
    const invalid = RunManifestSchema.parse({
      ...baseRun(
        runRoot,
        'bbbbbbbbbbbbbbbbbbbbbbbb',
        '2222222222222222',
        'task-b',
        'claude-code',
      ),
      status: 'invalid_infrastructure',
      phase: 'prepare-workspace',
      startedAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:00:01.000Z',
      failure: {
        kind: 'container',
        phase: 'prepare-workspace',
        message: 'container unavailable',
      },
    });
    await Promise.all([
      writeJsonAtomic(completedPath, completed),
      writeJsonAtomic(invalidPath, invalid),
    ]);
    const suite = SuiteManifestSchema.parse({
      schema: 'ello.benchmark.suite-manifest.v3',
      suite: getBenchmarkSuite('swe-bench-pro-calibration').metadata,
      report: reportConfig(),
      configHash: 'c'.repeat(64),
      planHash: '7'.repeat(64),
      agents: [elloAgent(), claudeCodeAgent()],
      selection: {
        taskIds: ['task-a', 'task-b'],
        agentIds: ['ello', 'claude-code'],
      },
      runRoot,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:02.000Z',
      jobs: [completed.job, invalid.job],
      attempts: {
        [completed.job.jobId]: [completedPath],
        [invalid.job.jobId]: [invalidPath],
      },
    });
    await writeJsonAtomic(path.join(runRoot, 'suite-manifest.json'), suite);

    const report = await generateSuiteReport(runRoot);

    expect(report).toMatchObject({
      suite: {
        benchmarkId: 'ello.benchmark.swe-bench-pro.calibration',
        selectedTaskCount: 30,
        upstreamTaskCount: 731,
      },
      plannedJobs: 2,
      scoredJobs: 1,
      invalidJobs: 1,
      publishable: false,
    });
    expect(report.agents[0]?.resources.rounds).toEqual({
      count: 1,
      mean: 1,
      median: 1,
      p95: 1,
    });
    expect(report.agents[0]?.resources).toMatchObject({
      inputTokens: { median: 10 },
      nonCachedInputTokens: { median: 10 },
      cacheReadTokens: { median: 0 },
      cacheWriteTokens: { median: 0 },
      cacheHitRate: { median: 0 },
      outputTokens: { median: 4 },
      reasoningTokens: { median: 0 },
    });
    expect(report.agents[0]?.resources.phaseElapsedMs['agent-running']).toEqual(
      {
        count: 1,
        mean: 2000,
        median: 2000,
        p95: 2000,
      },
    );
    expect(report.comparisons[0]).toMatchObject({
      leftAgentId: 'ello',
      rightAgentId: 'claude-code',
      matchedRuns: 0,
      excludedPairs: 2,
    });
  });

  it('rebuilds Claude usage from terminal totals and unique message ids', async () => {
    const runRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-claude-report-'),
    );
    const rawPath = path.join(runRoot, 'stdout.jsonl');
    const roundsPath = path.join(runRoot, 'rounds.jsonl');
    const phaseTimingsPath = path.join(runRoot, 'phase-timings.json');
    const firstUsage = {
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    };
    const secondUsage = {
      input_tokens: 20,
      output_tokens: 0,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
    };
    const rawContent = [
      claudeAssistantRecord('msg-1', firstUsage, 'thinking'),
      claudeAssistantRecord('msg-1', firstUsage, 'text'),
      claudeAssistantRecord('msg-2', secondUsage, 'text'),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'session-1',
        usage: {
          input_tokens: 30,
          output_tokens: 11,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 7,
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
      .concat('\n');
    const duplicateRounds = [
      externalRound(1, 'msg-1', 13, 2, 1),
      externalRound(2, 'msg-1', 13, 2, 1),
      externalRound(3, 'msg-2', 28, 5, 3),
    ];
    const roundsContent = duplicateRounds
      .map((round) => JSON.stringify(round))
      .join('\n')
      .concat('\n');
    await Promise.all([
      writeFile(rawPath, rawContent, 'utf8'),
      writeFile(roundsPath, roundsContent, 'utf8'),
      writeJsonAtomic(phaseTimingsPath, {
        schema: 'ello.benchmark.phase-timings.v1',
        phases: [
          {
            phase: 'agent-running',
            startedAt: '2026-07-23T00:00:00.000Z',
            completedAt: '2026-07-23T00:00:02.000Z',
            durationMs: 2000,
            status: 'completed',
          },
        ],
      }),
    ]);
    const evidencePath = path.join(runRoot, 'agent-evidence.json');
    await writeJsonAtomic(evidencePath, {
      schema: 'ello.benchmark.agent-evidence.v1',
      agentId: 'claude-code',
      kind: 'claude-code',
      observedModel: 'claude-opus-4-6[1m]',
      terminalStatus: 'completed',
      providerFailure: false,
      parserCoverage: 'complete',
      terminalStopReason: 'end_turn',
      unknownFields: [],
      rawSource: fileEvidence(rawPath, rawContent),
      rounds: fileEvidence(roundsPath, roundsContent),
      roundCount: 3,
      // This deliberately preserves the old fragment-level overcount. Report
      // generation must prefer the terminal totals in the raw Claude stream.
      usage: {
        status: 'complete',
        requests: 3,
        inputTokens: 54,
        outputTokens: 0,
        cacheReadTokens: 9,
        cacheWriteTokens: 5,
        reasoningTokens: null,
        toolCalls: 0,
      },
      tools: zeroToolSummary(),
    });
    const toolAuditPath = path.join(runRoot, 'tool-audit.json');
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
    const verifierProcess = {
      path: path.join(runRoot, 'verifier-process.json'),
      sha256: '2'.repeat(64),
    };
    const completed = RunManifestSchema.parse({
      ...baseRun(
        runRoot,
        'cccccccccccccccccccccccc',
        '3333333333333333',
        'task-a',
        'claude-code',
      ),
      status: 'completed',
      phase: 'completed',
      startedAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:00:02.000Z',
      task: resolvedTask('task-a'),
      imageId: 'sha256:image',
      containerName: 'ello-bench-agent',
      baselineTree: 'b'.repeat(40),
      client: processResult(2000),
      agentRuntime: claudeRuntime(),
      agentProcess: {
        path: path.join(runRoot, 'agent-process.json'),
        sha256: '3'.repeat(64),
      },
      agentEvidence: {
        path: evidencePath,
        sha256: sha256(await readFile(evidencePath)),
      },
      toolAudit: {
        path: toolAuditPath,
        sha256: sha256(await readFile(toolAuditPath)),
      },
      patch: {
        path: path.join(runRoot, 'model.patch'),
        sha256: 'a'.repeat(64),
        bytes: 0,
        changedFiles: [],
        baselineTree: 'b'.repeat(40),
      },
      verifierProcess,
      phaseTimingsPath,
      harness: harnessReport(runRoot, verifierProcess, 1),
      outcome: 'passed',
    });
    const attemptPath = path.join(runRoot, 'run-completed.json');
    await writeJsonAtomic(attemptPath, completed);
    await writeJsonAtomic(
      path.join(runRoot, 'suite-manifest.json'),
      SuiteManifestSchema.parse({
        schema: 'ello.benchmark.suite-manifest.v3',
        suite: getBenchmarkSuite('swe-bench-pro-calibration').metadata,
        report: reportConfig(),
        configHash: 'c'.repeat(64),
        planHash: '7'.repeat(64),
        agents: [claudeCodeAgent()],
        selection: {
          taskIds: ['task-a'],
          agentIds: ['claude-code'],
        },
        runRoot,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:02.000Z',
        jobs: [completed.job],
        attempts: { [completed.job.jobId]: [attemptPath] },
      }),
    );

    const report = await generateSuiteReport(runRoot);

    expect(report.agents[0]?.resources).toMatchObject({
      rounds: { mean: 2, median: 2 },
      inputTokens: { mean: 41, median: 41 },
      nonCachedInputTokens: { median: 34 },
      cacheReadTokens: { median: 7 },
      cacheWriteTokens: { median: 4 },
      cacheHitRate: { median: 7 / 41 },
      outputTokens: { median: 11 },
      reasoningTokens: { count: 0, mean: null, median: null, p95: null },
    });
    expect(report.agents[0]?.tasks[0]?.resources).toMatchObject({
      rounds: { mean: 2, median: 2 },
      inputTokens: { mean: 41, median: 41 },
    });
  });
});

describe('evidence degradation', () => {
  it('scores a run whose evidence could not be normalized', async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-degraded-'));
    const attemptPath = path.join(runRoot, 'run-degraded.json');
    const phaseTimingsPath = path.join(runRoot, 'phase-timings.json');
    await writeJsonAtomic(phaseTimingsPath, {
      schema: 'ello.benchmark.phase-timings.v1',
      phases: [
        {
          phase: 'agent-running',
          startedAt: '2026-07-23T00:00:00.000Z',
          completedAt: '2026-07-23T00:00:02.000Z',
          durationMs: 2000,
          status: 'completed',
        },
      ],
    });
    const verifierProcess = {
      path: path.join(runRoot, 'verifier-process.json'),
      sha256: '2'.repeat(64),
    };
    const degraded = RunManifestSchema.parse({
      ...baseRun(
        runRoot,
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        '1111111111111111',
        'task-a',
        'ello',
      ),
      status: 'completed',
      phase: 'completed',
      startedAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:00:02.000Z',
      task: resolvedTask('task-a'),
      imageId: 'sha256:image',
      containerName: 'ello-bench-agent',
      baselineTree: 'b'.repeat(40),
      client: processResult(2000),
      agentProcess: {
        path: path.join(runRoot, 'agent-process.json'),
        sha256: '3'.repeat(64),
      },
      patch: {
        path: path.join(runRoot, 'model.patch'),
        sha256: 'a'.repeat(64),
        bytes: 0,
        changedFiles: [],
        baselineTree: 'b'.repeat(40),
      },
      verifierProcess,
      phaseTimingsPath,
      harness: harnessReport(runRoot, verifierProcess, 1),
      outcome: 'passed',
      evidenceDegradation: {
        phase: 'normalize-agent-evidence',
        message: 'Claude stop reason must be a string.',
      },
    });
    await writeJsonAtomic(attemptPath, degraded);
    await writeJsonAtomic(
      path.join(runRoot, 'suite-manifest.json'),
      SuiteManifestSchema.parse({
        schema: 'ello.benchmark.suite-manifest.v3',
        suite: getBenchmarkSuite('deep-swe-v1.1').metadata,
        report: relaxedReportConfig(),
        configHash: 'c'.repeat(64),
        planHash: '7'.repeat(64),
        agents: [elloAgent()],
        selection: { taskIds: ['task-a'], agentIds: ['ello'] },
        runRoot,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:02.000Z',
        jobs: [degraded.job],
        attempts: { [degraded.job.jobId]: [attemptPath] },
      }),
    );

    const report = await generateSuiteReport(runRoot);

    expect(report).toMatchObject({
      scoredJobs: 1,
      invalidJobs: 0,
      publishable: true,
    });
    const agent = report.agents[0];
    expect(agent?.validRuns).toBe(1);
    expect(agent?.passedRuns).toBe(1);
    expect(agent?.passRate).toBe(1);
    expect(agent?.resources.outputTokens).toEqual({
      count: 0,
      mean: null,
      median: null,
      p95: null,
    });
    expect(agent?.evidenceCoverage).toEqual({
      usageCompleteRuns: 0,
      usageUnavailableRuns: 0,
      toolAuditPassedRuns: 0,
    });
  });

  it('rejects a completed run that lost evidence without saying so', () => {
    expect(() =>
      RunManifestSchema.parse({
        ...baseRun(
          '/tmp/x',
          'aaaaaaaaaaaaaaaaaaaaaaaa',
          '1111111111111111',
          'task-a',
          'ello',
        ),
        status: 'completed',
        phase: 'completed',
        startedAt: '2026-07-23T00:00:00.000Z',
        completedAt: '2026-07-23T00:00:02.000Z',
        task: resolvedTask('task-a'),
        imageId: 'sha256:image',
        containerName: 'ello-bench-agent',
        baselineTree: 'b'.repeat(40),
        client: processResult(2000),
        agentProcess: { path: '/tmp/x/p.json', sha256: '3'.repeat(64) },
        patch: {
          path: '/tmp/x/model.patch',
          sha256: 'a'.repeat(64),
          bytes: 0,
          changedFiles: [],
          baselineTree: 'b'.repeat(40),
        },
        verifierProcess: { path: '/tmp/x/v.json', sha256: '2'.repeat(64) },
        phaseTimingsPath: '/tmp/x/t.json',
        harness: harnessReport(
          '/tmp/x',
          { path: '/tmp/x/v.json', sha256: '2'.repeat(64) },
          1,
        ),
        outcome: 'passed',
      }),
    ).toThrow('Completed run requires agentEvidence');
  });

  it('allows invalidity and evidence degradation to remain orthogonal', () => {
    const invalid = RunManifestSchema.parse({
      ...baseRun(
        '/tmp/x',
        'bbbbbbbbbbbbbbbbbbbbbbbb',
        '2222222222222222',
        'task-a',
        'ello',
      ),
      status: 'invalid_infrastructure',
      phase: 'prepare-workspace',
      startedAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:00:01.000Z',
      failure: {
        kind: 'container',
        phase: 'prepare-workspace',
        message: 'container unavailable',
      },
      evidenceDegradation: {
        phase: 'normalize-agent-evidence',
        message: 'parser failed',
      },
    });

    expect(invalid).toMatchObject({
      status: 'invalid_infrastructure',
      evidenceDegradation: { phase: 'normalize-agent-evidence' },
    });
  });
});

describe('attempt classification', () => {
  it('scores a post-patch baseline regression instead of invalidating infrastructure', () => {
    const harness = HarnessReportSchema.parse({
      ...harnessReport(
        '/tmp/x',
        { path: '/tmp/x/verifier.json', sha256: '2'.repeat(64) },
        0,
      ),
      baselineTestExitCode: 127,
      newTestsExitCode: 1,
    });

    expect(classifyAttempt(harness)).toEqual({ kind: 'scored', reward: 0 });
  });
});

function harnessReport(
  runRoot: string,
  verifierProcess: { readonly path: string; readonly sha256: string },
  reward: 0 | 1,
) {
  return {
    schema: 'ello.benchmark.harness.v1' as const,
    taskId: 'task-a',
    status: reward === 1 ? ('passed' as const) : ('failed' as const),
    reward,
    verifierProcess,
    baselinePreflightProcess: verifierProcess,
    baselinePreflightExitCode: 0,
    verifierImage: 'example/image:fixed',
    verifierImageId: 'sha256:image',
    modelPatchSha256: 'a'.repeat(64),
    appliedPatchSha256: 'a'.repeat(64),
    verifierCapturedPatchSha256: 'a'.repeat(64),
    baselineTestExitCode: 0,
    newTestsExitCode: 0,
    hiddenPatchChangedFiles: ['task_test.go'],
    patchConflictFiles: [],
    reportPath: path.join(runRoot, 'harness.json'),
    completedAt: '2026-07-23T00:00:02.000Z',
  };
}

function reportConfig() {
  return {
    schema: 'ello.benchmark.report-config.v2' as const,
    renderCharts: false,
    publishability: {
      requireCompleteMatrix: true,
      requireCompleteUsage: true,
      requireToolAudit: true,
    },
  };
}

function relaxedReportConfig() {
  return {
    schema: 'ello.benchmark.report-config.v2' as const,
    renderCharts: false,
    publishability: {
      requireCompleteMatrix: false,
      requireCompleteUsage: false,
      requireToolAudit: false,
    },
  };
}

function baseRun(
  runRoot: string,
  attemptId: string,
  jobId: string,
  taskId: string,
  agentId: 'ello' | 'claude-code',
) {
  const attemptRoot = path.join(runRoot, attemptId);
  void mkdir(attemptRoot, { recursive: true });
  return {
    schema: 'ello.benchmark.run.v2' as const,
    attemptId,
    attempt: 1,
    job: {
      schema: 'ello.benchmark.job.v2' as const,
      jobId,
      taskId,
      agentId,
      agentConfigHash:
        agentId === 'ello'
          ? sha256(stableJson(elloAgent()))
          : sha256(stableJson(claudeCodeAgent())),
      replicate: 1,
    },
    configHash: 'c'.repeat(64),
    agent: agentId === 'ello' ? elloAgent() : claudeCodeAgent(),
    provenance: {
      scope: 'ello' as const,
      elloRevision: '7'.repeat(40),
      sourceTree: '6'.repeat(40),
      lockfileSha256: '5'.repeat(64),
      nodeVersion: '24.0.0',
      pnpmVersion: '11.0.0',
      platform: 'linux',
      architecture: 'x64',
      packages: { agent: '1.0.0', tui: '1.0.0', bench: '1.0.0' },
    },
    attemptRoot,
    workspace: path.join(attemptRoot, 'workspace'),
    agentStateRoot: path.join(attemptRoot, 'agent-state'),
    baselinePreflightProcess: {
      path: path.join(attemptRoot, 'baseline-preflight-process.json'),
      sha256: '4'.repeat(64),
    },
    baselinePreflightExitCode: 0,
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

function claudeCodeAgent() {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    kind: 'claude-code' as const,
    model: 'claude-opus-4-6[1m]',
    reasoningEffort: 'max' as const,
    binary: {
      pathEnv: 'ELLO_BENCH_CLAUDE_EXE',
      expectedVersion: '2.1.217',
      sha256: '3'.repeat(64),
    },
    connection: {
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
    },
  };
}

function claudeRuntime() {
  const agent = claudeCodeAgent();
  return {
    schema: 'ello.benchmark.agent-runtime.v1' as const,
    agentId: agent.id,
    displayName: agent.displayName,
    agentConfigHash: sha256(stableJson(agent)),
    adapterContractVersion: '1' as const,
    expectedModel: agent.model,
    observedModel: agent.model,
    configSha256: sha256(stableJson(agent)),
    kind: 'claude-code' as const,
    executablePath: '/tmp/claude',
    expectedVersion: agent.binary.expectedVersion,
    observedVersion: agent.binary.expectedVersion,
    executableSha256: agent.binary.sha256,
    baseUrl: agent.connection.baseUrl,
    apiKeyEnv: agent.connection.apiKeyEnv,
  };
}

function claudeAssistantRecord(
  messageId: string,
  usage: Record<string, number>,
  contentType: 'thinking' | 'text',
) {
  return {
    type: 'assistant',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6[1m]',
      content: [{ type: contentType }],
      usage,
    },
    session_id: 'session-1',
  };
}

function externalRound(
  round: number,
  requestId: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
) {
  return {
    schema: 'ello.benchmark.round.v2',
    round,
    requestId,
    provider: 'anthropic',
    model: 'claude-opus-4-6[1m]',
    startedAt: null,
    firstTokenAt: null,
    completedAt: null,
    status: 'completed',
    usage: {
      status: 'complete',
      requests: 1,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: null,
      toolCalls: 0,
    },
    toolCalls: [],
    durationMs: null,
    firstTokenLatencyMs: null,
  };
}

function fileEvidence(filePath: string, content: string) {
  return {
    path: filePath,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
  };
}

function zeroToolSummary() {
  return {
    total: 0,
    failed: 0,
    read: 0,
    search: 0,
    edit: 0,
    shell: 0,
    other: 0,
    timeToFirstMutationMs: null,
  };
}

function resolvedTask(taskId: string) {
  return {
    schema: 'ello.benchmark.resolved-task.v2' as const,
    benchmark: 'deep-swe' as const,
    taskId,
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

function processResult(durationMs: number) {
  return {
    command: 'node',
    args: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

function elloRuntime() {
  const agent = elloAgent();
  return {
    schema: 'ello.benchmark.agent-runtime.v1' as const,
    agentId: agent.id,
    displayName: agent.displayName,
    agentConfigHash: sha256(stableJson(agent)),
    adapterContractVersion: '2' as const,
    expectedModel: agent.models[agent.primaryModel].apiModel,
    observedModel: agent.models[agent.primaryModel].apiModel,
    configSha256: sha256(stableJson(agent)),
    kind: 'ello' as const,
    primaryModel: agent.primaryModel,
    auxiliaryModel: agent.auxiliaryModel,
    promptMode: agent.promptMode,
    enabledTools: ['command_run'],
    toolsetFingerprint: 'a'.repeat(64),
  };
}

function zeroUsage() {
  return {
    status: 'complete' as const,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
  };
}
