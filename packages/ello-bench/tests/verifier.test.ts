import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/domain/contract/index.js';
import { sha256 } from '../src/domain/hash.js';
import { DEEP_SWE_BASELINE_VERIFIER } from '../src/infra/deep-swe-baseline-verifier.js';
import {
  baselineVerifierCommand,
  parseVerifierTestResults,
  verifierCommand,
  verifierContainerSpec,
} from '../src/infra/verifier/process.js';
import { sealVerifierPatchArtifact } from '../src/infra/verifier/workspace.js';
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

  it('mounts the frozen model patch read-only over the writable logs tree', () => {
    const inputPatchPath = '/runs/job/raw/model.patch';
    const spec = verifierContainerSpec(
      { ...options, inputPatchPath },
      'ello-bench-abc-verify',
    );

    expect(spec.additionalMounts).toContainEqual({
      host: inputPatchPath,
      container: '/logs/input/model.patch',
      readOnly: true,
    });
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

  it('uses suite-owned baseline-only verifier commands', () => {
    expect(baselineVerifierCommand(options.task)).toEqual([
      '/bin/bash',
      '-c',
      'mkdir -p /root && exec /bin/bash /tests/baseline.sh',
    ]);
    expect(
      baselineVerifierCommand({
        ...options.task,
        benchmark: 'swe-bench-pro',
      } as ResolvedTask),
    ).toEqual([
      '/bin/bash',
      '-c',
      'mkdir -p /root && exec python /tests/baseline.py',
    ]);
    expect(DEEP_SWE_BASELINE_VERIFIER).not.toContain('git checkout HEAD');
  });

  it('seals the verifier artifact from the frozen host input', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-patch-seal-'));
    const input = path.join(directory, 'input.patch');
    const artifact = path.join(directory, 'artifact.patch');
    const patch = 'diff --git a/a.ts b/a.ts\n';
    await writeFile(input, patch, 'utf8');
    await writeFile(artifact, 'verifier rebuilt the wrong patch\n', 'utf8');

    const captured = await sealVerifierPatchArtifact({
      inputPatchPath: input,
      artifactPatchPath: artifact,
      expectedSha256: sha256(patch),
    });

    expect(captured).toBe(sha256(patch));
    expect(await readFile(artifact, 'utf8')).toBe(patch);
  });
});
