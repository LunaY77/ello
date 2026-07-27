import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/contracts.js';
import { auditVerifierPatchOverlap } from '../src/verifier-audit.js';
import {
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
