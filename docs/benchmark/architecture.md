# Benchmark 框架架构

## 目标

每轮发布的 benchmark 必须能从干净 checkout 复现，不依赖机器特定路径或 Agent 私有编排代码。任务数据、执行代码、Agent 配置和发布证据因此各自独立，互不侵入。`results/` 下的已发布 artifact 是 schema 和 artifact 布局的兼容性预言。

## 架构分层

框架分四层：

1. **任务数据** — 固定 upstream revision、任务清单、语言/难度分布和 verifier 合同。
2. **可复用执行代码** — `src/` 下的 TypeScript 代码处理准备、Agent 调用、解析、监控、合同和 harness 报告。
3. **配置和入口点** — `config/` 下的 Agent 和 benchmark 配置，`scripts/` 下的 CLI 和构建入口，以及 `src/cli.ts` 中的公共命令。
4. **Artifact** — `analysis/` 下的 Python 分析脚本消费本地运行数据，产出图表、Markdown 报告和聚合 JSON。

## 仓库布局

```text
packages/ello-bench/
├── analysis/                   # Python 分析：图表、Markdown 报告、统计
│   ├── artifacts.py
│   ├── markdown_report.py
│   ├── render_report.py
│   ├── generate_deep_swe_zh_assets.py
│   ├── config.py
│   ├── wilson.py
│   ├── charts/
│   └── requirements.txt
├── config/                     # 可移植的运行时和 Agent 配置
│   ├── agents.config.mjs
│   ├── benchmark.config.mjs
│   └── report.config.mjs
├── scripts/                    # 构建脚本
│   └── build.mjs
├── src/                        # 类型化合同和共享 TypeScript 代码
│   ├── cli.ts                  # 公共 CLI（list、plan、run、validate）
│   ├── suite.ts                # Suite manifest 解析和 plan 生成
│   ├── matrix.ts               # 矩阵展开
│   ├── matrix-runner.ts        # 矩阵执行器
│   ├── runner.ts               # 单 job runner
│   ├── report.ts               # 聚合报告生成
│   ├── contracts/              # 类型化合同定义
│   ├── deep-swe-corpus.ts      # DeepSWE 任务语料
│   ├── swe-bench-pro-corpus.ts # SWE-bench Pro 任务语料
│   ├── swe-bench-pro-tasks.ts  # SWE-bench Pro 30 题声明
│   ├── verifier.ts             # 通用 verifier 逻辑
│   ├── rounds.ts               # Round 合同归一化
│   ├── validation.ts           # Schema 验证
│   └── ...
├── tests/                      # 框架和合同测试
├── package.json                # 安装、验证和依赖命令
└── tsconfig.json               # TypeScript 构建边界
```

生成的 `dist/` 和本地运行数据目录是本地 artifact，不提交。`results/` 下的可复现 artifact 被跟踪并定义兼容性标准。

## 稳定边界

1. `src/swe-bench-pro-tasks.ts` 包含 30 题 SWE-bench Pro 任务声明和 task set hash。
2. `config/agents.config.mjs` 包含 Agent 启动 profile。Agent ID 是数据，不是 TypeScript enum 或矩阵脚本常量。
3. `config/benchmark.config.mjs` 包含可移植的运行时默认值和矩阵。
4. `src/cli.ts` 是公共 `list`、`plan`、`run`、`validate` CLI。
5. 可执行 suite（DeepSWE、SWE-bench Pro）各有一份 checked-in 任务声明和一个薄 adapter。adapter 拥有可移植缓存和运行路径，然后将执行委托给 suite runner。

## 任务合同

每个任务声明必须包含稳定的 ID 和类型、上游仓库 URL、base commit、语言、自然语言需求、verifier 脚本及隐藏测试补丁的 hash、以及 Agent 与 verifier 的超时时间。

任务 membership 由 task set hash 固定。上游数据可刷新记录的通过率和排名，但绝不能改变任务 membership。这防止在线 artifact 的更新静默改变比较队列。

有效 verifier 报告包含 `reward: 0 | 1`、verifier 进程退出码、baseline test 退出码、new test 退出码和 patch hash。证据必须来自实际 harness 输出；缺失证据保持空，不得合成。

