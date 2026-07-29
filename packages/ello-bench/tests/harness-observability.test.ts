import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { lastVerificationRound } from '../src/agents/evidence.js';
import {
  HarnessReportSchema,
  type BenchmarkRound,
  type VerifierAssertion,
} from '../src/contracts.js';
import { collectVerifierAssertions } from '../src/verifier-assertions.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Harness 可观测性', () => {
  it('从 parser 制品提取逐测试断言并保留 baseline/new 语义', async () => {
    const verifierOutput = await temporaryDirectory();
    await writeFile(
      path.join(verifierOutput, 'output.json'),
      JSON.stringify({
        tests: [
          { name: 'existing behavior', status: 'PASSED' },
          { name: 'new behavior', status: 'ERROR' },
          { name: 'extra check', status: 'SKIPPED' },
        ],
      }),
      'utf8',
    );

    const assertions = await collectVerifierAssertions({
      verifierOutput,
      baselineExitCode: 0,
      newTestsExitCode: 1,
      reward: 0,
      testSpec: {
        selectedTests: ['suite'],
        passToPass: ['existing behavior'],
        failToPass: ['new behavior'],
      },
    });

    expect(assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'existing behavior',
          scope: 'baseline',
          status: 'passed',
          source: 'parser',
        }),
        expect.objectContaining({
          id: 'new behavior',
          scope: 'new',
          status: 'error',
          source: 'parser',
        }),
        expect.objectContaining({
          id: 'extra check',
          scope: 'new',
          status: 'skipped',
          source: 'parser',
        }),
      ]),
    );
    expect(assertions).toHaveLength(6);
  });

  it('parser 制品缺失或不合法时仍返回三条 harness 基础断言', async () => {
    const verifierOutput = await temporaryDirectory();
    await writeFile(
      path.join(verifierOutput, 'output.json'),
      JSON.stringify({ tests: [{ name: 'bad', status: 'UNKNOWN' }] }),
      'utf8',
    );

    await expect(
      collectVerifierAssertions({
        verifierOutput,
        baselineExitCode: 0,
        newTestsExitCode: 0,
        reward: 1,
      }),
    ).resolves.toMatchObject([
      { id: 'baseline-tests', source: 'harness' },
      { id: 'new-tests', source: 'harness' },
      { id: 'reward', source: 'harness' },
    ]);
  });

  it('拒绝同 scope 的重复 assertion，并保留 patch 文件和最后验证轮', () => {
    const duplicate: VerifierAssertion = {
      id: 'case-a',
      scope: 'new',
      status: 'passed',
      exitCode: null,
      source: 'parser',
    };
    expect(() =>
      HarnessReportSchema.parse(
        harnessReport({ verifierAssertions: [duplicate, duplicate] }),
      ),
    ).toThrow('Duplicate verifier assertion: new:case-a');

    const report = HarnessReportSchema.parse(
      harnessReport({
        modelPatchChangedFiles: ['src/a.ts', 'tests/a.test.ts'],
        verifierAssertions: [duplicate],
        lastAgentVerificationRound: 4,
      }),
    );
    expect(report.modelPatchChangedFiles).toEqual([
      'src/a.ts',
      'tests/a.test.ts',
    ]);
    expect(report.lastAgentVerificationRound).toBe(4);
  });

  it('最后验证轮忽略普通 shell，只选择最后一个测试、检查或构建命令', () => {
    const rounds = [
      round(1, null),
      round(2, 'git diff --stat'),
      round(3, 'pnpm vitest src/a.test.ts'),
      round(4, 'pnpm lint'),
      round(5, 'git status --short'),
    ];

    expect(lastVerificationRound(rounds)).toBe(4);
    expect(lastVerificationRound([round(1, 'git status --short')])).toBeNull();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ello-verifier-output-'));
  temporaryDirectories.push(directory);
  return directory;
}

function harnessReport(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'ello.benchmark.harness.v1',
    taskId: 'task-a',
    status: 'passed',
    reward: 1,
    verifierProcess: { path: '/tmp/verifier.json', sha256: 'b'.repeat(64) },
    verifierRuntime: 'local',
    modelPatchSha256: 'a'.repeat(64),
    appliedPatchSha256: 'a'.repeat(64),
    verifierCapturedPatchSha256: 'a'.repeat(64),
    baselineTestExitCode: 0,
    newTestsExitCode: 0,
    hiddenPatchChangedFiles: [],
    patchConflictFiles: [],
    modelPatchChangedFiles: [],
    verifierAssertions: [],
    lastAgentVerificationRound: null,
    reportPath: '/tmp/report.json',
    completedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function round(roundNumber: number, command: string | null): BenchmarkRound {
  return {
    schema: 'ello.benchmark.round.v2',
    round: roundNumber,
    requestId: `request-${roundNumber}`,
    provider: 'codex',
    model: 'test-model',
    startedAt: null,
    firstTokenAt: null,
    completedAt: null,
    status: 'completed',
    usage: { status: 'unavailable', reason: 'test fixture' },
    toolCalls:
      command === null
        ? []
        : [
            {
              id: `tool-${roundNumber}`,
              name: 'bash',
              category: 'shell',
              status: 'completed',
              startedAt: null,
              completedAt: null,
              durationMs: null,
              command,
              paths: [],
              mutating: true,
            },
          ],
    durationMs: null,
    firstTokenLatencyMs: null,
  };
}
