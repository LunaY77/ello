# ello-bench 架构：从任务声明到可追溯报告

## 目标

ello-bench 的目标不是“把两个 CLI 跑起来”，而是让一次 Agent 对比能够被检查、重放和解释。任务、Agent 调用、原始事件、归一化证据、verifier 结果和报告各自有清晰边界；任何最终数字都必须能回到原始文件和固定输入。

框架比较的是完整配置下的 Agent 系统。模型、提示词、工具协议、运行时、上下文策略和 CLI 版本共同构成被测对象，报告不能把系统级差异改写成某一个组件的因果效果。

## 六层数据流

```text
配置与 Suite
    ↓
任务语料解析
    ↓
task × agent × replicate 计划
    ↓
隔离工作区中的 Agent 执行
    ↓
原始事件 → 标准化 evidence → 独立 verifier
    ↓
验证、聚合、配对比较与图表
```

### 1. 配置与 Suite

`config/*.config.mjs` 只描述可移植配置：Suite、Agent、模型、并发、重复次数、重试和发布门槛。凭据通过环境变量传入，不写进配置或运行产物。

`src/suite.ts` 是任务族的薄适配层。它固定：

- 上游仓库与 revision；
- 任务集与任务集 hash；
- Agent 和 verifier 容器入口；
- 工作区准备方式；
- verifier 文件如何进入隔离环境。

SWE-bench Pro 使用唯一的 `swe-bench-pro-calibration` Suite，包含固定的 30 题精选集。任务清单、上游 revision 和任务集 hash 共同定义这组校准输入。

### 2. 任务语料

任务声明只保存稳定身份和分层信息。实际 instruction、Docker image、源码 revision、`run_script.sh`、`parser.py` 等内容从固定 revision 的 corpus 加载。

这条边界很重要：ello-bench 不复制或“改良”上游答案，也不根据 Agent 输出补写测试。相同任务上的 Ello 与 Claude Code 必须收到相同 instruction、源码和 verifier。

### 3. 计划与运行状态

矩阵由 `task × agent × replicate` 展开。计划 hash、配置 hash 和 job ID 在执行前固定，同一个 run root 不能悄悄切换任务或 Agent 配置。

基础设施失败和任务失败是两种不同状态：

- verifier 返回 reward 0：有效任务失败；
- provider、容器、证据解析或 verifier 基础设施异常：`invalid_infrastructure`。

后者可以按配置重试，但不能被记成对手胜利。

### 4. 原始证据

每次 attempt 都保留 Agent 原始输出、标准化 evidence、round、tool call、进程信息、workspace diff 和 verifier 输出。典型结构如下：

```text
<attempt-root>/
├── run.json
├── workspace/
├── agent-state/
└── raw/
    ├── task/
    ├── agent/
    │   ├── identity.json
    │   ├── invocation.json
    │   ├── stdout.jsonl
    │   ├── stderr.log
    │   ├── evidence.json
    │   ├── tool-audit.json
    │   └── rounds.jsonl
    ├── phase-timings.json
    ├── model.patch
    └── harness/
```

原始层是事实来源。归一化层可以整理字段，但不能猜测缺失 token、命令、分数或终止原因。

### 5. 验证与 verifier

validation 会重新读取磁盘中的原始 Agent 输出，再与标准化 evidence 比对，而不是信任 runner 进程中的临时对象。工具审计检查调用是否属于当前任务容器和工作区；越界路径、跨容器命令或无法解释的事件会进入诊断记录。

verifier 与 Agent 调用分离。Agent 只修改工作区，最终 reward 由独立 verifier 容器产生。SWE-bench Pro 复用上游 `run_script.sh` 和 `parser.py`，ello-bench 只负责以统一协议执行并保存结果。

### 6. 报告与图表

报告层输出三类视图：

- Agent 视图：有效样本、通过率、Wilson 区间、资源中位数；
- Task 视图：每题每 Agent 的有效、通过、失败或无效状态；
- Comparison 视图：同任务、同 replicate 的 win、tie、loss 和 excluded pair。

`analysis/` 只消费已经落盘的报告和 evidence。图表统一采用编辑式信息层级：kicker、结论标题、口径副标题、主图、方法说明、样本和 provenance。图内文字保持英文，以避免无 CJK 字体的 CI 或服务器渲染出方框；中文解释放在文章和 Markdown 报告周边。

## 稳定边界

维护 ello-bench 时应遵守以下规则：

1. 任务清单与任务集 hash 同步维护，报告必须披露实际使用的 hash。
2. Agent 专属协议只存在于 adapter，公共报告不依赖 provider 私有字段。
3. raw 是本地执行证据，文档资产必须从明确 run 中复制并记录 provenance。
4. 缺失字段保持缺失，不能为了画图变成 0。
5. 无效运行独立报告，不进入有效通过率分母，也不自动成为对手胜利。
6. 任务子集只代表固定校准集，不宣称是 SWE-bench Pro 总榜成绩。

## 合并前检查

```bash
pnpm --filter @ello/bench typecheck
pnpm --filter @ello/bench test
python3 -m unittest discover packages/ello-bench/analysis -p 'test_*.py'
pnpm --filter @ello/bench build
```

修改 SWE-bench Pro 任务集时，还需要在固定 corpus revision 上实际加载全部任务，确认 instruction、`run_script.sh`、`parser.py` 和测试规格都可解析。
