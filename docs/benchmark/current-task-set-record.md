# 当前 Benchmark 证据记录

状态：`deep-swe-0809-03`，DeepSWE v1.1 三配置单次重复对比。本文以 verifier reward 为能力结果，以规范化 Agent evidence 为资源结果。

## 1. 结论摘要

本轮固定使用同一个 `deepseek-v4-flash-official` API model、High reasoning effort、20 个 DeepSWE 任务和任务各自的固定 Docker/verifier 环境，对比 Ello Rapid、Ello Thorough 与 Claude Code 三个完整 Agent 配置。

本轮 60/60 个 job 均已完成并取得 verifier score，最终结果如下：

- Ello Rapid：13/20，通过率 **65.0%**。
- Ello Thorough：13/20，通过率 **65.0%**。
- Claude Code：9/20，通过率 **45.0%**。
- 两个 Ello 配置对 Claude Code 均为 6 胜、12 平、2 负，配对通过率高 **20.0 个百分点**。
- 在资源证据同时可用的配对任务上，Ello Rapid / Claude Code 的耗时比中位数为 **0.310**（n=17），模型轮次比为 **0.317**（n=17），工具调用比为 **0.293**（n=17），input token 比为 **0.255**（n=7）。

这些数字支持“在本任务集、本模型服务和本次单次重复中，Ello Rapid 的 verifier 结果与资源效率均优于 Claude Code”这一描述。它们不证明 Command Run、Backward Reasoning 或其他单项机制各自造成了多少差异。

## 2. 分析范围

| 字段              | 值                                                                 |
| ----------------- | ------------------------------------------------------------------ |
| run id            | `deep-swe-0809-03`                                                 |
| benchmark         | DeepSWE v1.1 curated                                               |
| 上游 revision     | `a40d7298b18999c2d9b0ded7d6928e3ee26b5524`                         |
| 上游任务数        | 113                                                                |
| 固定任务数        | 20                                                                 |
| replicate         | 每个 task × agent 各 1 次                                          |
| 计划 job          | 60                                                                 |
| execution runtime | Docker                                                             |
| config hash       | `fc271cae81f03702891c781b8e3a9a6110a86ca456a5266b5587b1ac84b4d36b` |
| plan hash         | `57469551f63b0d5e82d19a1905899672758325343484034d7c19f40094ce03a5` |
| task set hash     | `cb823ea5f58aebf80baa78f704d6c57ec3418db08c4399bb754b234b6895220a` |
| report generated  | `2026-08-09T21:18:40.370Z`                                         |
| raw validation    | valid；136 attempts（64 completed，72 infrastructure-invalid）     |

每个任务先在未修改代码上运行 baseline preflight，再在独立 verifier 容器中应用 `model.patch` 并执行新测试。只有 baseline 健康、verifier 正常给出 reward 的最终 attempt 才进入通过率。

Attempt 数量大于 60 是因为保留了 infrastructure retry，以及 4 个在后续重试创建后才从已落盘 verifier report 收割出的早期 completed attempt。报告按每个 job 的最后一个 completed 结果形成 60-job 权威矩阵；raw validator 已核对 retry lineage、artifact checksum 和发布报告一致性。

## 3. 配置

| 配置          | Agent runtime       | Prompt mode      | Provider-visible tool  | 模型                         | Reasoning | Subagent |
| ------------- | ------------------- | ---------------- | ---------------------- | ---------------------------- | --------- | -------- |
| Ello Rapid    | Ello                | `rapid`          | `command_run`          | `deepseek-v4-flash-official` | High      | disabled |
| Ello Thorough | Ello                | `thorough`       | `command_run`          | `deepseek-v4-flash-official` | High      | disabled |
| Claude Code   | Claude Code 2.1.220 | Claude Code 内置 | Claude Code 内置工具集 | `deepseek-v4-flash-official` | High      | n/a      |

三者固定了模型配置、reasoning 标签、任务、容器资源和 verifier，但不是单变量 A/B test：Agent loop、system prompt、Command/Tool 协议、上下文策略和错误恢复均不同。Rapid 与 Thorough 使用相同 Ello runtime，仅 prompt policy 不同；本轮关闭了 Ello subagent，因此不能用这些结果评价多 Agent 协作。

## 4. Verifier 结果

### 4.1 边际通过率

| Agent         | 有效 job | 通过 |    通过率 | Wilson 95% CI | Infrastructure invalid |
| ------------- | -------: | ---: | --------: | ------------- | ---------------------: |
| Ello Rapid    |       20 |   13 | **65.0%** | 43.3% - 81.9% |                      0 |
| Ello Thorough |       20 |   13 | **65.0%** | 43.3% - 81.9% |                      0 |
| Claude Code   |       20 |    9 |     45.0% | 25.8% - 65.8% |                      0 |

### 4.2 配对结果

