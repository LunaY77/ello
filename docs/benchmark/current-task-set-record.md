# 当前 Benchmark 证据记录

状态：2026 年 7 月 DeepSWE 两配置分析

## 1. 分析范围

本报告对比 Ello 与 Codex 两个完整 Agent 配置在 20 个固定 DeepSWE v1.1 任务上各 1 次重复的运行结果：共 40 个 scored job。报告分离配置级聚合与逐任务环境审计。当前为单 replicate，不做回归模型拟合；所有数字均为描述性汇总。

使用两种分析人群：

| 人群 | 任务数 | Job 数 | 用途 |
|---|---|---|---|
| 发布结果人群 | 20 | 40 | 边际通过率、配对、资源聚合 |
| 环境有效人群 | 7 | 14 | 事后诊断：排除共同环境失败后的可解释能力信号 |

环境有效人群是事后审计产物，不是正式分数。它以 verifier 能否运行到任务语义层为划分标准——两侧都因依赖缺失无法运行 verifier 的任务被排除。这 7 题子集不应被解释为新的 benchmark 或新的分数；它只是标注 raw pass rate 受污染程度的诊断工具。

## 2. 配置与来源

比较不是干净的 A/B test。两个配置同时改变运行时架构、prompt、工具协议、上下文策略和 round 语义。报告将配置名称当作完整 bundle，而非单一隔离机制。

| 配置 | 运行时 | 主模型 | 推理强度 | 辅助模型 | Scored job |
|---|---|---|---|---|---|
| Ello | Ello agent loop | `gpt-5.6-sol` | High | `deepseek-v4-pro-official` (medium) | 20 |
| Codex | Codex CLI binary | `gpt-5.6-sol` | High | — | 20 |

Ello 配置：上下文窗口 1,000,000、routing disabled、memory disabled、bypass enabled。Sub-agent delegation 运行时未装配（`enabled=false`）。工具面包括 `read`、`grep`、`glob`、`edit`、`apply_patch`、`write`、`bash` 等。

Codex 配置：使用固定版本 CLI binary。一次 CLI turn 在 adapter 中归一化为一个 round，内部实际发生了中位数 60 次工具调用。工具面由其 CLI 定义（`Read`、`Grep`、`Glob`、`Edit`、`Write`、`Bash` 等）。

**Round 定义不同。** Ello 的 round 接近内部 agent loop 迭代；Codex 的 round 是一次 CLI turn。因此 round 数量不能在不同 Agent 之间直接对比。跨系统最可比的工作量指标是工具调用数量和 elapsed time。

运行身份：

| 字段 | 值 |
|---|---|
| benchmark | DeepSWE v1.1 curated |
| 上游 revision | `a40d7298b18999c2d9b0ded7d6928e3ee26b5524` |
| 上游任务数 | 113 |
| 固定任务数 | 20 |
| 计划 job | 40 |
| scored job | 40 |
| final invalid | 0（按当前 harness schema） |
| runtime | `local`，非 Docker 固定镜像 |
| config hash | `ebeda1276936889c940ff941fc106acf356b4730638433f02835e4bb0200399a` |
| plan hash | `fade899fc8604e64d5c292e7638bad98d93c0ba9aae97912bab19880adc93d02` |
| task set hash | `c6cb3ef8b90ca30bd266178ff64291a22dd7a2536a83f1dfbe59e35bebadbb37` |

## 3. 结果

### 3.1 边际通过率

| Agent | 有效 job | 通过 | 通过率 | Wilson 95% CI |
|---|---|---|---|---|
| Ello | 20 | 6 | 30.0% | 14.5%–51.9% |
| Codex | 20 | 4 | 20.0% | 8.1%–41.6% |

### 3.2 配对结果

| Ello | Codex | 对数 |
|---|---|---|
| 通过 | 通过 | 4 |
| 通过 | 失败 | 2 |
| 失败 | 通过 | 0 |
| 失败 | 失败 | 14 |

配对差 `(2 − 0) / 20 = 10.0 个百分点`。18/20 对没有产生能力上的分歧。discordant pair 仅 2 对，不能从一次重复推断稳定优势。

### 3.3 环境审计：13 题共同污染

下列 13 题在 Ello 和 Codex 两侧都出现相同或等价的基础设施问题。它们的 `reward=0` 混合了环境失败和能力失败。

