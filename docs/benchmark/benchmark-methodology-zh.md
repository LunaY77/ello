# ello-bench 测评方法：如何公平比较编码 Agent

## 1. 研究问题

ello-bench 回答的是一个有限而明确的问题：在同一组固定软件工程任务、相同源码、相同 verifier 和相同重复次数下，两个完整 Agent 配置的结果与资源轨迹有什么差异？

它不直接回答“哪个模型普遍更强”，也不能从一次系统对比中识别某个提示词、工具、缓存策略或推理组件的独立因果贡献。

## 2. 被测对象

被测单位是完整配置，包括：

- Agent CLI 与精确版本；
- 模型 ID、provider 路由和 reasoning 配置；
- system prompt、工具协议和上下文管理；
- 任务超时、并发、重试与容器环境。

报告应保存这些信息的配置 hash、二进制 hash 或可核对版本。只写“Ello 对 Claude”不足以复现实验。

## 3. 任务集

SWE-bench Pro 校准集为 `swe-bench-pro-calibration`，从固定 revision 的 731 题中精选 30 题：

| 维度 | 分布 |
|---|---|
| Python | 10 |
| Go | 10 |
| TypeScript / JavaScript | 10 |
| easy | 8 |
| medium-easy | 7 |
| medium-hard | 8 |
| hard | 7 |

难度依据是上游九组公开轨迹的通过频次，不是 ello-bench 当前待比较 Agent 的预跑结果。完整任务和选择理由见[《SWE-bench Pro 30 题精选记录》](swe-bench-pro-selection-zh.md)。

该集合是用于稳定优化和横向对比的校准样本，不是随机样本，也不代表 SWE-bench Pro 731 题排行榜。

## 4. 实验设计

### 4.1 先 pilot，再正式运行

先为每个语言和难度档选择少量任务做 pilot，用来发现镜像、provider、工具审计和 verifier 问题。pilot 只验证实验管线，不应用来换掉对某个 Agent 不利的题。

正式结果使用全 30 题矩阵。默认配置的单次重复适合工程回归；若要发布稳定比较，建议每个 `task × agent` 至少运行 3 个 replicate，并固定同一套超时、重试和并发规则。

### 4.2 配对是主比较

主比较单位是同一任务、同一 replicate 的两个有效 verifier reward：

- Ello=1、Claude=0：Ello win；
- 两边相同：tie；
- Ello=0、Claude=1：Ello loss；
- 任一边基础设施无效：excluded pair。

配对通过率差与 win/tie/loss 比两个独立 pass rate 更适合回答“同题谁做得更好”。两个 Agent 的边际分母不同时，不能直接用百分比小数点判断领先。

### 4.3 基础设施无效

以下情况属于无效运行，而不是有效失败：

- provider 或模型调用不可用；
- 容器、工作区或 verifier 未按协议运行；
- 原始事件无法可靠解析；
- 工具审计发现跨工作区或跨容器行为；
- verifier 自身异常，未产生可信 reward。

无效运行可以重试。达到最大重试次数后仍无效，则保留在 invalid ledger 中，并从有效通过率和配对胜负中排除。正式报告应要求完整矩阵；否则必须明确标记不可发布。

## 5. 指标

### 5.1 结果指标

- 有效通过率：`passed valid runs / valid runs`；
- 95% Wilson 区间：在样本足够时展示二项比例不确定性；
- 配对 win/tie/loss；
- 配对通过率差；
- infrastructure-invalid 数量和原因。

不提供跨 Agent 合并通过率，因为那会失去比较意义。

### 5.2 资源指标

资源统计以有效最终 attempt 为样本，默认报告中位数，并保留 P95：

- Agent 运行时间；
- model round；
- tool call；
- input、cache read、cache write、output token；
- 各执行 phase 的耗时。

资源字段必须按 Agent 协议语义解释。某个 adapter 未报告 output token 或 cache write 时，应显示 `n/a` 或 `unreported`，不能将它解释成模型没有输出或没有发生缓存写入。

### 5.3 工具失败

工具失败 Pareto 用于定位可靠性工程重点，不是能力排行榜。失败次数可能同时受工具粒度、重试策略、任务类型和 parser 语义影响，因此只能在当前配置和当前样本内解释。

## 6. 图表口径

每张图都必须回答一个问题，并在图上同时保留：

1. 一句可读结论或问题；
2. 分母、排除规则或 token accounting；
3. 样本覆盖：scored/planned、invalid、selected/upstream；
4. run root、config hash 和生成时间等 provenance。

推荐的核心图顺序是：

1. 配对胜/平/负；
2. 各 Agent 有效通过率与无效覆盖；
3. task × agent 结果矩阵；
4. 时间—结果—工具调用资源图；
5. token 组成；
6. round timeline；
7. 工具失败 Pareto。

## 7. 发布门槛

一份可发布报告至少应满足：

- 所有计划 job 都有最终 attempt；
- 所有评分 run 的关键 usage 字段满足预先声明的覆盖要求；
- 所有 run 通过工具审计；
- 任务集、上游 revision、配置 hash、计划 hash 和 Agent 版本完整；
- 所有无效重试和最终无效任务可审计；
- 结论同时报告配对结果和不确定性，不只展示单个百分比。

如果任一门槛未满足，报告仍可用于调试和校准，但必须写明“不可发布”以及原因。

## 8. 局限

- 30 题是有意分层的固定样本，不支持推断整个 731 题总体通过率。
- 公开轨迹频次是粗粒度难度代理，会受当时模型和 scaffold 影响。
- 单 replicate 对随机波动敏感。
- 不同 Agent 的 token 记账协议可能不完全同构。
- 系统配置同时变化时，只能比较整体策略，不能归因到单一组件。
