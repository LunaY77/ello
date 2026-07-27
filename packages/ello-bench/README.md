# @ello/bench

`@ello/bench` is a reproducible coding-agent benchmark harness. It compares Ello against Claude Code by running both agents through the same tasks, same instructions, same Docker images, and the same verifier — producing a scored `task × agent × replicate` matrix with full evidence provenance.

## The two benchmarks

| | DeepSWE v1.1 | SWE-bench Pro calibration |
|---|---|---|
| **Suite ID** | `deep-swe-v1.1` | `swe-bench-pro-calibration` |
| **Tasks** | 20, curated | 30, selected from 731 |
| **Selection** | Hand-picked for diversity | Balanced across language groups and public-trajectory difficulty |
| **Source repo** | Bundled with the suite | `scaleapi/SWE-bench_Pro-os` (external) |
| **Purpose** | Stable optimization target | Upstream comparability |
| **Corpus** | Auto-cloned, no extra setup | Needs `--corpus-root` or auto-clone from GitHub |
| **Verifier** | Container-based test harness | Upstream `run_script.sh` + `parser.py` |

**DeepSWE** is the primary suite for day-to-day iteration — the task set is fixed, the corpus ships with the suite, and there's no external dependency.

**SWE-bench Pro** uses a fixed 30-task calibration set from the public 731-task dataset. Python, Go, and TypeScript/JavaScript contribute 10 tasks each; the four difficulty bands contain 8, 7, 8, and 7 tasks.

## Chinese methodology and records

- [Architecture and evidence boundaries](../../docs/benchmark/architecture-zh.md)
- [Benchmark methodology](../../docs/benchmark/benchmark-methodology-zh.md)
- [SWE-bench Pro 30-task selection record](../../docs/benchmark/swe-bench-pro-selection-zh.md)
- [Early Ello / Claude Code calibration record](../../docs/benchmark/current-test-set-record-zh.md)
- [How to read rounds, tools, and tokens](../../docs/benchmark/blog-rounds-tools-tokens-zh.md)

## Quick start

### 1. Create your config files

```bash
cp packages/ello-bench/config/examples/agents.config.mjs \
   packages/ello-bench/config/agents.config.mjs
cp packages/ello-bench/config/examples/report.config.mjs \
   packages/ello-bench/config/report.config.mjs
```

Pick a suite:

```bash
# DeepSWE (no external corpus needed):
cp packages/ello-bench/config/examples/deep-swe.config.mjs \
   packages/ello-bench/config/benchmark.config.mjs

# or SWE-bench Pro:
cp packages/ello-bench/config/examples/swe-bench-pro.config.mjs \
   packages/ello-bench/config/benchmark.config.mjs
```

### 2. Fill in your credentials and model details

Edit `config/agents.config.mjs`. The template is valid syntax but contains placeholder values. You must replace:

| Field | What to put |
|---|---|
| `models.<name>.apiModel` | Your provider's model ID |
| `models.<name>.baseUrl` | Provider base URL |
| `models.<name>.apiKeyEnv` | Name of the env var holding your API key |
| `binary.pathEnv` (Claude Code) | Name of the env var holding the CLI's absolute path |
| `binary.expectedVersion` | Exact `--version` output of the pinned CLI |
| `binary.sha256` | SHA-256 of the CLI executable |

Get the Claude Code checksum:

```bash
sha256sum "$ELLO_BENCH_CLAUDE_EXE" | cut -d' ' -f1
```

### 3. Set environment variables

```bash
export ELLO_BENCH_API_KEY=<your-api-token>
export ELLO_BENCH_CLAUDE_EXE=/absolute/path/to/claude
```

### 4. Build and verify

```bash
pnpm install
pnpm build

pnpm bench:validate    # confirm config & suite integrity
pnpm bench:agents      # list configured agents
pnpm bench:doctor --all-agents  # full preflight
```

### 5. Run a pilot

DeepSWE (no extra setup):

```bash
pnpm bench:run \
  --task actionlint-action-pinning-lint \
  --all-agents \
  --run-root packages/ello-bench/raw/pilot-001
```

SWE-bench Pro (needs the corpus — see below):

```bash
pnpm bench:run \
  --config packages/ello-bench/config/benchmark.config.mjs \
  --corpus-root ../SWE-bench_Pro-os \
  --task swepro-navidrome-29b7b740 \
  --agent ello \
  --run-root packages/ello-bench/raw/swepro-pilot-001
```

Run the complete 30-task matrix:

```bash
pnpm bench:run \
  --all \
  --all-agents \
  --run-root packages/ello-bench/raw/publish-001
```

### 6. Generate the report

```bash
pnpm bench:report \
  --run-root packages/ello-bench/raw/pilot-001
```

Add `--report` to `bench:run` to generate the report in a single command:

```bash
pnpm bench:run --all --all-agents --run-root ... --report
```

## What `--corpus-root` is

Each benchmark suite needs a local Git checkout of the task corpus — the repository that contains each task's source code, tests, and Docker setup.