| 语言 | Task | 共同问题 |
|---|---|---|
| Python | `narwhals-rolling-window-suite` | `python: command not found` |
| Python | `numba-stencil-boundary-modes` | `No module named pytest` |
| Python | `bandit-incremental-cache-control` | `python: command not found` |
| Python | `langchain-request-coalescing` | `pytest: command not found` |
| TypeScript | `happy-dom-abort-pending-body-reads` | 缺少 `entities` |
| TypeScript | `dynamodb-toolbox-conditional-attribute-requirements` | 模块缺失 |
| TypeScript | `awilix-async-container-initialization` | `rimraf: command not found` |
| TypeScript | `quill-shared-toolbar-focus` | 测试运行环境/依赖失败 |
| Rust | `pest-character-class-coalescing` | 缺少 `pest_bootstrap` |
| JavaScript | `yjs-map-conflict-detection` | `ERR_MODULE_NOT_FOUND` |
| JavaScript | `testem-per-launcher-reports` | 缺少 `mocha` |
| JavaScript | `csstree-shorthand-expansion-compression` | 缺少 `mocha` |
| JavaScript | `katex-multicolumn-array-spans` | 缺少 `jest-serializer-html` |

Python 4/4 题全部受污染，TypeScript 4/4 题全部受污染，JavaScript 4/4 题全部受污染。三种语言在本轮无法提供有效的 Agent 能力信号。

**原因：** 本轮使用 `executionRuntime=local`，不是任务声明中的 Docker 镜像。环境依赖（Python、pytest、mocha、Node 模块、Rust 测试依赖等）未在运行前锁定。harness 当前不区分"Agent 完成了正确实现但测试环境不可用"和"Agent 的实现确实有语义错误"——这两种情况都被记为 `reward=0`。将基础设施失败当作零分会将 Agent 能力与 benchmark 可用性混淆。

### 3.4 环境有效子集：7 题

剩余 7 题的 verifier 能够运行到任务语义层：

| Task | 语言 | Ello | Codex | 诊断 |
|---|---|---|---|---|
| `actionlint-action-pinning-lint` | Go | 通过 | 通过 | 共同通过 |
| `abs-stepped-slices` | Go | 通过 | 通过 | 共同通过 |
| `yaegi-go-embed-directives` | Go | 通过 | 通过 | 共同通过 |
| `dasel-html-document-format` | Go | 失败 | 失败 | new tests 失败，两侧均未能实现完整 HTML 格式 |
| `wasmi-trap-coredumps` | Rust | 通过 | 失败 | Codex 使用私有字段，编译失败 |
| `fd-deterministic-multi-key-sorting` | Rust | 通过 | 通过 | 共同通过 |
| `boa-hierarchical-evaluation-cancellation` | Rust | 通过 | 失败 | Codex 新测试的取消语义失败 |
| **合计** | | **6/7** | **4/7** | |

Go 4 题两侧完全一致（3 共同通过 + 1 共同失败）。Ello 的正向信号完全来自 Rust 的 2 个分歧任务——`wasmi`（API 边界/私有字段）和 `boa`（取消语义）。在非 Rust 语言上没有证据表明 Ello 与 Codex 存在系统性能差异。

这个 7 题子集不是正式分数，不能替代 20 题 raw 结果，也不能推广到其他任务或语言。它的唯一用途是标注：在 verifier 可运行的前提下，两配置的行为差异在哪里。

## 4. 资源

### 4.1 逐任务详细

| Task | E/C reward | sec E | sec C | tools E | tools C | failed E | failed C |
|---|---|---|---|---|---|---|---|
| `actionlint-action-pinning-lint` | 1/1 | 932 | 637 | 117 | 82 | 2 | 5 |
| `abs-stepped-slices` | 1/1 | 392 | 535 | 56 | 49 | 0 | 3 |
| `yaegi-go-embed-directives` | 1/1 | 787 | 674 | 87 | 42 | 2 | 2 |
| `dasel-html-document-format` | 0/0 | 554 | 468 | 86 | 30 | 1 | 2 |
| `narwhals-rolling-window-suite` | 0/0 | 1,613 | 1,266 | 181 | 95 | 0 | 6 |
| `numba-stencil-boundary-modes` | 0/0 | 1,509 | 764 | 119 | 54 | 2 | 4 |
| `bandit-incremental-cache-control` | 0/0 | 859 | 736 | 94 | 45 | 1 | 4 |
| `langchain-request-coalescing` | 0/0 | 1,118 | 944 | 109 | 62 | 1 | 7 |
| `happy-dom-abort-pending-body-reads` | 0/0 | 788 | 722 | 90 | 66 | 1 | 6 |
| `dynamodb-toolbox-conditional-attribute-requirements` | 0/0 | 2,059 | 2,487 | 202 | 217 | 3 | 13 |
| `awilix-async-container-initialization` | 0/0 | 661 | 1,092 | 77 | 56 | 3 | 6 |
| `quill-shared-toolbar-focus` | 0/0 | 1,908 | 850 | 153 | 59 | 8 | 7 |
| `wasmi-trap-coredumps` | 1/0 | 1,700 | 2,378 | 163 | 159 | 2 | 6 |
| `fd-deterministic-multi-key-sorting` | 1/1 | 507 | 797 | 66 | 51 | 0 | 2 |
| `boa-hierarchical-evaluation-cancellation` | 1/0 | 951 | 680 | 115 | 76 | 1 | 2 |
| `pest-character-class-coalescing` | 0/0 | 1,521 | 908 | 94 | 67 | 1 | 3 |
| `yjs-map-conflict-detection` | 0/0 | 688 | 718 | 97 | 54 | 2 | 5 |
| `testem-per-launcher-reports` | 0/0 | 964 | 813 | 67 | 72 | 0 | 7 |
| `csstree-shorthand-expansion-compression` | 0/0 | 613 | 591 | 89 | 39 | 5 | 4 |
| `katex-multicolumn-array-spans` | 0/0 | 1,409 | 760 | 156 | 75 | 4 | 8 |

