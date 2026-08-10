# Benchmark 框架架构

## 目标

`@ello/bench` 把严格 TOML 配置展开为 `task × agent × replicate` 矩阵，在任务固定的 Docker 环境中执行每个 job，保存可恢复的 attempt 证据，在新容器中运行 verifier，并生成机器可读 JSON、Markdown 与 SVG 报告。

框架的核心约束是：运行身份不可漂移、基础设施失败不伪装成任务失败、缺失 usage 不用推测值填充、发布结论可以回到具体 patch 与 verifier 输出。

## 分层

源码依赖方向从外向内收敛：

```text
cli -> infra -> application -> domain
                    ^            ^
                    |            |
                  ports        render
```

| 层             | 责任                                                              |
| -------------- | ----------------------------------------------------------------- |
| `domain/`      | 严格合同、hash、suite 选择、evidence 归一化、scoring 与统计       |
| `application/` | 单 attempt phase machine、矩阵调度与重试编排                      |
| `ports/`       | Agent、Docker、corpus、artifact store 等宿主接口                  |
| `infra/`       | 文件系统、进程、Docker、Agent adapter、verifier、报告持久化与验证 |
| `render/`      | 纯 Markdown 和 SVG 渲染，不读取文件或启动进程                     |
| `cli/`         | `list`、`plan`、`doctor`、`run`、`report`、`validate` 组合入口    |

ESLint 阻止 domain/application/ports/render 反向依赖 Node I/O 或外层实现。报告统计在 domain 中完成，renderer 只消费 `SuiteReport`，因此 Markdown、JSON 和图表共享同一个事实源。

## 仓库布局

```text
packages/ello-bench/
├── config/
│   ├── benchmark.toml
│   ├── agents.toml
│   └── examples/
├── scripts/
│   ├── build.mjs
│   ├── run-status.mjs
│   ├── check-agent-selection.mjs
│   └── archive-doc-results.mjs
├── src/
│   ├── application/
│   ├── cli/
│   ├── domain/
│   ├── infra/
│   ├── ports/
│   └── render/
├── tests/
├── raw/                         # ignored corpus cache 与本地 run root
└── dist/                        # ignored build output

docs/benchmark/results/          # 可随 Git 发布的精选证据
```

TOML 是唯一运行配置格式。unknown field、重复 ID、缺失值或非法组合在执行前失败；配置对象经规范化 key sort 后计算语义 hash，注释、格式和 table key 顺序不会改变身份。

## 固定身份

首次运行会创建 `suite-manifest.json`，固定：

- suite metadata 与上游 revision；
- task set hash、选中的 task/agent/replicate；
- config hash 与 plan hash；
- 完整 job matrix；
- 每个 job 的 attempt lineage。

同一 run root 用于 resume，不用于改变矩阵。任务集、Agent 集合、replicate 或影响 job identity 的配置发生变化时，应创建新的 run root。

## Attempt 状态机

```text
planned
  -> preparing
  -> running
  -> capturing
  -> verifying
  -> completed

任一执行态 -> invalid_infrastructure
```

`completed` 表示 verifier 已产生有效 reward，`invalid_infrastructure` 表示任务能力未被有效评分。runner 被中断后，resume 会先尝试收割已经落盘的 verifier verdict；无法收割时把非终态 attempt 关闭为 `resume-interrupted-run`，再在重试额度内创建新 attempt。

attempt ID 由 config hash、job ID、attempt number 和 run root 确定性派生。Suite manifest 是 active lineage 的事实源；报告保留全部 invalid attempt ledger，但配置通过率只读取每个 job 的最终有效结果。

## Docker 执行边界

每个 task 声明固定 image、base commit、网络、CPU、内存、存储与 timeout：

1. 从任务镜像提取干净 workspace。
2. 在未修改 workspace 上执行 verifier baseline preflight。
3. 在任务容器中运行 Agent 文件与 Shell 操作；Ello App Server 可保留在宿主进程。
4. 捕获相对 baseline tree 的 `model.patch`。
5. 在使用同一 image 的新容器中应用 patch 并运行 verifier。
6. 审计 workspace apparent bytes 与容器 writable layer `SizeRw`。

`allow_internet=false` 映射为 Docker `--network none`。容器使用宿主 UID/GID 与独立 benchmark HOME；凭据通过命名环境变量注入，不写入配置或 artifact。

## Evidence

Ello 保存 redacted EngineEvent JSONL，Claude Code adapter 保存 stream-json 原始源；二者都归一化为统一 evidence：

- round 状态与 per-round usage；
- main/subagent/combined token 和工具用量；
- Command/Tool 事件与 tool audit；
- client exit、timeout 与 elapsed；
- phase timings；
- patch hash、changed files 与 baseline tree；
- baseline/verifier 进程、stdout、stderr 和 assertion。

未知事件、sequence gap、lifecycle count 不一致或 checksum mismatch 会使 evidence validation 失败。降级 evidence 可以保留 verifier reward，但不进入资源分布；报告必须展示实际资源样本数。

## Raw Artifact

```text
<run-root>/
├── suite-manifest.json
├── runs/<task>/<agent>/r<replicate>/<attempt>/
│   ├── run.json
│   ├── agent-state/
│   └── raw/
│       ├── docker-preflight.json
│       ├── network-policy.json
│       ├── model.patch
│       ├── phase-timings.json
│       ├── task/
│       ├── agent/
│       │   ├── evidence.json
│       │   ├── rounds.jsonl
│       │   └── tool-audit.json
│       ├── baseline-preflight/
│       └── harness/
│           ├── process.json
│           ├── report.json
│           ├── stdout.log
│           └── stderr.log
└── results/
    ├── suite-report.json
    ├── report.md
    ├── agents/
    ├── tasks/
    ├── comparisons/
    └── charts/
```

`raw/` 和 `dist/` 不提交 Git。它们保留完整、可能很大的本地执行证据。

## 发布 Artifact

`docs/benchmark/results/` 是从完整 run root 派生的发布子集：聚合报告、suite JSON、图表，以及 `tasks/deep-swe/<task>/<agent>/` 下的 patch、结构化 verifier 结果与运行 manifest。逐 attempt 的 stdout/stderr、evidence、tool audit 和 phase timing 留在 ignored raw run，避免把诊断体积复制进 Git；发布 manifest 去除本机绝对路径，并记录每个公开文件的 SHA-256。

归档脚本在写入前要求 60 个 job 都有权威 `completed` verdict，并使用与报告一致的“最后一个 completed attempt”选择规则；它不会把 evidence coverage 不足伪装成完整资源矩阵。`suite-report.json.publishable` 仍由 complete matrix、complete usage 和 tool audit 三个配置 gate 决定。

## 验证入口

```bash
pnpm --filter @ello/bench test
pnpm --filter @ello/bench typecheck
pnpm exec eslint packages/ello-bench/src packages/ello-bench/tests
pnpm --filter @ello/bench build

pnpm --filter @ello/bench bench report --run-root <run-root>
pnpm --filter @ello/bench bench validate --run-root <run-root>
pnpm --filter @ello/bench bench:archive-docs -- --run-root <run-root>
```

单元测试、typecheck 和 lint 不应访问 provider、启动真实 benchmark 或消耗付费资源；`run`、`report` 后的 raw validation 和发布归档是独立验收步骤。
