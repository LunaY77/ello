# @ello/bench

<p align="center"><a href="../../README-en.md">Project home</a> · <a href="README.md">简体中文</a> · <strong>English</strong></p>

`@ello/bench` is Ello's reproducible Coding Agent benchmark harness. It expands strict TOML into a `task × agent × replicate` matrix, runs Agents in pinned Docker environments, verifies patches in fresh containers, preserves retry lineage and normalized evidence, and renders JSON, Markdown, and SVG reports.

## Current published result

The current DeepSWE v1.1 run fixes DeepSeek V4 Flash 0731, High reasoning, the full 113-task suite, and the same Docker/verifier contract. Of 565 planned jobs, 520 are scored and 45 are infrastructure-invalid.

| Agent                    | Valid | Passed | Pass rate | Invalid |
| ------------------------ | ----: | -----: | --------: | ------: |
| Ello Rapid               |   104 |     46 |     44.2% |       9 |
| Ello Rapid + Subagent    |   103 |     43 |     41.7% |      10 |
| Ello Thorough            |   103 |     44 |     42.7% |      10 |
| Ello Thorough + Subagent |   103 |     41 |     39.8% |      10 |
| Claude Code              |   107 |     48 |     44.9% |       6 |

Ello Rapid is 18 wins, 66 ties, and 20 losses against Claude Code across valid pairs, a near-tie in accuracy. Paired resource results are:

| vs Claude Code           |       Elapsed |  Model rounds | Command / Tool calls |  Input / output tokens |
| ------------------------ | ------------: | ------------: | -------------------: | ---------------------: |
| Ello Rapid               | ↓12.1% (n=94) | ↓22.8% (n=94) |        ↓29.2% (n=94) | ↓35.4% / ↓13.4% (n=85) |
| Ello Rapid + Subagent    | ↓14.1% (n=93) | ↓20.6% (n=93) |        ↓32.5% (n=93) | ↓36.3% / ↓13.0% (n=79) |
| Ello Thorough            |  ↓1.4% (n=93) |  ↓4.4% (n=93) |        ↓13.1% (n=93) |   ↓9.4% / ↓8.7% (n=81) |
| Ello Thorough + Subagent |  ↑1.2% (n=93) |  ↓6.3% (n=93) |        ↓13.3% (n=93) |   ↓9.4% / ↓1.6% (n=75) |

See the [evidence record](../../docs/benchmark/current-task-set-record.md), [generated report](../../docs/benchmark/results/report.md), [structured suite result](../../docs/benchmark/results/suite-report.json), and [methodology](../../docs/benchmark/benchmark-methodology.md).

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
├── README.md
├── report.md
├── suite-report.json
├── agents/
├── comparisons/
└── charts/
```

Per-task instructions, patches, harnesses, and attempt manifests are not copied into Git. Verifier logs, full evidence, tool audits, and phase timings also stay in raw storage; aggregate and per-task outcomes remain in `suite-report.json`.

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
pnpm exec eslint packages/ello-bench/src packages/ello-bench/tests
pnpm --filter @ello/bench build
```

See [Benchmark architecture](../../docs/benchmark/architecture.md) for the full state machine and artifact contracts.
