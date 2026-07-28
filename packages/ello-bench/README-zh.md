# @ello/bench

`@ello/bench` 是编码 Agent 基准评测工具。它让 Ello、Claude Code 和 Codex 在相同任务、指令、执行 runtime 和 verifier 下运行，生成带完整证据溯源的 `task × agent × replicate` 评分矩阵。

## 两种 Benchmark

| | DeepSWE v1.1 | SWE-bench Pro calibration |
|---|---|---|
| **Suite ID** | `deep-swe-v1.1` | `swe-bench-pro-calibration` |
| **题目数** | 20 题，人工精选 | 30 题，从 731 题中精选 |
| **选题方式** | 按多样性手工挑选 | 按语言与公开轨迹难度分层 |
| **语料来源** | Suite 内置 | `scaleapi/SWE-bench_Pro-os`（外部仓库） |
| **用途** | 日常迭代优化的稳定目标 | 与社区结果可比较 |
| **语料获取** | 自动克隆，无需额外配置 | 需 `--corpus-root` 或从 GitHub 自动克隆 |
| **Verifier** | `test.sh` harness | 上游 `run_script.sh` + `parser.py` |

**DeepSWE** 是日常迭代的主 Suite——题目固定、语料内置、无外部依赖。

**SWE-bench Pro** 从公开的 731 题数据集中精选 30 题，用于稳定的 Agent 配对校准。Python、Go、TypeScript/JavaScript 各 10 题，四个难度档分别为 8、7、8、7 题。

## 中文文章

- [ello-bench 架构：从任务声明到可追溯报告](../../docs/benchmark/architecture-zh.md)
- [测评方法：如何公平比较编码 Agent](../../docs/benchmark/benchmark-methodology-zh.md)
- [SWE-bench Pro 30 题精选记录](../../docs/benchmark/swe-bench-pro-selection-zh.md)
- [早期 Ello / Claude Code 校准记录](../../docs/benchmark/current-test-set-record-zh.md)
- [轮次更少，不等于工具更少](../../docs/benchmark/blog-rounds-tools-tokens-zh.md)

## 快速开始

### 1. 创建配置文件

```bash
cp packages/ello-bench/config/examples/agents.config.mjs \
   packages/ello-bench/config/agents.config.mjs
cp packages/ello-bench/config/examples/report.config.mjs \
   packages/ello-bench/config/report.config.mjs
```

选择 Suite：

```bash
# DeepSWE（无需外部语料）：
cp packages/ello-bench/config/examples/deep-swe.config.mjs \
   packages/ello-bench/config/benchmark.config.mjs

# 或 SWE-bench Pro：
cp packages/ello-bench/config/examples/swe-bench-pro.config.mjs \
   packages/ello-bench/config/benchmark.config.mjs
```

### 2. 填入凭据和模型信息

编辑 `config/agents.config.mjs`。模板语法合法但值为占位符，必须替换：

| 字段 | 填写内容 |
|---|---|
| `models.<name>.apiModel` | Provider 的模型 ID |
| `models.<name>.baseUrl` | Provider 的 base URL |
| `models.<name>.apiKeyEnv` | 存放 API key 的环境变量**名** |
| `binary.pathEnv`（Claude Code/Codex） | 存放 CLI 绝对路径的环境变量名 |
| `binary.expectedVersion` | 固定的 CLI 版本号；适配器会按标准 `--version` 输出校验 |
| `binary.sha256` | CLI 可执行文件的 SHA-256 |
| `connection.baseUrl`（Codex） | OpenAI Responses 兼容 API 根地址，包含 `/v1` |
| `reasoningEffort`（Codex） | 固定的 Codex 推理档位 |

获取 Claude Code 校验和：

```bash
sha256sum "$ELLO_BENCH_CLAUDE_EXE" | cut -d' ' -f1
```

获取 Codex 校验和：

```bash
sha256sum "$ELLO_BENCH_CODEX_EXE" | cut -d' ' -f1
```

Codex 使用隔离的 `CODEX_HOME` 并忽略用户配置。适配器根据
`connection` 配置 Responses 兼容 provider，不复用交互式 Codex 登录。

### 3. 设置环境变量