| 对比                         | matched | excluded | 左侧胜 |  平 | 左侧负 |       配对差 |
| ---------------------------- | ------: | -------: | -----: | --: | -----: | -----------: |
| Ello Rapid vs Ello Thorough  |      20 |        0 |      2 |  16 |      2 |       0.0 pp |
| Ello Rapid vs Claude Code    |      20 |        0 |      6 |  12 |      2 | **+20.0 pp** |
| Ello Thorough vs Claude Code |      20 |        0 |      6 |  12 |      2 | **+20.0 pp** |

配对差是同 task、同 replicate 的 reward 差平均值。20 题样本仍然很小，置信区间明显重叠；该表是描述性证据，不是跨模型、跨任务分布的显著性声明。

### 4.3 逐 Task 结果

| Task                                                  | Ello Rapid | Ello Thorough | Claude Code | 产物                                                                                |
| ----------------------------------------------------- | ---------- | ------------- | ----------- | ----------------------------------------------------------------------------------- |
| `actionlint-action-pinning-lint`                      | 通过       | 通过          | 通过        | [查看](results/tasks/deep-swe/actionlint-action-pinning-lint/)                      |
| `abs-stepped-slices`                                  | 通过       | 通过          | 通过        | [查看](results/tasks/deep-swe/abs-stepped-slices/)                                  |
| `yaegi-go-embed-directives`                           | 通过       | 通过          | 失败        | [查看](results/tasks/deep-swe/yaegi-go-embed-directives/)                           |
| `dasel-html-document-format`                          | 失败       | 失败          | 失败        | [查看](results/tasks/deep-swe/dasel-html-document-format/)                          |
| `cattrs-partial-structuring-recovery`                 | 失败       | 通过          | 通过        | [查看](results/tasks/deep-swe/cattrs-partial-structuring-recovery/)                 |
| `numba-stencil-boundary-modes`                        | 失败       | 失败          | 失败        | [查看](results/tasks/deep-swe/numba-stencil-boundary-modes/)                        |
| `bandit-incremental-cache-control`                    | 失败       | 失败          | 失败        | [查看](results/tasks/deep-swe/bandit-incremental-cache-control/)                    |
| `httpx-streaming-json-iteration`                      | 通过       | 失败          | 通过        | [查看](results/tasks/deep-swe/httpx-streaming-json-iteration/)                      |
| `happy-dom-abort-pending-body-reads`                  | 失败       | 通过          | 失败        | [查看](results/tasks/deep-swe/happy-dom-abort-pending-body-reads/)                  |
| `dynamodb-toolbox-conditional-attribute-requirements` | 通过       | 通过          | 通过        | [查看](results/tasks/deep-swe/dynamodb-toolbox-conditional-attribute-requirements/) |
| `awilix-async-container-initialization`               | 通过       | 通过          | 失败        | [查看](results/tasks/deep-swe/awilix-async-container-initialization/)               |
| `quill-shared-toolbar-focus`                          | 通过       | 失败          | 失败        | [查看](results/tasks/deep-swe/quill-shared-toolbar-focus/)                          |
| `wasmi-trap-coredumps`                                | 失败       | 失败          | 通过        | [查看](results/tasks/deep-swe/wasmi-trap-coredumps/)                                |
| `fd-deterministic-multi-key-sorting`                  | 通过       | 通过          | 通过        | [查看](results/tasks/deep-swe/fd-deterministic-multi-key-sorting/)                  |
| `boa-hierarchical-evaluation-cancellation`            | 通过       | 通过          | 失败        | [查看](results/tasks/deep-swe/boa-hierarchical-evaluation-cancellation/)            |
| `pest-character-class-coalescing`                     | 失败       | 失败          | 失败        | [查看](results/tasks/deep-swe/pest-character-class-coalescing/)                     |
| `yjs-map-conflict-detection`                          | 通过       | 通过          | 通过        | [查看](results/tasks/deep-swe/yjs-map-conflict-detection/)                          |
| `testem-per-launcher-reports`                         | 通过       | 通过          | 失败        | [查看](results/tasks/deep-swe/testem-per-launcher-reports/)                         |
| `csstree-shorthand-expansion-compression`             | 通过       | 通过          | 通过        | [查看](results/tasks/deep-swe/csstree-shorthand-expansion-compression/)             |
| `katex-multicolumn-array-spans`                       | 通过       | 通过          | 失败        | [查看](results/tasks/deep-swe/katex-multicolumn-array-spans/)                       |

## 5. 资源

资源聚合只使用 `completed` 且能够规范化 evidence 的 attempt。通过率分母与资源分母因此不同；缺失 usage 的 scored job 仍计入 verifier 结果，但不会被当成 0 token。

### 5.1 资源中位数

| Agent         | elapsed | rounds | tools |      input | non-cache input | cache read | cache hit |  output |
| ------------- | ------: | -----: | ----: | ---------: | --------------: | ---------: | --------: | ------: |
| Ello Rapid    | 1,223 s |    146 |   129 | 11,616,705 |         111,617 | 11,505,088 |     99.1% |  99,329 |
| Ello Thorough | 1,555 s |    162 |   143 | 20,985,356 |         138,415 | 20,838,592 |     99.3% | 111,444 |
| Claude Code   | 5,400 s |    259 |   273 | 27,686,409 |         316,469 | 27,355,776 |     98.9% | 262,551 |

