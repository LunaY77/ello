import { describe, expect, it } from 'vitest';

import { parseTaskToml } from '../src/infra/corpus/task-toml.js';

describe('task.toml parser', () => {
  it('parses the fixed corpus scalar contract', () => {
    const task = parseTaskToml(`version = "1.0"

[metadata]
ext_id = "external-id"
task_id = "sample-task"
display_title = "Sample task"
display_description = "Implement the requested behavior."
original_title = 'Original title'
category = "feature_request"
language = "go"
repository_url = "https://github.com/example/project"
base_commit_hash = "0123456789abcdef0123456789abcdef01234567"

[verifier]
timeout_sec = 1800.0

[agent]
timeout_sec = 5400.0

[environment]
docker_image = "registry.example/task:fixed"
allow_internet = false
build_timeout_sec = 1800.0
cpus = 2
memory_mb = 8192
storage_mb = 20480
`);

    expect(task.metadata.task_id).toBe('sample-task');
    expect(task.environment.allow_internet).toBe(false);
    expect(task.agent.timeout_sec).toBe(5400);
  });

  it('rejects fields outside the task contract after full TOML parsing', () => {
    expect(() => parseTaskToml(`version = "1.0"\nvalues = [1, 2]\n`)).toThrow(
      'Unrecognized key',
    );
  });
});
