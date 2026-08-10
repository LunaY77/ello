# @ello/bench

<p align="center"><a href="../../README-en.md">Project home</a> · <a href="README.md">简体中文</a> · <strong>English</strong></p>

`@ello/bench` is Ello's reproducible Coding Agent benchmark harness. It expands strict TOML into a `task × agent × replicate` matrix, runs Agents in pinned Docker environments, verifies patches in fresh containers, preserves retry lineage and normalized evidence, and renders JSON, Markdown, and SVG reports.

## Current published result

The current DeepSWE v1.1 run fixes DeepSeek V4 Flash 0731, High reasoning, the same 20 tasks, and the same Docker/verifier contract.

| Agent         | Passed | Pass rate | Delta vs Claude Code |
| ------------- | -----: | --------: | -------------------: |
| Ello Rapid    |     13 | **65.0%** |         **+20.0 pp** |
| Ello Thorough |     13 | **65.0%** |         **+20.0 pp** |
| Claude Code   |      9 |     45.0% |             baseline |

Both Ello configurations are 6 wins, 12 ties, and 2 losses against Claude Code. On paired tasks with evidence on both sides, Rapid uses 69.0% less elapsed time, 68.3% fewer model rounds, 70.7% fewer normalized Command/Tool calls, and 74.5% fewer input tokens at the median.

See the [evidence record](../../docs/benchmark/current-task-set-record.md), [generated report](../../docs/benchmark/results/report.md), [task patches](../../docs/benchmark/results/tasks/deep-swe/), and [methodology](../../docs/benchmark/benchmark-methodology.md).

Strict `publishable` remains false because historical usage/tool-audit coverage is incomplete; all 60 verifier jobs are scored, but resource claims retain their measured sample counts.

## Pipeline

```text
strict config
  -> task x agent x replicate plan
  -> baseline preflight
  -> Agent in task Environment
  -> capture model.patch
  -> fresh verifier container
  -> normalized evidence
  -> report and independent validation
```

Infrastructure failures can retry; a valid task failure cannot. A run root permanently binds its semantic config, plan, task set, Agent set, and replicate set.

## Docker and Agent integration

There is no local task runtime. Workspaces come from pinned images, Agent changes happen in the assigned task container, and verification runs in a fresh container using the same image. Effective image, user, CPU, memory, storage, network, timeout, patch, and process evidence are recorded per attempt.

Ello uses the public `@ello/agent/runtime` Environment contract. Each job gets an isolated App Server process, state root, Unix socket, Container Environment, and EngineEvent recorder. The ordinary headless `ello --remote ... --json --no-tui run` Client still starts the Thread through production JSON-RPC.

## Attempts and evidence

```text
planned -> preparing -> running -> capturing -> verifying -> completed
              \________________________________________-> invalid_infrastructure
```

Reports select the last completed attempt per job and retain the full invalid ledger. Validation recomputes schemas, path boundaries, checksums, retry lineage, runtime identity, evidence, and the published report.

Resource distributions include only completed runs with the corresponding normalized evidence. Missing usage is never replaced with zero. Agent summaries expose mean, median, p95, and coverage; task summaries compare outcome, elapsed time, rounds, tools, and tokens.

## Published artifacts

Full evidence remains under ignored `packages/ello-bench/raw/`. The Git-facing set is intentionally small:

```text
docs/benchmark/results/
├── manifest.json
├── report.md
├── suite-report.json
├── charts/
└── tasks/deep-swe/<task>/<agent>/
    ├── manifest.json
    ├── model.patch
    └── harness.json
```

Task instruction and resolved metadata are shared one level above each Agent. Verifier logs, full evidence, tool audits, and phase timings stay in raw storage.

## Commands

```bash
pnpm --filter @ello/bench build
pnpm --filter @ello/bench bench doctor --all-agents

pnpm --filter @ello/bench bench run \
  --task actionlint-action-pinning-lint \
  --all-agents \
  --run-root /absolute/path/to/pilot \
  --report

pnpm --filter @ello/bench bench report --run-root /absolute/path/to/run
pnpm --filter @ello/bench bench validate --run-root /absolute/path/to/run
```

## Architecture

Dependencies point inward from CLI and infrastructure through application ports to pure domain contracts and scoring. Docker, Agent adapters, corpus access, verifier execution, and report persistence remain replaceable outer implementations; Markdown/SVG rendering is deterministic and I/O-free.

## Validation

```bash
pnpm --filter @ello/bench test
pnpm --filter @ello/bench typecheck
pnpm exec eslint packages/ello-bench/src packages/ello-bench/tests \
  packages/ello-bench/scripts/archive-doc-results.mjs
pnpm --filter @ello/bench build
```

See [Benchmark architecture](../../docs/benchmark/architecture.md) for the full state machine and artifact contracts.
