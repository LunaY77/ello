# Benchmark 发布产物

该目录保存可直接随仓库发布的 `deep-swe-0816-01` 聚合证据。完整 stdout、Agent evidence、tool audit、phase timing、verifier artifact、patch 和 retry lineage 仍保存在 ignored 的 `packages/ello-bench/raw/deep-swe-0816-01/`，不复制进 Git。

## 当前范围

- DeepSWE v1.1 完整 113-task suite；
- 5 个 Agent 配置，每个 `task × agent` 1 次重复；
- 565 个计划 job，520 个 scored，45 个 infrastructure-invalid；

## 目录结构

```text
results/
├── README.md
├── report.md
├── suite-report.json
├── agents/
├── comparisons/
└── charts/
```

| 路径                 | 内容                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `report.md`          | 生成的 Markdown 总报告，包含边际通过率、逐 task 结果、资源统计、invalid ledger 和图表索引 |
| `suite-report.json`  | 完整结构化 suite 结果，是统计和 coverage 的权威机器可读来源                               |
| `agents/*.json`      | 每个配置的 task outcome、资源分布和 evidence coverage                                     |
| `comparisons/*.json` | 配置间 paired outcome 与资源 ratio                                                        |
| `charts/*.svg`       | 由同一 suite report 渲染的图表                                                            |

本发布集有意不包含 `tasks/` 目录。113 tasks × 5 配置的 instruction、patch、harness 和 attempt manifest 文件数量过大；需要逐 attempt 复核时，应从同一 run id 的 raw evidence 读取。统计口径和证据入口见[当前 Benchmark 证据记录](../current-task-set-record.md)。
