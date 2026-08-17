import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SuiteReportSchema } from '../src/domain/contract/index.js';
import {
  intervalOrNull,
  wilsonInterval,
} from '../src/domain/scoring/wilson.js';
import {
  loadBenchmarkConfig,
  semanticConfigHash,
} from '../src/infra/config/toml-loader.js';
import { renderCharts } from '../src/render/chart/svg.js';
import { renderMarkdown } from '../src/render/markdown.js';

import { EXAMPLE_CONFIG_PATH } from './example-config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Wilson interval', () => {
  it('matches the pre-registered 95% interval and sample gate', () => {
    expect(wilsonInterval(7, 10)).toEqual({
      low: 0.39677814746114537,
      high: 0.8922087325936989,
    });
    expect(intervalOrNull(1, 2)).toBeNull();
    expect(intervalOrNull(2, 3)).toEqual(wilsonInterval(2, 3));
  });
});

describe('TypeScript report renderer', () => {
  it('emits deterministic Markdown and exactly seven valid SVG charts', () => {
    const report = reportFixture();
    const first = renderCharts(report);
    const second = renderCharts(report);

    expect(first).toEqual(second);
    expect(Object.keys(first)).toHaveLength(7);
    for (const [name, svg] of Object.entries(first)) {
      expect(name).toMatch(/\.svg$/u);
      expect(svg).toMatch(
        /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u,
      );
      expect(svg).toContain('letter-spacing:0');
      expect(svg.endsWith('\n')).toBe(true);
    }
    const markdown = renderMarkdown(report, '/runs/example', 'fixture');
    expect(markdown).toContain('| ello | 3 | 2 | 66.7% |');
    expect(markdown).toContain('subagent input');
    expect(markdown).toContain('combined input');
    expect(markdown).toContain('subagent output');
    expect(markdown).toContain('subagent tools');
    expect(markdown).toContain('non-cache input');
    expect(markdown).toContain('cache hit rate');
    expect(markdown).toContain('8.3%');
    expect(markdown).toContain('reasoning');
    expect(markdown).toContain('### Aggregate (mean)');
    expect(markdown).toContain('| ello | 12 s | 5 | 9 |');
    expect(markdown).toContain(
      '### By task: outcome / elapsed / rounds / tools',
    );
    expect(markdown).toContain('| task-a | pass / 10 s / 4 / 8 |');
    expect(markdown).toContain('`charts/token-breakdown.svg`');
    expect(first['token-breakdown.svg']).toContain('ello non-cache input');
    expect(first['token-breakdown.svg']).toContain('ello cache read');
    expect(first['token-breakdown.svg']).toContain('ello cache write');
    expect(first['token-breakdown.svg']).toContain('ello output');
    expect(first['token-breakdown.svg']).toContain('ello reasoning');
  });

  it('labels partial invalid-attempt evidence as excluded from scores', () => {
    const report = SuiteReportSchema.parse({
      ...reportFixture(),
      invalidJobs: 1,
      publishable: false,
      invalidLedger: [
        {
          attemptId: '1'.repeat(24),
          jobId: '2'.repeat(16),
          taskId: 'task-a',
          agentId: 'ello',
          failure: {
            kind: 'provider',
            phase: 'agent-model-call',
            message: 'reasoning item not found',
          },
          partialEvidence: {
            elapsedMs: 12_000,
            rounds: {
              observed: 4,
              completed: 3,
              failed: 1,
              incomplete: 0,
            },
            tools: { observed: 8, failed: 2 },
            usage: {
              completeRounds: 3,
              unavailableRounds: 1,
              inputTokens: 1200,
              outputTokens: 200,
              cacheReadTokens: 100,
              cacheWriteTokens: 0,
            },
          },
        },
      ],
    });

    const markdown = renderMarkdown(report, '/runs/example', 'fixture');
    expect(markdown).toContain(
      '### Partial observations (excluded from scores)',
    );
    expect(markdown).toContain('| task-a | ello |');
    expect(markdown).toContain(
      '| 12 s | 4 (3 / 1) | 8 (2) | 1,200 | 200 | 3/4 rounds |',
    );
  });
});

