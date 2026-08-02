# @ello/bench

`@ello/bench` is a reproducible coding-agent benchmark harness. It expands a
strict TOML definition into a `task x agent x replicate` matrix, runs every job
against the task's pinned Docker image, preserves raw evidence, verifies the
result in a fresh container, and renders JSON, Markdown, and SVG reports.

The default DeepSWE matrix compares three agents:

- `ello`: Ello with subagents enabled
- `ello-no-subagent`: the same Ello models with subagents disabled
- `codex`: Codex using the same primary model and reasoning effort

## Suites

| Suite                       | Tasks | Purpose                            | Corpus                                      |
| --------------------------- | ----: | ---------------------------------- | ------------------------------------------- |
| `deep-swe-v1.1`             |    20 | Stable optimization and A/B target | Pinned `datacurve-ai/deep-swe` revision     |
| `swe-bench-pro-calibration` |    30 | Cross-harness calibration          | Pinned `scaleapi/SWE-bench_Pro-os` revision |

If `--corpus-root` is omitted, the selected corpus is cloned into
`packages/ello-bench/raw/_cache/<suite>/`. An existing corpus checkout must
have the configured origin, pinned revision, and a clean working tree.

## Requirements

- Node.js 24+
- pnpm 11
- Git
- Docker CLI and an accessible Docker daemon
- Credentials and pinned external agent binaries required by the selected
  agents

The harness has no host Python or plotting dependency. A task image may still
run a Python verifier when that is part of the task contract, as it is for
SWE-bench Pro.

## Configuration

TOML is the only accepted configuration format. The default entry point is
[`config/benchmark.toml`](config/benchmark.toml), which references
[`config/agents.toml`](config/agents.toml) through `agents_file`.

```toml
schema = "ello.benchmark.config.v2"
suite = "deep-swe-v1.1"
agents_file = "agents.toml"

[execution]
replicates = 1
concurrency = 2
max_infrastructure_retries = 1

[report]
render_charts = true

[report.publishability]
require_complete_matrix = true
require_complete_usage = true
require_tool_audit = true

[container]
pull_policy = "if-absent"
network = "task"
cleanup = "always"
```

Configuration is strict: unknown fields, missing values, duplicate IDs, or an
invalid combination fail before execution. `network = "task"` is mandatory;
the effective Docker network is derived from each task's `allow_internet`
contract and cannot be overridden by a benchmark run.

The resolved object is frozen after schema validation. Its semantic hash is
computed from recursively key-sorted normalized JSON, so TOML comments,
formatting, and key order do not change `configHash`.

Inspect the exact resolved input before a run:

```bash
pnpm --filter @ello/bench bench config print --resolved
```

To start from templates, use
[`config/examples/agents.toml`](config/examples/agents.toml),
[`config/examples/deep-swe.toml`](config/examples/deep-swe.toml), or
[`config/examples/swe-bench-pro.toml`](config/examples/swe-bench-pro.toml).
The benchmark and agents files may live anywhere, but `agents_file` is resolved
relative to the benchmark TOML file.

Agent credentials are named, never embedded:

```bash
export ELLO_BENCH_API_KEY=<token>
export ELLO_BENCH_CODEX_EXE=/absolute/path/to/codex
# Required only when a selected config contains Claude Code:
export ELLO_BENCH_CLAUDE_EXE=/absolute/path/to/claude
```

External agent entries pin both `expected_version` and `sha256`. `doctor`
checks the file, checksum, canonical version output, and required noninteractive
JSON flags.

## Docker Execution

There is no local runtime. Every task workspace is extracted from its pinned
image and every verifier runs in a fresh container using the same image.

- `allow_internet = false` becomes `docker run --network none`; otherwise it
  becomes `bridge`.
- Task `cpus` and `memory_mb` become Docker-native resource limits.
- `storage_mb` is enforced by a watchdog that combines apparent bytes in the
  bind-mounted workspace with Docker `SizeRw` for the container writable
  layer. It does not follow workspace symlinks, kills the owning container on
  overflow, and is audited before patch capture and after verifier execution.
  This works across Docker storage drivers, unlike `--storage-opt`, which does
  not constrain bind mounts.
- Containers run as the host UID/GID with a writable benchmark HOME.
- Codex and Claude Code binaries are copied into the task container and run
  there.
- Ello's App Server remains on the host, while all task shell and filesystem
  operations are routed through the task container at `/app`.
