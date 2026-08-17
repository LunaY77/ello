# 当前 Benchmark 证据记录

状态：`deep-swe-0816-01`，DeepSWE v1.1 完整任务集、五配置、单次重复运行。本文以 verifier reward 为能力结果，以规范化 Agent evidence 为资源结果；invalid infrastructure attempt 不进入能力分母。

## 1. 结论摘要

本轮固定使用同一个 `deepseek-v4-flash-official` API model、High reasoning effort、完整 113 个 DeepSWE v1.1 task，以及各 task 固定的 Docker/verifier 环境。矩阵包含 Ello Rapid、Ello Rapid + Subagent、Ello Thorough、Ello Thorough + Subagent 和 Claude Code 五个完整 Agent 配置。

- 计划 565 个 job，520 个 job 取得有效 verifier score，45 个 job 为 `invalid_infrastructure`；这 45 个不计为任务失败。
- 每个配置约有 100 个有效观测：Ello Rapid 104、Rapid + Subagent 103、Thorough 103、Thorough + Subagent 103、Claude Code 107。
- Ello Rapid：46/104，通过率 **44.2%**；Claude Code：48/107，通过率 **44.9%**。边际通过率基本持平。
- 在同 task 配对的 Rapid vs Claude Code 中，Rapid 为 18 胜、66 平、20 负，配对通过率差 **-1.9 个百分点**（104 个 matched，9 个 excluded）。
- Rapid 的资源消耗在可比配对上更低：elapsed 中位数 **-12.1%**、模型轮次 **-22.8%**、规范化 Command/Tool 调用 **-29.2%**、input token **-35.4%**。

本轮结果显示：Ello Rapid 与 Claude Code 的 verifier 能力结果相近，而 Rapid 使用了更少的运行时资源。

## 2. 分析范围

| 字段              | 值                                                                      |
| ----------------- | ----------------------------------------------------------------------- |
| run id            | `deep-swe-0816-01`                                                      |
| benchmark         | DeepSWE v1.1                                                            |
| 上游 revision     | `a40d7298b18999c2d9b0ded7d6928e3ee26b5524`                              |
| 上游任务数        | 113                                                                     |
| 固定任务数        | 113（完整任务集）                                                       |
| replicate         | 每个 task × agent 各 1 次                                               |
| 配置数            | 5                                                                       |
| 计划 job          | 565                                                                     |
| scored job        | 520                                                                     |
| invalid job       | 45                                                                      |
| execution runtime | Docker                                                                  |
| config hash       | `122ddb17b85c0071c03d1cf4bc5edf01aff82f1d3efbda04c34334ddce904d08`      |
| plan hash         | `565ff12e482a8172df758f1891d0653cb6fbcce5ad094a2e60bef0a94de1147b`      |
| task set hash     | `11f4e80cf1cf74f393e6361f71872596a8d5ff6be743b7214457acd4a847a218`      |
| report generated  | `2026-08-17T05:42:54.688Z`                                              |
| raw validation    | valid；855 attempts（520 completed，335 invalid attempts）；report true |

## 3. 配置

| 配置                     | Agent runtime       | Prompt mode      | Provider-visible tool  | 模型                         | Reasoning | Subagent |
| ------------------------ | ------------------- | ---------------- | ---------------------- | ---------------------------- | --------- | -------- |
| Ello Rapid               | Ello                | `rapid`          | `command_run`          | `deepseek-v4-flash-official` | High      | disabled |
| Ello Rapid + Subagent    | Ello                | `rapid`          | `command_run`          | `deepseek-v4-flash-official` | High      | enabled  |
| Ello Thorough            | Ello                | `thorough`       | `command_run`          | `deepseek-v4-flash-official` | High      | disabled |
| Ello Thorough + Subagent | Ello                | `thorough`       | `command_run`          | `deepseek-v4-flash-official` | High      | enabled  |
| Claude Code              | Claude Code 2.1.220 | Claude Code 内置 | Claude Code 内置工具集 | `deepseek-v4-flash-official` | High      | n/a      |

