import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { VerifierAssertion } from '../../domain/contract/index.js';
import type { SweBenchProTestSpec } from '../../ports/corpus.js';

const ParserOutputSchema = z
  .object({
    tests: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.enum(['PASSED', 'FAILED', 'SKIPPED', 'ERROR']),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * 汇总 harness 固定断言和 parser 逐测试断言。
 *
 * parser 制品缺失或格式不合法时，只返回 harness 已确认的事实；SWE-bench Pro
 * 依据 PASS_TO_PASS 与 FAIL_TO_PASS 保留测试原本的 baseline/new 语义。
 */
export async function collectVerifierAssertions(options: {
  readonly verifierOutput: string;
  readonly baselineExitCode: number;
  readonly newTestsExitCode: number;
  readonly reward: 0 | 1;
  readonly testSpec?: SweBenchProTestSpec;
}): Promise<readonly VerifierAssertion[]> {
  const assertions: VerifierAssertion[] = [
    {
      id: 'baseline-tests',
      scope: 'baseline',
      status: options.baselineExitCode === 0 ? 'passed' : 'failed',
      exitCode: options.baselineExitCode,
      source: 'harness',
    },
    {
      id: 'new-tests',
      scope: 'new',
      status: options.newTestsExitCode === 0 ? 'passed' : 'failed',
      exitCode: options.newTestsExitCode,
      source: 'harness',
    },
    {
      id: 'reward',
      scope: 'reward',
      status: options.reward === 1 ? 'passed' : 'failed',
      exitCode: null,
      source: 'harness',
    },
  ];
  const parsed = await readParserOutput(options.verifierOutput);
  if (parsed === undefined) return assertions;

  const passToPass = new Set(options.testSpec?.passToPass ?? []);
  for (const result of parsed.tests) {
    assertions.push({
      id: result.name,
      scope: passToPass.has(result.name) ? 'baseline' : 'new',
      status: parserStatus(result.status),
      exitCode: null,
      source: 'parser',
    });
  }
  return assertions;
}

async function readParserOutput(
  verifierOutput: string,
): Promise<z.infer<typeof ParserOutputSchema> | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(verifierOutput, 'output.json'), 'utf8'),
    );
    const parsed = ParserOutputSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parserStatus(
  status: z.infer<typeof ParserOutputSchema>['tests'][number]['status'],
): VerifierAssertion['status'] {
  switch (status) {
    case 'PASSED':
      return 'passed';
    case 'FAILED':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
    case 'ERROR':
      return 'error';
  }
}