## 配置

对于每个可配置值，优先级为：

1. 显式 CLI 选项；
2. 环境变量；
3. `config/` 下的选定 JSON 配置文件；
4. 从仓库根派生的可移植默认值。

Agent 命令、模型、参数、环境模板、任务选择、replicate 数量、并发、超时和输出路径必须保持可配置。密钥绝不放入 JSON 配置。

## 执行与数据流

公共 CLI 解析任务声明和 Agent profile，然后或打印 dry-run plan，或调用声明的 runner 并传入归一化环境变量。实时执行是显式的，因为它可能消耗付费 provider、网络或容器资源。

1. **配置** 描述如何启动 Agent CLI；**任务文件** 描述被评估的内容。机器特定路径不属于任一合同。
2. **准备** 创建或复制工作区并记录初始状态。
3. **解析** 将 provider 特定的回调归一化为共享的 round 和 tool-call 记录，不猜测不可用的 usage 数据。
4. **CLI adapter** 将每个可观测 round 作为归一化合同返回，并将相同对象持久化为 per-round JSON 和 JSONL 流。工具详情和每轮 token usage 保持附加在产生它们的 round 上。
5. **监控** 拥有累积 usage、事件持久化、仓库 diff 和最终任务报告。
6. **Harness 执行** 独立于 Agent 启动，写入归一化分数报告。
7. **生成输出** 归属 artifact 目录，绝不放在可复用源模块旁边。

## Artifact 和兼容性合同

`results/` 下的已发布 artifact 是被跟踪的兼容性数据。其目录布局和 schema 是仓库合同的一部分。

兼容性套件验证现有结果族，包括 manifest、per-run metadata、合同 JSON、JSONL round 和 verifier 报告。新的编排可以添加可选字段，但不得重命名或迁移已有发布 artifact。

结果目录和 manifest 描述的是 benchmark 子集。一个子集不得被呈现为完整的上游 benchmark，也不得被呈现为其声明任务人群以外的代表。发布和比较规则由[方法论](benchmark-methodology.md)定义；当前证据记录在[测试集记录](current-task-set-record.md)中。

## 维护规则

1. 保持任务声明不变，除非任务显式退役。
2. 将任务特定逻辑保留在任务声明中；仅将真正可复用的代码移至 `src/`。
3. 通过类型化合同层更改合同，同时更新 parser、writer 和测试。
4. 保持 runner 入口点薄——通过组合共享准备、收集和 harness 函数实现。
5. 不提交临时矩阵启动脚本、一次性修复脚本、生成的 audit 或本地结果数据。
6. 删除指向已退役任务的脚本和仅被废弃脚本或测试引用的代码。
7. 保留原始源证据。归一化可以重塑数据，但不得发明命令、输出、usage、断言或分数。
8. 保持密钥、凭证、绝对本地路径和下载的可执行文件远离跟踪配置和 artifact。
9. 保持实时执行 opt-in。单元测试和类型检查不得消耗 provider 配额或需要外部 benchmark 仓库。
10. 更新本文档每当目录结构或合同边界发生变化。

## 质量门禁

合并框架变更前：

- 验证每个任务声明和任务级 runner 路径；
- 运行 TypeScript 编译和测试；
- 运行 TypeScript 静态检查；
- 验证 schema 与已发布结果的一致性；
- 语法检查可执行入口点；
- 运行格式化和 dead-code 检查；
- 确认生成文件和临时文件保持被忽略；
- 确认任务清单未被意外删除或改写。

`pnpm run check` 运行仓库标准本地门禁。实际 benchmark 执行是独立的验证步骤，因为它可能消耗外部资源和产生费用。

## 安装边界

`pnpm install` 拥有仓库级依赖。`analysis/requirements.txt` 固定 Python 验证依赖。Python 入口点按 `PYTHON` 环境变量 → `.venv` → 系统 `python` 的顺序回退，保持验证和实时检查在同一解释器上。

Git、Docker 和 Agent CLI 仍是系统依赖。安装不得安装、配置、认证或启动它们。Provider 认证是显式的用户责任。