- **DeepSWE**: the corpus is small and bundled; `--corpus-root` is optional. If omitted, it auto-clones into `raw/_cache/deep-swe/`.

- **SWE-bench Pro**: the corpus is `scaleapi/SWE-bench_Pro-os` — a large external repository. If you already have it cloned (e.g. at `../SWE-bench_Pro-os` relative to `repos/ello`), pass `--corpus-root ../SWE-bench_Pro-os` to reuse that clone. Otherwise the harness clones it fresh into `raw/_cache/swe-bench-pro/`.

In short: `--corpus-root` points the harness at an existing clone so you don't download it again.

## Commands

All commands have `pnpm bench:<name>` shortcuts defined at the repo root. Pass flags directly:

```bash
pnpm bench:run --all --all-agents --run-root packages/ello-bench/raw/publish-001
pnpm bench:report --run-root packages/ello-bench/raw/publish-001
```

The raw CLI is also available:

```
ello-bench list [--config PATH]              List tasks in the configured suite
ello-bench agents [--config PATH]            List configured agents
ello-bench plan (--task ID | --all)          Dry-run: print the job matrix
                 (--agent ID | --all-agents)
                 [--config PATH]
ello-bench doctor (--agent ID | --all-agents)  Preflight checks (no model calls)
                  [--config PATH]
ello-bench run (--task ID | --all)           Execute the benchmark
               (--agent ID | --all-agents)
               --run-root PATH
               [--corpus-root PATH]
               [--report]
               [--config PATH]
ello-bench report --run-root PATH            Aggregate results into JSON + charts
ello-bench validate [--run-root PATH]        Validate config (no arg) or a
                 [--config PATH]             completed run (with --run-root)
```

Agent selection is **mandatory** for `run`, `plan`, and `doctor`. There is no default agent.

Each `run` produces artifacts under `--run-root`. A run root permanently records the config hash, plan hash, task selection, and agent selection. Any input change requires a new run root.

## Configuration layout

Three files, kept in `packages/ello-bench/config/`:

| File | Purpose |
|---|---|
| `benchmark.config.mjs` | Suite selection + execution params (replicates, concurrency, retries) |
| `agents.config.mjs` | Agent definitions, model endpoints, executable paths |
| `report.config.mjs` | Chart rendering toggle + publishability gates |

All three are ESM modules with strict schema validation. Unknown fields, missing fields, duplicate agents, or illegal states fail immediately. JSON configuration is not accepted.

### Publishability gates

In `report.config.mjs`:

```js
export const report = {
  renderCharts: true,         // Set false to skip Python chart generation
  publishability: {
    requireCompleteMatrix: true,   // Every planned job must have a final attempt
    requireCompleteUsage: true,    // Every scored run must report token usage
    requireToolAudit: true,        // Every run must pass tool audit
  },
};
```

When `renderCharts` is `false`, the `report` command only produces JSON — no `report.md` and no PNG charts.

## What a run produces

```
<attempt-root>/
├── run.json
├── workspace/              # The agent's view of the task repo
├── agent-state/            # Agent-internal state checkpoint
└── raw/
    ├── task/
    │   ├── instruction.md
    │   └── resolved-task.json
    ├── docker-preflight.json
    ├── agent/
    │   ├── identity.json       # Agent, model, commit
    │   ├── invocation.json     # Exact CLI args and env
    │   ├── process.json        # PID, exit code, timing
    │   ├── stdout.jsonl
    │   ├── stderr.log
    │   ├── evidence.json       # Normalized model + tool events
    │   ├── tool-audit.json     # Every tool call validated
    │   ├── rounds.jsonl
    │   └── adapter/            # Agent-specific raw capture
    ├── phase-timings.json
    ├── git-status.txt
    ├── model.patch
    └── harness/                # Verifier output
```

Validation re-parses raw agent output and compares it with normalized evidence — it never trusts the runner's in-memory state. Every artifact is linked by path, byte count, and SHA-256.

## Report output

After `bench report --run-root ...`:

```
<run-root>/results/
├── suite-report.json                        # Full matrix, scores, publishability
├── agents/<agent-id>.json                   # Per-agent pass rate & resource stats
├── tasks/<task-id>/<agent-id>.json          # Per-task per-agent score
├── comparisons/<left>-vs-<right>.json       # Paired win/tie/loss across agents
├── report.md                                # (if renderCharts: true)
└── charts/*.png                             # (if renderCharts: true)
```

Reports never pool pass rates across agents. An infrastructure-invalid pair is excluded, not scored as a win for the other side.

## Environment variables

Credentials stay in env vars, never in config files, CLI args, or run artifacts.

| Variable | Used by |
|---|---|
| `ELLO_BENCH_API_KEY` | Ello agent (or whatever `apiKeyEnv` you configure) |
| `ELLO_BENCH_CLAUDE_EXE` | Claude Code agent (or whatever `pathEnv` you configure) |
| `ANTHROPIC_BASE_URL` | Injected into Claude Code subprocess only |
| `ANTHROPIC_AUTH_TOKEN` | Injected into Claude Code subprocess only |

中文说明见 [README-zh.md](README-zh.md).
