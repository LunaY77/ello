# Benchmark 发布产物

该目录保存可直接随仓库发布的 Benchmark 证据子集。完整运行时事件、Agent stdout、容器工作区和失败重试仍保存在 `packages/ello-bench/raw/`，不进入 Git。

当前目录由 `@ello/bench` 的归档脚本从一个已完成的 run root 生成：

```bash
pnpm --filter @ello/bench bench:archive-docs -- \
  --run-root packages/ello-bench/raw/deep-swe-0809-03
```

归档脚本会在写入前要求矩阵中的每个 job 都有权威 `completed` verdict，并使用与报告一致的“最后一个 completed attempt”选择规则，避免发布运行中的半成品。

## 目录结构

```text
results/
├── manifest.json
├── report.md
├── suite-report.json
├── charts/
└── tasks/deep-swe/<task-name>/
    ├── instruction.md
    ├── task.json
    ├── ello-ds-rapid/
    ├── ello-ds/
    └── claude-code/
```

每个 Agent 目录只保留公开复核需要的最小集合：

| 文件            | 内容                                                             |
| --------------- | ---------------------------------------------------------------- |
| `manifest.json` | 去除本机绝对路径后的运行身份、结果、patch 与 provenance 摘要     |
| `model.patch`   | Agent 最终提交给 verifier 的补丁                                 |
| `harness.json`  | verifier reward、测试退出码和 assertion；路径改为 attempt 相对值 |

`verifier.stdout/stderr.log`、`evidence.json`、`tool-audit.json` 和 `phase-timings.json` 不进入 Git。它们服务于深度运行诊断，完整原件仍保存在本地 ignored 的 raw run；对外统计所需的聚合结果和 coverage 已进入 `suite-report.json`。

根 `manifest.json` 记录 60 个 published attempt 的相对路径与聚合产物校验和；每个 Agent manifest 记录其公开文件校验和。统计口径、排除规则和识别限制见 [当前 Benchmark 证据记录](../current-task-set-record.md)。
