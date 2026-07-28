import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadSweBenchProRows,
  loadSweBenchProTask,
} from '../src/swe-bench-pro-corpus.js';

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
    expect(loaded.testSpec).toEqual({
      selectedTests: ['TestCache'],
      failToPass: ['TestCache'],
      passToPass: [],
    });
  });
});