- `cleanup = "always" | "on-success" | "never"` controls retained agent
  containers. Verifier containers are always removed.

The attempt records the effective image, user, network, CPU, memory, and
storage policy in `docker-preflight.json` and `network-policy.json`.

## Commands

Build before invoking the compiled CLI:

```bash
pnpm --filter @ello/bench build
```

```text
ello-bench list [--config PATH]
ello-bench config print --resolved [--config PATH]
ello-bench agents [--config PATH]
ello-bench plan (--task ID | --all) (--agent ID | --all-agents) [--config PATH]
ello-bench doctor (--agent ID | --all-agents) [--config PATH]
ello-bench run (--task ID | --all) (--agent ID | --all-agents)
               --run-root PATH [--corpus-root PATH] [--report] [--config PATH]
ello-bench report --run-root PATH
ello-bench validate [--run-root PATH] [--config PATH]
```

Agent and task selection are explicit for `plan` and `run`; agent selection is
also explicit for `doctor`. Start with a single-task pilot:

```bash
pnpm --filter @ello/bench bench doctor --all-agents

pnpm --filter @ello/bench bench run \
  --task actionlint-action-pinning-lint \
  --all-agents \
  --run-root /absolute/path/to/deep-swe-pilot-001 \
  --report
```

Run the complete Part A three-agent matrix:

```bash
pnpm --filter @ello/bench bench run \
  --all \
  --all-agents \
  --run-root /absolute/path/to/deep-swe-part-a-001 \
  --report
```

A run root permanently binds its semantic `configHash`, `planHash`, task set,
agent set, and replicate set. Resume with the same inputs; use a new empty run
root after any input change.

## Outcomes And Retries

An attempt has one application-owned phase machine. Failures in corpus,
container, agent setup/process/evidence, patch capture, or verifier execution
are infrastructure-invalid and may be retried up to
`max_infrastructure_retries`.

A nonzero verifier baseline is classified as `baseline-unhealthy`, not as an
agent failure and not as reward `0`. It is listed in the report's invalid
ledger. Only a healthy baseline enters the scored denominator; the new-test
exit code then determines reward `0` or `1`.

## Evidence And Reports

Ello archives redacted EngineEvents as recovery-safe append-only JSONL. Exactly
one `thr_*` capture is required for the main thread; zero or more `job_*`
captures are accepted as subagents. Unknown prefixes, missing captures,
sequence gaps, lifecycle-count mismatches, and checksum mismatches fail
validation.

Normalized evidence exposes main, subagent, and combined token/tool usage.
Publishability gates consume the combined usage, preventing delegated work from
being omitted from cost reporting.

`report` writes:

```text
<run-root>/
├── suite-manifest.json
├── runs/<task>/<agent>/r<replicate>/<attempt>/
│   ├── run.json
│   ├── workspace/
│   ├── agent-state/
│   └── raw/
│       ├── docker-preflight.json
│       ├── network-policy.json
│       ├── model.patch
│       ├── phase-timings.json
│       ├── agent/
│       │   ├── evidence.json
│       │   ├── rounds.jsonl
│       │   └── tool-audit.json
│       └── harness/
│           ├── process.json
│           └── report.json
└── results/
    ├── suite-report.json
    ├── report.md
    ├── agents/
    ├── tasks/
    ├── comparisons/
    └── charts/*.svg
```

The report stack is pure TypeScript. Markdown and all seven charts are
deterministic text renderers; chart output is SVG. `render_charts = false`
still writes JSON and `report.md`, but skips the `charts/` directory.

Always validate a completed run independently:

```bash
pnpm --filter @ello/bench bench report --run-root /absolute/path/to/run
pnpm --filter @ello/bench bench validate --run-root /absolute/path/to/run
```

## Architecture

The source tree enforces inward dependencies:

- `domain/`: contracts and pure planning, evidence, and scoring logic
- `application/`: attempt and matrix orchestration through ports
- `ports/`: type/interface-only runtime contracts
- `infra/`: filesystem, processes, Docker, agents, verifier, corpus, and report
  persistence
- `render/`: pure Markdown and SVG rendering
- `cli/`: composition-facing command interface

ESLint prevents domain/application/ports/render from importing forbidden outer
layers or Node I/O APIs. The source root contains only the package export and
the two executable process entries; active implementations live in the layers
above.