describe('semantic config hash', () => {
  it('ignores TOML comments, whitespace, and table key order', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-config-hash-'));
    temporaryDirectories.push(directory);
    const original = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    const agentsSource = path.join(
      path.dirname(EXAMPLE_CONFIG_PATH),
      'agents.toml',
    );
    await cp(agentsSource, path.join(directory, 'agents.toml'));
    const reordered = original
      .replace(
        '[execution]\nreplicates = 1\nconcurrency = 4\nmax_infrastructure_retries = 1',
        '[execution]\n# formatting must not affect identity\nmax_infrastructure_retries = 1\nconcurrency = 4\nreplicates = 1',
      )
      .replace('suite = "deep-swe-v1.1"', 'suite    =    "deep-swe-v1.1"');
    const alternatePath = path.join(directory, 'benchmark.toml');
    await writeFile(alternatePath, reordered, 'utf8');

    const [first, second] = await Promise.all([
      loadBenchmarkConfig(EXAMPLE_CONFIG_PATH),
      loadBenchmarkConfig(alternatePath),
    ]);
    expect(second).toEqual(first);
    expect(semanticConfigHash(second)).toBe(semanticConfigHash(first));
  });
});

function reportFixture() {
  const summary = (value: number, mean = value) => ({
    count: 3,
    mean,
    median: value,
    p95: value,
  });
  return SuiteReportSchema.parse({
    schema: 'ello.benchmark.suite.v3',
    suite: {
      id: 'deep-swe-v1.1',
      benchmarkId: 'ello.benchmark.deepswe.v1.1',
      displayName: 'DeepSWE v1.1',
      source: {
        repository: 'https://github.com/example/corpus',
        revision: 'a'.repeat(40),
      },
      taskSetHash: 'b'.repeat(64),
      selectedTaskCount: 3,
      upstreamTaskCount: 3,
      selectionKind: 'curated',
      scoreMetric: 'binary-reward',
    },
    reportConfig: {
      schema: 'ello.benchmark.report-config.v2',
      renderCharts: true,
      publishability: {
        requireCompleteMatrix: true,
        requireCompleteUsage: true,
        requireToolAudit: true,
      },
    },
    configHash: 'c'.repeat(64),
    planHash: 'd'.repeat(64),
    generatedAt: '2026-07-30T00:00:00.000Z',
    plannedJobs: 3,
    scoredJobs: 3,
    invalidJobs: 0,
    publishable: true,
    agents: [
      {
        agentId: 'ello',
        agentConfigHash: 'e'.repeat(64),
        validRuns: 3,
        passedRuns: 2,
        invalidRuns: 0,
        passRate: 2 / 3,
        taskMacroAverage: 2 / 3,
        resources: {
          elapsedMs: summary(10_000, 12_000),
          rounds: summary(4, 5),
          inputTokens: summary(1200),
          nonCachedInputTokens: summary(1100),
          outputTokens: summary(200),
          cacheReadTokens: summary(100),
          cacheWriteTokens: summary(20),
          cacheHitRate: summary(1 / 12),
          reasoningTokens: summary(40),
          toolCalls: summary(8, 9),
          threadUsage: {
            mainInputTokens: summary(900),
            subagentInputTokens: summary(300),
            combinedInputTokens: summary(1200),
            mainOutputTokens: summary(150),
            subagentOutputTokens: summary(50),
            combinedOutputTokens: summary(200),
            mainToolCalls: summary(6),
            subagentToolCalls: summary(2),
            combinedToolCalls: summary(8),
          },
          phaseElapsedMs: {},
        },
        evidenceCoverage: {
          usageCompleteRuns: 3,
          usageUnavailableRuns: 0,
          toolAuditPassedRuns: 3,
        },
        tasks: [
          {
            taskId: 'task-a',
            agentId: 'ello',
            validRuns: 1,
            passedRuns: 1,
            passRate: 1,
            resources: {
              elapsedMs: summary(10_000),
              rounds: summary(4),
              toolCalls: summary(8),
              inputTokens: summary(1200),
              nonCachedInputTokens: summary(1100),
              outputTokens: summary(200),
              cacheReadTokens: summary(100),
              cacheWriteTokens: summary(20),
              cacheHitRate: summary(1 / 12),
              reasoningTokens: summary(40),
            },
          },
        ],
      },
    ],
    comparisons: [],
    invalidLedger: [],
  });
}