```bash
export ELLO_BENCH_API_KEY=<your-api-token>
export ELLO_BENCH_CLAUDE_EXE=/absolute/path/to/claude
export ELLO_BENCH_CODEX_EXE=/absolute/path/to/codex
```

### 4. 构建与验证

```bash
pnpm install
pnpm build

pnpm bench:validate    # 确认配置与 Suite 完整性
pnpm bench:agents      # 列出已配置的 Agent
pnpm bench:doctor --all-agents  # 完整预检
```

### 5. 运行 Pilot

DeepSWE（无需额外配置）：

```bash
pnpm bench:run \
  --task actionlint-action-pinning-lint \
  --all-agents \
  --run-root raw/pilot-001
```

SWE-bench Pro（需要语料库——见下文）：

```bash
pnpm bench:run \
  --config config/benchmark.config.mjs \
  --corpus-root ../../../SWE-bench_Pro-os \
  --task swepro-navidrome-29b7b740 \
  --agent ello \
  --run-root raw/swepro-pilot-001
```

运行完整 30 题矩阵：

```bash
pnpm bench:run \
  --all \
  --all-agents \
  --run-root raw/publish-001
```

### 6. 生成报告

```bash
pnpm bench:report \
  --run-root raw/pilot-001
```

在 `bench:run` 中加 `--report` 可以一步完成运行和报告：

```bash
pnpm bench:run --all --all-agents --run-root ... --report
```

## `--corpus-root` 是什么

每个 Benchmark Suite 需要一份任务语料库（task corpus）的本地 Git 克隆——包含每个任务的源码、测试和 Docker 环境。

- **DeepSWE**：语料库较小且内置于 Suite，`--corpus-root` 可选。不传则自动克隆到 `raw/_cache/deep-swe/`。

- **SWE-bench Pro**：语料库是 `scaleapi/SWE-bench_Pro-os`，一个大型外部仓库。如果你已在 `repos/ello` 旁克隆好了（如 `../SWE-bench_Pro-os`），传入 `--corpus-root ../SWE-bench_Pro-os` 即可复用，避免重复下载。否则 harness 会自动克隆到 `raw/_cache/swe-bench-pro/`。

简而言之：`--corpus-root` 告诉 harness「语料库我已有，在这个路径，别重新下载」。

## 命令

所有命令在仓库根目录都有 `pnpm bench:<name>` 快捷方式。直接传递参数：

```bash
pnpm bench:run --all --all-agents --run-root packages/ello-bench/raw/publish-001
pnpm bench:report --run-root packages/ello-bench/raw/publish-001
```

原始 CLI 也可直接使用：

```
ello-bench list [--config PATH]              列出 Suite 中的所有任务
ello-bench agents [--config PATH]            列出已配置的 Agent
ello-bench plan (--task ID | --all)          预演：打印 job 矩阵
                 (--agent ID | --all-agents)
                 [--config PATH]
ello-bench doctor (--agent ID | --all-agents)  预检（不调用模型）
                  [--config PATH]
ello-bench run (--task ID | --all)           执行 Benchmark
               (--agent ID | --all-agents)
               --run-root PATH
               [--corpus-root PATH]
               [--report]
               [--config PATH]
ello-bench report --run-root PATH            聚合结果为 JSON + 图表
ello-bench validate [--run-root PATH]        验证配置（无参数）或已完成
                 [--config PATH]             的 run（带 --run-root）
```

`run`、`plan`、`doctor` 必须显式指定 Agent，不存在默认值。

每次 `run` 将产物写入 `--run-root`。run root 会永久记录 config hash、plan hash、任务选择和 Agent 选择。任何输入变更都需要新的 run root。

## 配置文件

三个文件，位于 `packages/ello-bench/config/`：

| 文件 | 用途 |
|---|---|
| `benchmark.config.mjs` | Suite 选择 + 执行参数（重复次数、并发、重试） |
| `agents.config.mjs` | Agent 定义、模型 endpoint、可执行文件路径 |
| `report.config.mjs` | 图表开关 + 可发布性门禁 |

三者均为严格 schema 校验的 ESM 模块。未知字段、缺字段、重复 Agent、非法状态都会立即报错，不接受 JSON 配置。

### Docker 或本地执行

在 `benchmark.config.mjs` 中设置 `execution.runtime`：

