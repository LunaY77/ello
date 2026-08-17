# @ello/bench

<p align="center"><a href="../../README.md">项目首页</a> · <strong>简体中文</strong> · <a href="README-en.md">English</a></p>

`@ello/bench` 是 Ello 的可复现 Coding Agent Benchmark harness。它把严格 TOML 配置展开为 `task × agent × replicate` 矩阵，在固定 Docker 环境中运行 Agent，用新的同镜像容器验证 patch，保存 retry lineage 和规范化 evidence，并生成 JSON、Markdown 与 SVG 报告。

## 当前发布结果

DeepSWE v1.1 当前记录固定同一个 DeepSeek V4 Flash 0731 模型、High reasoning、完整 113-task suite 和同一 Docker/verifier 契约。565 个计划 job 中有 520 个 scored、45 个 infrastructure-invalid：

| Agent                    | 有效 | 通过 | 通过率 | invalid |
| ------------------------ | ---: | ---: | -----: | ------: |
| Ello Rapid               |  104 |   46 |  44.2% |       9 |
| Ello Rapid + Subagent    |  103 |   43 |  41.7% |      10 |
| Ello Thorough            |  103 |   44 |  42.7% |      10 |
| Ello Thorough + Subagent |  103 |   41 |  39.8% |      10 |
| Claude Code              |  107 |   48 |  44.9% |       6 |

Ello Rapid 对 Claude Code 的有效配对结果为 18 胜、66 平、20 负，准确率近似持平。配对资源结果如下：

| 相对 Claude Code         |       elapsed |      模型轮次 | Command / Tool 调用 |   input / output token |
| ------------------------ | ------------: | ------------: | ------------------: | ---------------------: |
| Ello Rapid               | ↓12.1% (n=94) | ↓22.8% (n=94) |       ↓29.2% (n=94) | ↓35.4% / ↓13.4% (n=85) |
| Ello Rapid + Subagent    | ↓14.1% (n=93) | ↓20.6% (n=93) |       ↓32.5% (n=93) | ↓36.3% / ↓13.0% (n=79) |
| Ello Thorough            |  ↓1.4% (n=93) |  ↓4.4% (n=93) |       ↓13.1% (n=93) |   ↓9.4% / ↓8.7% (n=81) |
| Ello Thorough + Subagent |  ↑1.2% (n=93) |  ↓6.3% (n=93) |       ↓13.3% (n=93) |   ↓9.4% / ↓1.6% (n=75) |

- [当前证据记录](../../docs/benchmark/current-task-set-record.md)
- [生成报告](../../docs/benchmark/results/report.md)
- [结构化 suite 结果](../../docs/benchmark/results/suite-report.json)
- [方法论](../../docs/benchmark/benchmark-methodology.md)

## 执行流水线

```mermaid
flowchart LR
  Config[TOML Config] --> Plan[Task x Agent x Replicate]
  Plan --> Attempt[Attempt State Machine]
  Attempt --> Base[Baseline Preflight]
  Base --> Agent[Agent in Task Environment]
  Agent --> Patch[Capture model.patch]
  Patch --> Verify[Fresh Verifier Container]
  Verify --> Evidence[Run / Evidence / Harness]
  Evidence --> Report[JSON / Markdown / SVG]
```

每个 job 的流程：

1. 校验 corpus revision、task identity、Agent binary/model 和语义 config hash。
2. 从任务 image 创建干净 Container Environment。
3. 在未修改代码上执行 baseline preflight；环境不健康不会伪装成 Agent reward 0。
4. 启动 Agent，记录 model、round、Command/Tool、usage、phase 和进程结果。
5. 捕获相对 baseline tree 的 `model.patch`。
6. 在新的 verifier 容器中应用 patch，执行固定 assertion 并得到 binary reward。
7. 写入 terminal attempt；基础设施失败按固定额度重试，任务失败不重试。
8. 独立生成 report，并从 raw artifact 重新校验报告一致性。

## Suite 与配置

当前内置两个固定子集：

| Suite                       | 任务数 | 用途                        |
| --------------------------- | -----: | --------------------------- |
| `deep-swe-v1.1`             |    113 | 长程功能实现与 Agent 对比   |
| `swe-bench-pro-calibration` |     30 | issue 修复与跨 harness 校准 |

TOML 是唯一运行配置格式。默认入口是 [`config/benchmark.toml`](config/benchmark.toml)，Agent 定义位于 [`config/agents.toml`](config/agents.toml)。

```toml
schema = "ello.benchmark.config.v2"
suite = "deep-swe-v1.1"
agents_file = "agents.toml"

[execution]
replicates = 1
concurrency = 16
max_infrastructure_retries = 5

[report.publishability]
require_complete_matrix = true
require_complete_usage = true
require_tool_audit = true

[container]
pull_policy = "if-absent"
network = "bridge"
cleanup = "always"
```

配置是 strict schema：unknown field、缺失值、重复 ID 和非法组合在执行前失败。规范化配置计算 `configHash`；task、Agent、replicate 和配置形成 `planHash`。已有 run root 只允许用相同 identity resume，输入变化必须创建新的 run root。

