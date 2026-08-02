import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/domain/contract/index.js';
import {
  parseVerifierTestResults,
  verifierCommand,
  verifierContainerSpec,
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

describe('verifier container contract', () => {
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
    const spec = verifierContainerSpec(options, 'ello-bench-abc-verify');

    expect(spec.user).toEqual({ uid: process.getuid(), gid: process.getgid() });
  });

  it('uses the adopted image HOME and shared mount contract', () => {
    const spec = verifierContainerSpec(options, 'ello-bench-abc-verify');

    expect(spec.env.HOME).toBe('/root');
    expect(spec.entrypoint).toBe('/bin/sh');
    expect(spec.command).toEqual(['-c', 'sleep infinity']);
    expect(spec.additionalMounts).toEqual([
      { host: options.tests, container: '/tests', readOnly: true },
      { host: options.logs, container: '/logs' },
    ]);
  });

  it('keeps verifier dependency resolution online and enforces resource limits', () => {
    const spec = verifierContainerSpec(options, 'ello-bench-abc-verify');

    expect(spec.network).toBe('bridge');
    expect(spec.cpus).toBe(2);
    expect(spec.memoryMb).toBe(8192);
    expect(spec.storageMb).toBe(20480);
    expect(spec.image).toBe('example.invalid/swe-bench:task');
  });

  it('runs the verifier command with the task user without resetting image PATH', () => {
    const task = {
      ...options.task,
      benchmark: 'swe-bench-pro',
    } as ResolvedTask;
    expect(verifierCommand(task)).toEqual([
      '/bin/bash',
      '-c',
      'mkdir -p /root && exec python /tests/verifier.py',
    ]);
  });
});
