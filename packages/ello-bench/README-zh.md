# @ello/bench

`@ello/bench` 是可复现的编码 Agent 基准评测工具。它将严格 TOML 定义展开为
`任务 x Agent x 重复次数` 矩阵，在题目固定的 Docker 镜像中运行每个 job，保留
原始证据，在全新容器中执行 verifier，并生成 JSON、Markdown 与 SVG 报告。

默认 DeepSWE 矩阵比较三个 Agent：

- `ello`：开启 subagent 的 Ello
- `ello-no-subagent`：使用相同 Ello 模型但关闭 subagent
- `codex`：使用相同主模型与 reasoning effort 的 Codex

## Suite

| Suite                       | 题目数 | 用途                  | 语料                                         |
| --------------------------- | -----: | --------------------- | -------------------------------------------- |
| `deep-swe-v1.1`             |     20 | 稳定的优化与 A/B 目标 | 固定 revision 的 `datacurve-ai/deep-swe`     |
| `swe-bench-pro-calibration` |     30 | 跨评测框架校准        | 固定 revision 的 `scaleapi/SWE-bench_Pro-os` |

未传 `--corpus-root` 时，语料会克隆到
`packages/ello-bench/raw/_cache/<suite>/`。复用已有语料时，origin、HEAD 必须与
配置固定值一致，工作树也必须干净。

## 环境要求

- Node.js 24+
- pnpm 11
- Git
- Docker CLI 与当前 shell 可访问的 Docker daemon
- 所选 Agent 所需的凭据和固定版本外部二进制

harness 不依赖宿主 Python，也没有 Python 绘图依赖。若题目契约本身使用 Python
verifier（例如 SWE-bench Pro），它只在题目镜像内执行。

## 配置

TOML 是唯一配置格式。默认入口是
[`config/benchmark.toml`](config/benchmark.toml)，它通过 `agents_file` 引用
[`config/agents.toml`](config/agents.toml)。

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

schema 是严格的：未知字段、缺失字段、重复 ID 或非法组合会在执行前失败。
`network = "task"` 为固定语义，实际网络由每题的 `allow_internet` 推导，benchmark
配置不能覆盖题目契约。

配置经 schema 校验后会被冻结；`configHash` 对递归 key 排序后的规范化 JSON
计算，因此 TOML 注释、排版与 key 顺序不会改变语义哈希。运行前可查看精确解析结果：

```bash
pnpm --filter @ello/bench bench config print --resolved
```

模板位于 [`config/examples/agents.toml`](config/examples/agents.toml)、
[`config/examples/deep-swe.toml`](config/examples/deep-swe.toml) 和
[`config/examples/swe-bench-pro.toml`](config/examples/swe-bench-pro.toml)。
配置文件可放在任意位置，`agents_file` 始终相对 benchmark TOML 所在目录解析。

凭据只写环境变量名，不写入 TOML：

```bash
export ELLO_BENCH_API_KEY=<token>
export ELLO_BENCH_CODEX_EXE=/absolute/path/to/codex
# 仅当所选配置包含 Claude Code 时需要：
export ELLO_BENCH_CLAUDE_EXE=/absolute/path/to/claude
```

外部 Agent 配置同时固定 `expected_version` 与 `sha256`。`doctor` 会检查文件、
校验和、标准版本输出以及无交互 JSON 执行所需的 CLI 参数。

## Docker-only 执行

不存在 local runtime。每个任务工作区都从其固定镜像提取，每次 verifier 也会用
同一镜像新建独立容器。

- `allow_internet = false` 落为 `docker run --network none`，否则为 `bridge`。
- 题目的 `cpus`、`memory_mb` 落为 Docker 原生资源限制。
- `storage_mb` 由 watchdog 强制执行：将 bind-mounted 工作区的 apparent bytes
  与 Docker writable layer 的 `SizeRw` 合并计入同一预算；工作区计量不跟随
  symlink，超限立即终止所属容器，并在 patch 捕获前和 verifier 结束后强制审计。
  该方案跨 Docker storage driver 生效；`--storage-opt` 无法限制 bind mount，
  因此不使用。
- 容器使用宿主 UID/GID，并配置可写的 benchmark HOME。
- Codex 与 Claude Code 二进制会复制到题目容器并在容器内执行。
- Ello App Server 留在宿主，但任务 shell 与文件系统操作全部经容器 `/app` 路由。
- `cleanup = "always" | "on-success" | "never"` 控制 Agent 容器保留策略；
  verifier 容器始终清理。

每个 attempt 都会在 `docker-preflight.json` 与 `network-policy.json` 中记录实际
镜像、用户、网络、CPU、内存和存储策略。

## 命令

CLI 运行编译产物，因此先构建：

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

`plan`、`run` 必须显式选择任务和 Agent；`doctor` 必须显式选择 Agent。先跑单题
pilot：

```bash
pnpm --filter @ello/bench bench doctor --all-agents

pnpm --filter @ello/bench bench run \
  --task actionlint-action-pinning-lint \
  --all-agents \
  --run-root /absolute/path/to/deep-swe-pilot-001 \
  --report
```

执行 Part A 完整 20 题三方矩阵：

```bash
pnpm --filter @ello/bench bench run \
  --all \
  --all-agents \
  --run-root /absolute/path/to/deep-swe-part-a-001 \
  --report
```

run root 会永久绑定语义 `configHash`、`planHash`、任务集、Agent 集与重复次数。
相同输入可断点续跑；任何输入变化都必须使用新的空 run root。

## 结果与重试

每个 attempt 只有一套 application phase 状态机。语料、容器、Agent
准备/进程/证据、patch 捕获或 verifier 执行失败都会标为基础设施无效，并按
`max_infrastructure_retries` 重试。

verifier baseline 非零会分类为 `baseline-unhealthy`，不会算 Agent 失败，也不会
记为 reward `0`；它会进入报告 invalid ledger。只有 baseline 健康的 attempt 才
进入评分分母，此时由新测试退出码决定 reward `0` 或 `1`。

## 证据与报告

Ello 将脱敏 EngineEvent 归档为可恢复、追加写的 JSONL。主线程必须恰好有一份
`thr_*` capture，subagent 可有零到多份 `job_*` capture。未知前缀、capture
缺失、sequence 间断、生命周期计数不一致或 checksum 不一致都会让验证失败。

标准化证据分别记录 main、subagent 和 combined token/tool usage。报告与可发布性
门禁使用 combined usage，避免漏算委派工作的成本。

`report` 产物结构：

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

报告层为纯 TypeScript。Markdown 与七张图都是确定性的文本渲染器，图表格式为
SVG。`render_charts = false` 时仍生成 JSON 和 `report.md`，只跳过 `charts/`。

完成后独立生成报告并验证：

```bash
pnpm --filter @ello/bench bench report --run-root /absolute/path/to/run
pnpm --filter @ello/bench bench validate --run-root /absolute/path/to/run
```

## 架构

源码强制单向向内依赖：

- `domain/`：契约以及纯计划、证据、评分逻辑
- `application/`：只通过 ports 编排 attempt 和矩阵
- `ports/`：只有类型与接口的运行时契约
- `infra/`：文件系统、进程、Docker、Agent、verifier、语料与报告持久化
- `render/`：纯 Markdown 与 SVG 渲染
- `cli/`：面向 composition 的命令入口

ESLint 禁止 domain/application/ports/render 导入不允许的外层或 Node I/O API。
源码根目录只保留 package 导出和两个可执行进程入口，活动实现位于上述分层目录。
