import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/domain/contract/index.js';
import {
  parseVerifierTestResults,
  verifierDockerArgs,
  verifierExecArgs,
} from '../src/infra/verifier/process.js';
import { auditVerifierPatchOverlap } from '../src/infra/verifier-audit.js';

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
        storageMb: 20480,
      },
    } as ResolvedTask,
  };

  it('starts as the host user so its workspace and logs stay removable', () => {
    const args = verifierDockerArgs(
      options,
      'ello-bench-abc-verify',
      '1000:1000',
    );

    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('redirects HOME to a writable path before test.sh runs', () => {
    const args = verifierDockerArgs(
      options,
      'ello-bench-abc-verify',
      '1000:1000',
    );

    expect(args[args.indexOf('--env') + 1]).toBe('HOME=/tmp/ello-bench-home');
    expect(args.at(-4)).toBe('/bin/sh');
    expect(args.at(-3)).toBe('example.invalid/swe-bench:task');
    expect(args.at(-2)).toBe('-c');
    expect(args.at(-1)).toBe('sleep infinity');
  });

  it('enforces task network and resource limits', () => {
    const args = verifierDockerArgs(
      options,
      'ello-bench-abc-verify',
      '1000:1000',
    );

    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args[args.indexOf('--cpus') + 1]).toBe('2');
    expect(args[args.indexOf('--memory') + 1]).toBe('8192m');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/app');
    expect(args).not.toContain('--storage-opt');
    expect(args).toContain('example.invalid/swe-bench:task');
  });

  it('runs the verifier command with the task user without resetting image PATH', () => {
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
      '/bin/sh',
      options.task.environment.image,
      '-c',
      'sleep infinity',
    ]);
    expect(verifierExecArgs({ task }, 'ello-bench-abc-verify', '1000:1000')).toEqual([
      'exec',
      '--user',
      '1000:1000',
      '--workdir',
      '/app',
      'ello-bench-abc-verify',
      '/bin/bash',
      '-c',
      'mkdir -p /tmp/ello-bench-home && exec python /tests/verifier.py',
    ]);
  });
});