`sec` 为 Agent elapsed time；`tools` 为最终 attempt 的工具调用数；`failed` 为工具失败数。Codex 的 round 为 adapter 归一化值（均为 1），不在表中列出，也不应与 Ello 的 round 做数值对比。

### 4.2 资源中位数（全部 20 题）

| 指标 | Ello | Codex | 比值 (E/C) |
|---|---|---|---|
| elapsed | 941 秒 | 762 秒 | 1.17x |
| tool calls | 96 | 60 | 1.64x |
| input tokens | 3,439,323 | 3,047,424 | 1.22x |
| cache read | 2,966,016 | 2,857,088 | 1.04x |
| cache hit | 86.2% | 93.8% | — |
| uncached input | 473,307 | 190,336 | 2.49x |
| output tokens | 29,721 | 30,190 | 0.94x |

Ello 的 output token 略低，但 uncached input 约为 Codex 的 2.5 倍，cache hit 低于 Codex 约 7.6 个百分点。这说明 Ello 的请求前缀更容易变化，主要效率差距在"重复送入仓库和历史"而非"模型回答太长"。

## 5. 工具失败

| Agent | 工具 | 失败次数 |
|---|---|---|
| Codex | `command_execution` | 102 |
| Ello | `apply_patch` | 16 |
| Ello | `read` | 15 |
| Ello | `grep` | 4 |
| Ello | `edit` | 4 |

Codex 的 `command_execution` 失败多不等于 Codex 能力更弱。它可能来自 shell 命令粒度、依赖缺失（与 13 题共同环境失败重叠）、命令退出码和 adapter 分类。Ello 的 patch/read 失败则提示补丁上下文、文件定位和重试协议仍有工程优化空间。

不同运行时的工具失败计数不能直接对比——它们记录和批处理工作的方式不同，且失败定义（参数错误 vs 环境错误 vs 语义错误）未被统一分类。工具失败统计的用途是同一 Agent 内的诊断，不是跨 Agent 的排行榜。

## 6. 识别限界

本 benchmark 可以对比两个完整配置，但不能说明哪个单独特性导致了差异。可能的贡献因素——prompt、工具协议、上下文策略、round 语义和缓存行为——同时变化或被不同测量。跨任务的 round 和工具调用差异提供描述性信号，但不提供组件特定的因果估计。

其他限制：

- **单 replicate：** 对随机性敏感。同配置、同任务、同模型的重复运行可能产生实质性不同的 token 消耗和 round 数量。
- **精选任务样本：** 20 题是分层抽样，不是随机抽样。过度代表 Rust 和 JavaScript，选择倾向于 band-edge 较容易端。
- **不等价的 verifier 粒度：** 一个 harness item 可以代表窄参数检查或宽编译流程。断言数量不是语义难度单位。
- **local runtime：** 与任务声明中的 Docker 镜像不等价。13/20 题因依赖缺失无法运行 verifier，raw pass rate 被严重污染。
- **Codex round 归一化：** 一次 CLI turn 归一化为一个 round，内部实际发生了中位数 60 次工具调用。这使得 round 在配置间不可比。
- **Sub-agent 未启用：** 不能用本轮结果评价多 Agent 协作价值。
- **无成本数据：** 本轮未采集 provider 定价和费用，因此不做成本对比。