五个条目分别代表完整的 Agent 配置；Rapid/Thorough 与其 Subagent 版本分别统计。

## 4. Verifier 结果

### 4.1 边际通过率

| Agent                    | 有效 job | 通过 |    通过率 | 95% Wilson CI | invalid |
| ------------------------ | -------: | ---: | --------: | ------------- | ------: |
| Ello Rapid               |      104 |   46 | **44.2%** | 35.1% - 53.8% |       9 |
| Ello Rapid + Subagent    |      103 |   43 | **41.7%** | 32.7% - 51.4% |      10 |
| Ello Thorough            |      103 |   44 | **42.7%** | 33.6% - 52.4% |      10 |
| Ello Thorough + Subagent |      103 |   41 | **39.8%** | 30.9% - 49.5% |      10 |
| Claude Code              |      107 |   48 | **44.9%** | 35.8% - 54.3% |       6 |

### 4.2 与 Claude Code 的配对结果

| 对比                                    | matched | excluded | 左侧胜 |  平 | 左侧负 | 配对通过率差 |
| --------------------------------------- | ------: | -------: | -----: | --: | -----: | -----------: |
| Ello Rapid vs Claude Code               |     104 |        9 |     18 |  66 |     20 |  **-1.9 pp** |
| Ello Rapid + Subagent vs Claude Code    |     103 |       10 |     20 |  59 |     24 |  **-3.9 pp** |
| Ello Thorough vs Claude Code            |     103 |       10 |     19 |  62 |     22 |  **-2.9 pp** |
| Ello Thorough + Subagent vs Claude Code |     103 |       10 |     15 |  67 |     21 |  **-5.8 pp** |

配对差为同 task、同 replicate 的 binary reward 差平均值。本轮每个 `task × agent` 运行一次。

### 4.3 Invalid 的主要边界

`goreleaser-retry-publish-auditing`、`anko-typed-variable-bindings`、`narwhals-rolling-window-suite`、`skrub-duration-encoding`、`langchain-request-coalescing` 和 `eicrud-keyset-pagination-cursor` 的 clean baseline 在多个配置中不健康，因此按基础设施无效处理。另有少量 provider JSON/限流、Docker 拉取、verifier timeout 和 patch 校验异常；具体 attempt ledger 保留在 raw run 的 `suite-report.json`，不应把它们折算成 Agent 的失败分数。

## 5. 配对资源结果

以下数值对每个同 task 配对先计算 `Ello / Claude Code`，再取中位数；缺失 usage 不填 0。`n` 是该项两侧 evidence 都可用的配对数。

| 相对 Claude Code         |       elapsed |      模型轮次 | Command / Tool 调用 |   input / output token |
| ------------------------ | ------------: | ------------: | ------------------: | ---------------------: |
| Ello Rapid               | ↓12.1% (n=94) | ↓22.8% (n=94) |       ↓29.2% (n=94) | ↓35.4% / ↓13.4% (n=85) |
| Ello Rapid + Subagent    | ↓14.1% (n=93) | ↓20.6% (n=93) |       ↓32.5% (n=93) | ↓36.3% / ↓13.0% (n=79) |
| Ello Thorough            |  ↓1.4% (n=93) |  ↓4.4% (n=93) |       ↓13.1% (n=93) |   ↓9.4% / ↓8.7% (n=81) |
| Ello Thorough + Subagent |  ↑1.2% (n=93) |  ↓6.3% (n=93) |       ↓13.3% (n=93) |   ↓9.4% / ↓1.6% (n=75) |

配置级 mean/median/p95、逐 task 结果和完整 invalid ledger 见 [生成报告](results/report.md) 与 [suite JSON](results/suite-report.json)。

## 6. 证据存储

Raw run 仍位于 `packages/ello-bench/raw/deep-swe-0816-01/`，包含完整 stdout、evidence、tool audit、phase timing、verifier 和 retry lineage。Git 发布集只保留聚合 report、suite/agent/comparison JSON 和 charts，不再复制 `results/tasks/` 下的逐题 patch、instruction 和 harness 文件。
