import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/contracts.js';
import { auditVerifierPatchOverlap } from '../src/verifier-audit.js';
import {
  executeVerifierProcess,
  parseVerifierTestResults,
  verifierDockerArgs,
} from '../src/verifier-process.js';

describe('verifier patch audit', () => {
  it('records overlap limited to verifier test files', () => {
    expect(
      auditVerifierPatchOverlap(
        ['rule.go', 'rule_test.go'],
        ['rule_test.go', 'test.sh'],
      ),
    ).toEqual(['rule_test.go']);
  });

  it('rejects overlap with production files', () => {
    expect(() =>
      auditVerifierPatchOverlap(
        ['rule.go'],
        ['rule.go', 'rule_test.go', 'test.sh'],
      ),
    ).toThrow('overlaps model production files: rule.go');
  });

  it('extracts baseline and new test exit codes', () => {
    expect(
      parseVerifierTestResults(
        '[verifier] Baseline exit code: 0\n[verifier] New tests exit code: 1\n',
      ),
    ).toEqual({ baselineExitCode: 0, newTestsExitCode: 1 });
  });
});

describe('local verifier process', () => {
  it('runs without Docker and remaps verifier absolute paths', async () => {
    const harnessRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-local-verifier-'),
    );
    const workspace = path.join(harnessRoot, 'workspace');
    const tests = path.join(harnessRoot, 'tests');
    const logs = path.join(harnessRoot, 'logs');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(tests, { recursive: true }),
      mkdir(path.join(logs, 'input'), { recursive: true }),
      mkdir(path.join(logs, 'artifacts'), { recursive: true }),
      mkdir(path.join(logs, 'verifier'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(workspace, 'marker.txt'), 'workspace\n', 'utf8'),
      writeFile(path.join(logs, 'input', 'model.patch'), 'patch\n', 'utf8'),
      writeFile(
        path.join(tests, 'test.sh'),
        [
          '#!/bin/bash',
          'set -e',
          'test -f /app/marker.txt',
          'test "src/app/example" = "src/app/example"',
          'cp /logs/input/model.patch /logs/artifacts/model.patch',
          'echo 1 > /logs/verifier/reward.txt',
          'echo "[verifier] Baseline exit code: 0"',
          'echo "[verifier] New tests exit code: 0"',
          '',
        ].join('\n'),
        'utf8',
      ),
    ]);

    const result = await executeVerifierProcess({
      attemptId: 'a'.repeat(24),
      harnessRoot,
      workspace,
      tests,
      logs,
      runtime: 'local',
      task: {
        benchmark: 'deep-swe',
        verifierTimeoutMs: 10_000,
      } as ResolvedTask,
    });

    expect(result).toMatchObject({ baselineExitCode: 0, newTestsExitCode: 0 });
    expect(
      await readFile(path.join(logs, 'verifier', 'reward.txt'), 'utf8'),
    ).toBe('1\n');
    expect(
      await readFile(path.join(logs, 'artifacts', 'model.patch'), 'utf8'),
    ).toBe('patch\n');
    expect(await readFile(path.join(tests, 'test.sh'), 'utf8')).toContain(
      'src/app/example',
    );
  });
});

describe('verifier container Docker arguments', () => {
  const options = {
    workspace: '/runs/job/raw/harness/workspace',
    tests: '/runs/job/raw/harness/tests',
    logs: '/runs/job/raw/harness/logs',
    task: {
      benchmark: 'deep-swe',
      environment: {
        image: 'example.invalid/swe-bench:task',
        allowInternet: false,
        cpus: 2,
        memoryMb: 8192,
      },
    } as ResolvedTask,
  };

  it('runs as the host user so its workspace and logs stay removable', () => {
    const args = verifierDockerArgs(
      options,
      'ello-bench-abc-verify',
      '1000:1000',
    );

    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('redirects HOME to a writable path and creates it before test.sh runs', () => {
    const args = verifierDockerArgs(
      options,
      'ello-bench-abc-verify',
      '1000:1000',
    );

    expect(args[args.indexOf('--env') + 1]).toBe('HOME=/tmp/ello-bench-home');
    expect(args.at(-1)).toBe(
      'mkdir -p /tmp/ello-bench-home && exec /bin/bash /tests/test.sh',
    );
  });

  it('runs the SWE-bench Pro verifier without resetting image PATH', () => {
    const task = {
      ...options.task,
      benchmark: 'swe-bench-pro',
    } as ResolvedTask;
    const args = verifierDockerArgs(
      { ...options, task },
      'ello-bench-abc-verify',
      '1000:1000',
    );

    expect(args.slice(-4)).toEqual([
      '/bin/bash',
      options.task.environment.image,
      '-c',
      'mkdir -p /tmp/ello-bench-home && exec python /tests/verifier.py',
    ]);
  });
});