### 5.2 资源平均数

| Agent         | elapsed | rounds | tools |      input | non-cache input | cache read | cache hit |  output |
| ------------- | ------: | -----: | ----: | ---------: | --------------: | ---------: | --------: | ------: |
| Ello Rapid    | 1,299 s |    140 |   133 | 15,765,153 |         116,632 | 15,648,521 |     99.1% | 105,919 |
| Ello Thorough | 1,894 s |    157 |   151 | 21,842,794 |         138,017 | 21,704,777 |     99.3% | 117,992 |
| Claude Code   | 4,610 s |    492 |   514 | 32,394,152 |         301,672 | 32,092,480 |     98.9% | 276,073 |

这里的 mean 是 measured run 的算术平均数；cache hit mean 按每个 run 的命中率做算术平均，不用 token 总和重新计算。

### 5.3 样本覆盖

| Agent         | elapsed / rounds / tools | 完整 input/output usage | cache hit | tool audit passed | Scored job |
| ------------- | -----------------------: | ----------------------: | --------: | ----------------: | ---------: |
| Ello Rapid    |                       18 |                      14 |        14 |                18 |         20 |
| Ello Thorough |                       18 |                      14 |        14 |                18 |         20 |
| Claude Code   |                       19 |                       8 |         8 |                15 |         20 |

严格 `publishable` gate 要求完整 60-job 矩阵、每个 completed job 的完整 usage 和通过的 tool audit。本轮 verifier 矩阵已完整，但历史 evidence degradation 使 usage 与 tool audit coverage 未达到 60/60，因此仍为 `publishable: false`。该标记不否定 verifier 分数，但对外引用资源数字时必须同时保留 n，不能描述成 20 题完整 token 均值。

### 5.4 配对资源比

比值按每个 matched task 先算 `left / right`，再取中位数，比“两个总体中位数相除”更适合逐 Task 对比。

| 对比                   |    elapsed ratio |     rounds ratio |      tools ratio |     input ratio |    output ratio |
| ---------------------- | ---------------: | ---------------: | ---------------: | --------------: | --------------: |
| Rapid / Thorough       |     0.829 (n=18) |     0.908 (n=18) |     0.970 (n=18) |    0.820 (n=11) |    0.897 (n=11) |
| Rapid / Claude Code    | **0.310 (n=17)** | **0.317 (n=17)** | **0.293 (n=17)** | **0.255 (n=7)** | **0.268 (n=7)** |
| Thorough / Claude Code |     0.411 (n=17) |     0.347 (n=17) |     0.332 (n=17) |     0.399 (n=6) |     0.378 (n=6) |

`rounds` 在本轮 evidence 中都表示规范化模型回合，但不同 Agent adapter 的原始事件和批处理仍不同。跨 Agent 解读时应同时查看 elapsed、tools 和 token，不把 round 单独当作工作量真值。

## 6. 对外引用边界

可以引用：

- 同一模型配置、同一 20 题 Docker/verifier 矩阵中，Ello Rapid 为 13/20，Claude Code 为 9/20，差 20.0 个百分点。
- 配对结果为 6 胜、12 平、2 负；不是由少数未配对样本造成的边际差。
- 在双方资源证据都完整的子集上，Rapid 的耗时、工具调用和 token 配对比中位数均低于 1，并应同时给出 n。
- Ello 本轮关闭 subagent；优势不能归因于额外并行 Agent 预算。

不能引用：

- “Command Run 单独带来 20 个百分点”或“Backward Reasoning 单独降低 75% token”。本轮没有功能消融。
- “Ello 在所有模型、语言和任务上都优于 Claude Code”。本轮只有一个模型服务、20 个精选任务和一次重复。
- “60 个 job 都有完整 token 数据”。usage coverage 明确不足。
- “结果具有统计显著性”。样本小且 Wilson 区间重叠，本报告只做描述性汇总。

## 7. 证据入口

- [生成报告](results/report.md)：总览、中位数、平均数、Task 级三配置资源表和 invalid attempt ledger。
- [Suite JSON](results/suite-report.json)：机器可读统计事实源。
- [发布 manifest](results/manifest.json)：run 身份、60 个 attempt 索引和文件校验和。
- [逐 Task 产物](results/tasks/deep-swe/)：instruction、resolved task、三配置 patch、结构化 verifier 结果与运行 manifest。
- Raw run：`packages/ello-bench/raw/deep-swe-0809-03/`（本地 ignored，不作为 Git 发布入口）。

发布产物由以下命令在完整矩阵上生成：

```bash
pnpm --filter @ello/bench build
pnpm --filter @ello/bench bench report \
  --run-root raw/deep-swe-0809-03
node --max-old-space-size=8192 packages/ello-bench/dist/cli.js validate \
  --run-root packages/ello-bench/raw/deep-swe-0809-03
pnpm --filter @ello/bench bench:archive-docs -- \
  --run-root packages/ello-bench/raw/deep-swe-0809-03
```
