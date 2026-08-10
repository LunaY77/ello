import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applySweBenchProRunScriptCorrections,
  loadSweBenchProRows,
  loadSweBenchProTask,
} from '../src/infra/corpus/swe-bench-pro.js';

const PROTON_DRIVE_INSTANCE =
  'instance_protonmail__webclients-6f8916fbadf1d1f4a26640f53b5cf7f55e8bedb7';

const MISROUTED_PROTON_SCRIPT = `      file_path=$(echo "$test_path" | cut -d'|' -f1 | xargs)
      test_name=$(echo "$test_path" | cut -d'|' -f2- | xargs)
      if [[ "$file_path" == src/app/* ]] || [[ "$file_path" == *mail* ]]; then
        echo "Running test in proton-mail workspace: $file_path | $test_name"
        yarn workspace proton-mail test --runInBand --ci --testPathPattern="$file_path" --testNamePattern="$test_name" --verbose
fi
      if [[ "$test_path" == src/app/* ]] || [[ "$test_path" == *mail* ]]; then
        echo "Running test file in proton-mail workspace: $test_path"
        yarn workspace proton-mail test --runInBand --ci --testPathPattern="$test_path" --verbose
fi
`;

describe('SWE-bench Pro corpus', () => {
  it('resolves the pinned JSONL, workspace setup, scripts, and test contract', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-swepro-corpus-'));
    const instanceId =
      'instance_flipt-io__flipt-0123456789abcdef0123456789abcdef01234567';
    const scripts = path.join(root, 'run_scripts', instanceId);
    await mkdir(path.join(root, 'helper_code'), { recursive: true });
    await mkdir(scripts, { recursive: true });
    const baseCommit = 'a'.repeat(40);
    const testCommit = 'b'.repeat(40);
    const row = {
      image_name: 'registry.example/flipt:fixture',
      instance_id: instanceId,
      hints_text: '',
      problem_statement:
        '"# Title\\nFix cache invalidation"\n\nRequirements:\n"Keep entries coherent."\n\nNew interfaces introduced:\n"None."',
      patch: 'diff --git a/cache.go b/cache.go\n',
      test_patch:
        'diff --git a/cache_test.go b/cache_test.go\nnew file mode 100644\nindex 0000000..df967b9\n--- /dev/null\n+++ b/cache_test.go\n@@ -0,0 +1 @@\n+package cache\n',
      repo: 'flipt-io/flipt',
      base_commit: baseCommit,
      base_dockerfile: 'FROM golang:1.24\n',
      instance_dockerfile: 'FROM fixture\n',
      before_repo_set_cmd: [
        `git reset --hard ${baseCommit}`,
        'git clean -fd',
        `git checkout ${baseCommit}`,
        `git checkout ${testCommit} -- internal/cache/cache_test.go`,
      ].join('\n'),
      selected_test_files_to_run: '["TestCache"]',
      FAIL_TO_PASS: ['TestCache'],
      PASS_TO_PASS: '[]',
      is_remote_image: true,
      created_at: '2026-01-01T00:00:00Z',
      version: '1',
      repo_name: 'app',
      run_script: 'https://example.com/run-script',
      parsing_script: 'https://example.com/parser',
    };
    await Promise.all([
      writeFile(
        path.join(root, 'helper_code', 'sweap_eval_full_v2.jsonl'),
        `${JSON.stringify(row)}\n`,
        'utf8',
      ),
      writeFile(path.join(scripts, 'run_script.sh'), 'go test ./...\n', 'utf8'),
      writeFile(path.join(scripts, 'parser.py'), 'print("parser")\n', 'utf8'),
    ]);

    const rows = await loadSweBenchProRows(root, 1);
    const loaded = await loadSweBenchProTask(
      root,
      {
        taskId: 'swepro-flipt-fixture',
        instanceId,
        language: 'go',
        difficultyBand: 'easy',
      },
      rows,
    );

    expect(loaded.task.benchmark).toBe('swe-bench-pro');
    expect(loaded.task.displayTitle).toBe('Fix cache invalidation');
    expect(loaded.task.environment.image).toBe(
      'jefzda/sweap-images:flipt-io.flipt-flipt-io__flipt-0123456789abcdef0123456789abcdef01234567',
    );
    expect(loaded.workspaceSetupCommands).toEqual([
      ['reset', '--hard', baseCommit],
      ['clean', '-fd'],
      ['checkout', baseCommit],
      ['checkout', testCommit, '--', 'internal/cache/cache_test.go'],
    ]);
    expect(loaded.workspacePatch).toBe(row.test_patch);
    expect(loaded.runScript).toBe('go test ./...\n');
    expect(loaded.testSpec).toEqual({
      selectedTests: ['TestCache'],
      failToPass: ['TestCache'],
      passToPass: [],
    });
  });

  it('corrects Proton Drive routing and quote-safe test-name trimming', () => {
    const corrected = applySweBenchProRunScriptCorrections(
      PROTON_DRIVE_INSTANCE,
      MISROUTED_PROTON_SCRIPT,
    );

    expect(corrected).toContain(
      'if [[ "$file_path" == src/app/* ]]; then\n' +
        '        echo "Running test in proton-drive workspace: $file_path | $test_name"\n' +
        '        yarn workspace proton-drive test',
    );
    expect(corrected).toContain(
      'if [[ "$test_path" == src/app/* ]]; then\n' +
        '        echo "Running test file in proton-drive workspace: $test_path"\n' +
        '        yarn workspace proton-drive test',
    );
    expect(corrected).not.toContain(
      'src/app/* ]] || [[ "$file_path" == *mail*',
    );
    expect(corrected).not.toContain(
      'src/app/* ]] || [[ "$test_path" == *mail*',
    );
    expect(corrected).not.toContain('| xargs');
    expect(corrected).toContain(
      `test_name=$(echo "$test_path" | cut -d'|' -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')`,
    );
  });

  it('fails closed when the corrected upstream script drifts', () => {
    expect(() =>
      applySweBenchProRunScriptCorrections(
        PROTON_DRIVE_INSTANCE,
        '#!/bin/bash\n',
      ),
    ).toThrow(/corpus correction drifted/u);
  });
});