凭据和外部二进制只通过命名环境变量引用，不能写入 TOML 或 artifact。外部 Agent 还固定 canonical version 与 executable SHA-256，`doctor` 在运行前校验。

## Docker 与 Environment

Benchmark 没有 local task runtime：

- workspace 从任务固定 image 提取；
- Agent 修改发生在分配给该 job 的容器路径空间；
- verifier 使用新的同镜像容器；
- CPU、memory、storage、user、network 和 timeout 都进入 attempt artifact；
- storage watchdog 同时计算 bind-mounted workspace apparent bytes 与 Docker `SizeRw`；
- external Agent binary 复制进任务容器执行；
- Ello App Server 使用 `@ello/agent/runtime` 注入 Container Environment，Agent engine 无需知道 Docker。

每个 Ello job 还有独立 App Server 子进程、state root、Unix socket 和 EngineEvent recorder。普通 `ello --remote ... --json --no-tui run` Client 通过生产 JSON-RPC 路径启动 Thread。

## Attempt 与恢复

```text
planned -> preparing -> running -> capturing -> verifying -> completed
              \________________________________________-> invalid_infrastructure
```

`completed` 表示 verifier 给出了有效 reward；`invalid_infrastructure` 表示该 attempt 没有有效测量 Agent 能力。只有 infrastructure-invalid 可以消耗 retry budget。

runner 重启时先尝试从已经落盘的 verifier report 收割 verdict。报告与发布归档都以每个 job 的最后一个 completed attempt 为权威结果，并保留全部 invalid ledger。validator 接受明确链接的 `retryOf + resume-interrupted-run` salvage lineage，但仍拒绝普通 completed 后重跑。

## Evidence 与统计

Raw run 保存三层事实：

| 层             | 主要内容                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| Attempt        | identity、phase、runtime、patch、process、harness、failure 和 provenance |
| Agent evidence | model round、main/subagent usage、Command/Tool event、tool audit         |
| Verifier       | baseline、新测试、assertion、stdout/stderr、patch checksum               |

报告只让有对应 evidence 的 completed run 进入资源分布，缺失 usage 不填 0。配置级同时显示 mean、median、p95 和 coverage；Task 级并列 Agent 的 outcome、elapsed、round、tools 和 token。

`validate` 会重新读取所有 attempt，校验路径边界、schema、checksum、retry lineage、runtime identity、evidence 和 published report，而不是只检查 JSON 能否解析。

## Raw 与 Git 发布产物

完整 raw run 保留在 ignored 的 `packages/ello-bench/raw/`。Git 发布集位于 `docs/benchmark/results/`：

```text
results/
├── README.md
├── report.md
├── suite-report.json
├── agents/
├── comparisons/
└── charts/
```

Git 发布集不复制逐 Task instruction、patch、harness 或 attempt manifest。stdout/stderr、完整 evidence、tool audit 和 phase timing 也留在 raw run；聚合统计、逐 task outcome 与 coverage 已进入 `suite-report.json`。

## CLI

先构建 compiled CLI：

```bash
pnpm --filter @ello/bench build
```

```text
ello-bench list [--config PATH]
ello-bench config print --resolved [--config PATH]
ello-bench agents [--config PATH]
ello-bench plan (--task ID | --all) (--agent ID | --all-agents)
ello-bench doctor (--agent ID | --all-agents)
ello-bench run (--task ID | --all) (--agent ID | --all-agents)
               --run-root PATH [--corpus-root PATH] [--report]
ello-bench report --run-root PATH
ello-bench validate --run-root PATH
```

先执行单题 pilot，再启动完整矩阵：

```bash
pnpm --filter @ello/bench bench doctor --all-agents

pnpm --filter @ello/bench bench run \
  --task actionlint-action-pinning-lint \
  --all-agents \
  --run-root /absolute/path/to/pilot \
  --report
```

## 分层架构

源码依赖方向为 `cli -> infra -> application -> domain`：

| 层            | 责任                                                     |
| ------------- | -------------------------------------------------------- |
| `domain`      | strict contracts、hash、selection、evidence、scoring     |
| `application` | attempt phase 与 matrix orchestration                    |
| `ports`       | Agent、Container、Corpus、Verifier、Artifact 等宿主接口  |
| `infra`       | Docker、filesystem、process、adapter、report persistence |
| `render`      | 不读取文件的纯 Markdown / SVG renderer                   |
| `cli`         | command composition                                      |

ESLint 阻止内层反向 import Node I/O 或外层实现。Agent adapter、Docker 和报告持久化可以替换，但 scoring 与 contract 不依赖它们。

## 验证

```bash
pnpm --filter @ello/bench test
pnpm --filter @ello/bench typecheck
pnpm exec eslint packages/ello-bench/src packages/ello-bench/tests
pnpm --filter @ello/bench build
```

更详细的执行状态、artifact 和发布规则见 [Benchmark 架构](../../docs/benchmark/architecture.md)。