```js
execution: {
  runtime: 'local', // 也可以是 'docker'；省略时默认使用 Docker
  replicates: 1,
  concurrency: 2,
  maxInfrastructureRetries: 1,
}
```

`docker` 使用题目固定的镜像准备 Agent 工作区和 verifier。`local` 完全不调用 Docker：它从 `repositoryUrl` 克隆并 checkout 到 `baseCommitHash`，为 verifier 再创建一份独立 clone，所有 shell 命令都直接在宿主机运行。Ello、Claude Code 和 Codex 本身在两种模式下始终是宿主机进程。

本地模式要求宿主机已经具备项目需要的语言 runtime、系统包和依赖。镜像提供的 CPU、内存、网络和依赖保证均不再成立，因此本地结果适合开发调试，但不能直接与公开的 Docker 测评结果比较。该模式下 `bench:doctor` 会跳过全部 Docker 检查，改为检查基础宿主机工具链。

### 可发布性门禁

在 `report.config.mjs` 中：

```js
export const report = {
  renderCharts: true,         // 设为 false 跳过 Python 图表生成
  publishability: {
    requireCompleteMatrix: true,   // 每个计划的 job 都必须有最终 attempt
    requireCompleteUsage: true,    // 每个评分的 run 都必须报告 token 用量
    requireToolAudit: true,        // 每个 run 都必须通过工具审计
  },
};
```

`renderCharts` 为 `false` 时，`report` 命令仅输出 JSON——不生成 `report.md` 和 PNG 图表。

## Run 产物

```
<attempt-root>/
├── run.json
├── workspace/              # Agent 视角下的任务仓库
├── agent-state/            # Agent 内部状态快照
└── raw/
    ├── task/
    │   ├── instruction.md
    │   └── resolved-task.json
    ├── docker-preflight.json  # Docker 模式
    ├── local-preflight.json   # local 模式（二者只存在一个）
    ├── agent/
    │   ├── identity.json       # Agent、模型、commit
    │   ├── invocation.json     # 精确的 CLI 参数与环境变量
    │   ├── process.json        # PID、退出码、耗时
    │   ├── stdout.jsonl
    │   ├── stderr.log
    │   ├── evidence.json       # 标准化模型与工具事件
    │   ├── tool-audit.json     # 每次工具调用均已校验
    │   ├── rounds.jsonl
    │   └── adapter/            # Agent 专属原始捕获
    ├── phase-timings.json
    ├── git-status.txt
    ├── model.patch
    └── harness/                # Verifier 输出
```

Validation 从原始 Agent 输出重新解析并与标准化 evidence 比对——绝不信任 runner 内存状态。每件产物均以路径、字节数和 SHA-256 关联。

## 报告输出

执行 `bench report --run-root ...` 后：

```
<run-root>/results/
├── suite-report.json                        # 完整矩阵、评分、可发布性
├── agents/<agent-id>.json                   # 单 Agent pass rate 与资源统计
├── tasks/<task-id>/<agent-id>.json          # 单任务单 Agent 评分
├── comparisons/<left>-vs-<right>.json       # Agent 间配对 win/tie/loss
├── report.md                                # （renderCharts: true 时）
└── charts/*.png                             # （renderCharts: true 时）
```

报告不提供跨 Agent 的合并 pass rate。infrastructure-invalid 的配对会被排除，不记为对方胜利。

## 环境变量

凭据仅通过环境变量传入，不会写入配置文件、CLI 参数或 run artifact。

| 变量 | 使用者 |
|---|---|
| `ELLO_BENCH_API_KEY` | Ello Agent（或你配置的 `apiKeyEnv`） |
| `ELLO_BENCH_CLAUDE_EXE` | Claude Code Agent（或你配置的 `pathEnv`） |
| `ELLO_BENCH_CODEX_EXE` | Codex Agent（或你配置的 `pathEnv`） |
| `PYTHON` | 本地 verifier 使用的可选 Python 可执行文件（默认 `python3`） |
| `ANTHROPIC_BASE_URL` | 仅注入 Claude Code 子进程 |
| `ANTHROPIC_AUTH_TOKEN` | 仅注入 Claude Code 子进程 |

英文说明见 [README.md](README.md)。
