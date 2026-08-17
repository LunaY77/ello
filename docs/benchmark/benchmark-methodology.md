# Benchmark 方法论

## 1. 目的与范围

本 benchmark 评估 coding agent 在长程工程任务上的表现。当前包含两种互补的任务形式：

1. **DeepSWE 完整任务集（113 题）：** DeepSWE v1.1 的全部仓库级软件工程任务，覆盖五种语言并按官方通过率分层标注难度。评分方式为 binary reward（通过/失败）。
2. **SWE-bench Pro 子集（30 题）：** 从 SWE-bench Pro 中选取的仓库级 issue 修复任务，覆盖 Python、TypeScript、Go 和 JavaScript。评分方式为 binary reward（通过/失败）。这组三十题用于 Agent 优化闭环。

两组任务衡量互补的软件工程能力。DeepSWE 强调跨文件长程实现（如增加新功能、支持新语法），SWE-bench Pro 强调 issue 定位和修复。单一聚合分数不是主要结果——不同任务集衡量不同能力维度，不可通约。

本轮仅执行了 DeepSWE 子集。SWE-bench Pro 子集已定义但尚未执行。

本文档描述任务选择标准、数据归一化规则、评估边界、已知异常和局限性。任务清单、可执行合同、选择逻辑和发布结果 artifact 由本仓库维护；[当前测试集证据记录](current-task-set-record.md) 将本方法论应用于 2026 年 8 月的 DeepSWE 五配置完整任务集 artifact。

### 1.1 研究问题和 estimand

比较的主单位是完整的已配置 Agent 系统。当前五配置矩阵联合评估 verifier 结果和资源度量。

| 分析问题             | 主要 estimand                      | 必要控制或限定                                                          |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| 配置结果             | 各子集通过比例                     | 报告分子、分母、任务 revision、replicate 数量、模型、推理强度和重试策略 |
| 资源分配             | 观测 token、round、和工具调用记录  | token 组分保持分离；round 在不同运行时之间语义不等价                    |
| 轨迹形状与工具可靠性 | 工具调用数量、失败模式、缓存命中率 | 同一 adapter 内解释 round；跨系统用工具调用和 elapsed time              |

Ello Rapid、Ello Thorough、二者各自的 Subagent 配置和 Claude Code 都作为完整配置参与比较。它们的标签标识已配置策略，而不是成功标准。每次比较都报告 harness 结果、观测模型 token、模型 round、工具调用，以及相关的不确定性或识别限界。

本方法论将每个配置作为完整 bundle 进行比较，并分别记录 Agent runtime、prompt、Command/Tool 协议、上下文策略和停止/恢复语义。当前运行采用单 replicate，报告算术平均数、中位数、P95、配对比率和 Wilson 区间。

### 1.2 比较范围：包含什么，排除什么

**包含：** 本 benchmark 测量 Agent 能否在给定代码库中定位相关位置、编辑或创建文件、运行测试和验证工具、并产生能被 harness 接受的最终仓库状态。资源测量量化 Agent 消耗的 token、round 和时间。

**排除：** 本 benchmark 不测量代码审查质量、生产部署适配性、长期可维护性、安全审计、无障碍合规、产品判断、人机协作、或 patch 是否会被上游维护者接受。Round 和工具调用的绝对数量不能在不同运行时之间直接比较（它们记录和批处理工作的方式不同）。一个正确但有风格差异的实现和一个不正确但编译通过的回答，在 harness 看是相同结果，但在本评估框架之外含义迥异。

### 1.3 已发布矩阵和人群定义

当前轮次发布矩阵包含完整 113 个 DeepSWE 任务、5 个 Agent 配置、每个 `task × agent` 1 次重复：共 565 个 planned job。最终 520 个 scored job 与 45 个 infrastructure-invalid job 分开报告。

后续多 replicate 轮次将使用多种分析人群（发布结果人群、跨运行关系人群、观测代码人群等）。当前单 replicate 轮次仅使用"发布结果人群"。

## 2. Agent 配置

### 2.1 Ello Rapid 与 Ello Thorough

- primary/auxiliary model：`deepseek-v4-flash-official`；
- reasoning effort：High；声明上下文窗口：1,000,000；
- provider-visible toolset：精确为 `{ command_run }`；
- Rapid 与 Thorough 使用相同 Ello runtime、Command schema、权限和模型配置，仅 prompt policy 不同；
- subagent：Rapid 与 Thorough 均同时运行 disabled/enabled 两种完整配置；主线程和子线程用量分别记录后再汇总。

Ello adapter 从 Agent evidence 归一化模型 round、内部 Command 和 usage。一个 outer `command_run` 可以包含多个带 phase 依赖的 Command；报告中的 tool calls 是规范化 Command 事件，不等于 provider-visible Tool Call 数量。

### 2.2 Claude Code

- model：`deepseek-v4-flash-official`，High reasoning；
- 使用固定 Claude Code 2.1.220 binary 与校验后的 SHA-256；
- 工具面由 Claude Code CLI 定义；
- adapter 从 stream-json 事件归一化模型 round、工具调用和 provider usage。

跨系统资源比较使用同 Task 的 elapsed、token 与 tool-call ratio，并保留证据覆盖 n。

## 3. 数据协议和统一

### 3.1 Token 会计

原始模型 usage 将 input、output、cache read 和 cache write token 保持分离。报告必须保留这些组分，而不是将它们折叠成未标记的"总 token"。

```text
uncached input = input tokens − cache read tokens
cache hit rate  = cache read tokens / input tokens（当 input > 0）
```

`cache read` token 不是额外的输入，不应在已包含 `input` 的情况下再加总。如果 provider 没有报告 `cache write`，显示 `n/a` 或 `unreported`，不能写成 0 并据此推断没有缓存写入。

### 3.2 Round 会计

每个 adapter 从自身可观测事件中恢复模型请求/响应 round。同一个模型在不同 runtime、compaction 和批处理策略下仍可能产生语义不同的 round。

因此 round 计数是运行时特定的描述性指标，不应单独解释为"思考步数"。跨运行时报告 round 时，必须同时报告 elapsed、tool calls、token 和 evidence coverage。

### 3.3 工具调用和命令会计

工具调用计数来自 Agent adapter 记录的完整调用历史。Ello 统计 Command Run 内部 Command；Claude Code 统计其 stream-json 暴露的工具事件。二者的批处理边界不同，因此"工具调用"不能在不同 runtime 之间视为等价的原子工作单元。

这一定义差异全部发生在运行时的 recording 层，而不是在模型使用的指令或上下文内容中。保留原始计数完整性，但将其标定为同一 adapter 内的诊断信号，而非跨适配器的能力指标。

## 4. DeepSWE 子集

### 4.1 来源与固定

上游 DeepSWE v1.1 任务仓库和官方 trial 数据按 revision 固定。一个已归档的 task-set hash 对应的 membership 不可变；若 clean-baseline preflight 证明任务环境已经失真，则发布带新 hash 的受控 task-set revision。

| 项目                     | 值                                                                              |
| ------------------------ | ------------------------------------------------------------------------------- |
| 来源                     | [DeepSWE v1.1](https://deepswe.datacurve.ai/)，任务仓库 `datacurve-ai/deep-swe` |
| 固定 revision            | `a40d7298b18999c2d9b0ded7d6928e3ee26b5524`                                      |
| 上游任务数               | 113                                                                             |
| 选择任务数               | 113                                                                             |
| 完整任务集 task set hash | `11f4e80cf1cf74f393e6361f71872596a8d5ff6be743b7214457acd4a847a218`              |

### 4.2 难度分层规则

完整 113 个任务全部进入 suite，不做子集抽样。每个任务都获得确定性难度标签：

1. 将上游官方 trial 数据按语言分组，在每种语言内按官方 trial 通过率降序排列；
2. 将该语言特定排名划分为四个大致相等的 band；
3. 将 band 标记为 `easy`、`medium-easy`、`medium-hard`、`hard`；
4. 同等通过率按 task ID 确定性打破平局。

113 个 task ID、语言与 band 由 task set hash 冻结于 suite manifest（计算所用 trials 快照获取于 2026-08-15）。20/40/60/80 这些分位值是**难度锚点**。当前官方 trial 数据可以刷新记录的通过率和排名，同时保留已归档 task-set hash 的 membership。

### 4.3 难度分布

完整任务集按语言 × band 的任务数：

| 语言       | easy | medium-easy | medium-hard | hard | 合计 |
| ---------- | ---: | ----------: | ----------: | ---: | ---: |
| Go         |    8 |           9 |           8 |    9 |   34 |
| Python     |    8 |           9 |           8 |    9 |   34 |
| TypeScript |    8 |           9 |           9 |    9 |   35 |
| Rust       |    1 |           1 |           1 |    2 |    5 |
| JavaScript |    1 |           1 |           1 |    2 |    5 |
| 合计       |   26 |          29 |          27 |   31 |  113 |

快照通过率四舍五入到最近的百分点以便阅读；审计使用未舍入的值。Rust 和 JavaScript 的候选池仅各 5 题，分四档后每档只有 1-2 题，难度锚点只能是粗略近似。

### 4.4 完整 DeepSWE 任务清单

完整 113 个 task ID、语言与 band 冻结在代码中（`packages/ello-bench/src/domain/suite/deep-swe.ts`），由 §4.1 的 task set hash 保证 membership 不可变；清单长度、语言分布与 band 分布由测试断言。

### 4.5 执行与评分

每次运行从任务固定的 base commit 和 Docker image 开始。Agent workspace 从固定镜像提取，Shell/文件操作在任务容器内执行；verifier 在使用同一镜像的新容器中评估最终 patch。有效 verifier 报告且 reward 为 `1` 是 pass；有效报告且 reward 为 `0` 是任务失败。

verifier 前先对未修改代码执行 baseline preflight。baseline 不健康时，该 attempt 记为 infrastructure-invalid，不进入 reward 分母。容器镜像 ID、网络策略、CPU、内存、存储限制、workspace tree 和 patch hash均进入 run artifact。

**基础设施结果不是任务失败。** 非零 verifier 进程退出、缺失报告、malformed reward、不可用镜像、工作区准备失败、超出任务合同的超时、或 artifact 写入失败应标记为 **`infrastructure-invalid`**，并从通过率分母中排除，直到 rerun 或显式报告为缺失。将基础设施失败当作零分会将 Agent 能力与 benchmark 可用性混淆。

`infrastructure-invalid` 是 run state machine 的一等终态，可以在固定上限内重试；报告保留全部 invalid ledger，但只用每个 job 的最终 attempt 决定 scored matrix。

## 5. SWE-bench Pro 子集（已定义，当前轮次未执行）

### 5.1 来源与固定

上游 SWE-bench Pro 任务仓库按 revision 固定。任务 membership 不可变。

| 项目          | 值                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------- |
| 来源          | [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os)，任务仓库 `scaleapi/SWE-bench_Pro-os` |
| 固定 revision | `ca10a60a5fcae51e6948ffe1485d4153d421e6c5`                                                          |
| 上游任务数    | 731                                                                                                 |
| 选择任务数    | 30                                                                                                  |
| 评分          | binary reward                                                                                       |

### 5.2 选择规则

这组三十题用于 Agent 优化闭环。分层依据是上游仓库九组公开轨迹在固定 revision 上的通过频次。选择覆盖四种语言（Python、TypeScript、Go、JavaScript）和四档难度（easy、medium-easy、medium-hard、hard），但未强制每种语言和每档难度等量。任务 membership 由 task set hash 固定。

### 5.3 执行与评分

SWE-bench Pro 任务使用 Docker 镜像提供隔离的测试环境。每次运行从任务固定的 base commit 开始，Agent 生成 patch；verifier 在 Docker 容器内执行 FAIL_TO_PASS 和 PASS_TO_PASS 测试。两类测试全部通过则 reward 为 `1`；任一测试失败则 reward 为 `0`。Docker 固定了任务依赖，同时引入 Docker daemon、镜像拉取、容器 runtime 和 storage audit 等基础设施依赖；这些失败必须保持 infrastructure-invalid。

完整任务清单将在首轮 SWE-bench Pro 执行报告中发布。

## 6. 数据归一化、分析和发布规则

### 6.1 允许的归一化和禁止的归一化

**允许的归一化：** 按 provider 定价模型标准化 token 计数；将共享 schema 的 Agent 事件转换为统一合同；重新分配字段而不发明值；为比较性图表对齐坐标范围。

**禁止的归一化：** 发明未记录的 token 组分；在 provider 未报告 `cache_write` 时记为 0；声称跨运行时 round 或命令计数等价；用推测值替代缺失数据；将基础设施失败重新编码为零分以纳入平均。

当归一化改变观测值的语义时——例如将 token 字段折叠为单一总数——同时报告原始和转换后的值。

### 6.2 统计摘要

当前运行按单 replicate 统计合同汇总算术平均数、中位数、P95、配对比率和 Wilson 区间。

**配置级结果表**使用所有已发布的 harness-scored 运行。**跨运行关系图**可能在排除极端长尾观测后使用缩减人口，排除条件和阈值必须预先声明、统一应用，并在附带的 CSV 中逐观测记录。阈值将 estimand 从完整经验人口改变为声明的非长尾关系人口。每个统计图和标题必须说明分母和排除规则。

## 7. 报告协议

### 7.1 主要指标

两个子集分别报告：

- **DeepSWE：** passes / valid task runs 和通过率，保留 replicate 级结果（当前为单 replicate）。
- **SWE-bench Pro：** passes / valid task runs 和通过率，保留 replicate 级结果。

对于每次策略比较，报告这些结果指标，同时报告观测的模型 token、模型 round、工具调用和 elapsed。配置级同时展示算术平均数与中位数；Task 级保留五配置并列值和严重长尾。仅报告聚合节省可能隐藏昂贵的失败。验证活动可以从可追溯的 test、build、lint 证据中总结，但原始命令计数不应在不同批处理粒度的运行时之间视为等价的原子工作单元。

对于 Agent 之间的比较，使用相同的任务 revision、模型（当 Agent 比较需要时）、推理强度设置、超时策略、网络策略和 replicate 数量，并随比较结果发布运行矩阵。

### 7.2 统计报告合同

对于每个回归分析，说明分析人群、响应变量、预测变量变换、加权或 trial 分母、调整变量、estimand、区间构造、缺失数据处理和排除规则。系数仅与其单位或变换一起报告。拟合概率差异以百分点报告，odds ratio 报告为 `exp(β)`。

配置差异是系统级对比。组件级因果主张需要交叉设计。

### 7.3 可选总体摘要

如果需要总体工程分数，使用 task 级 macro average 以使每个任务在其自身 harness 产生任务分数后贡献相等。标注公式并将子集分数保持相邻。

### 7.4 不确定性

始终显示计数和百分比。所有百分比报告 Wilson 95% 置信区间。区间不纠正任务依赖，样本量不支撑超出本精选集的精确人群泛化。官方 DeepSWE 网站同样报告不确定性，并警告不要对小样本定性频率过度解读。[^deepswe-home] [^deepswe-methodology]

## 8. 异常和边界情况

### 8.1 难度是经验性的且依赖模型池

官方通过率取决于官方记录中存在的模型、Agent harness、推理强度设置和 trial 混合。标记为 hard 的任务对后来的模型可能变得容易，低通过率也可能部分反映 verifier 或环境摩擦。当官方 trial 池变化时，难度标签应重新生成或版本化。

### 8.2 稀疏语言池扭曲目标通过率

DeepSWE 中 Go 和 Python 各有 34 个合格任务，TypeScript 有 35 个，但 Rust 和 JavaScript 在捕获的选择中各仅 5 个。四个分层在五个候选项上不能紧密匹配四个固定的完成率目标。等语言表示以更不均匀的难度剖面为代价被保留。

### 8.3 Rank-band 边界效应

选择每个 rank band 中的第一个任务是确定性的，但对 band 边界附近的小通过率变化敏感。它也倾向于选择每个 band 的较容易端。未来 revision 可以预先声明带唯一性约束的最近目标匹配，但更改算法会定义一个新的子集版本，不应追溯更改已有结果。

### 8.4 不等价的 verifier 粒度

一个 harness item 可以代表一个窄参数检查或一个宽浏览器流程。断言数量因此不是语义难度单位。这就是 task 级 macro aggregation 优于池化所有断言的原因。

### 8.5 环境和平台敏感性

CLI 输出可能因操作系统、locale、文件系统排序、路径分隔符、终端能力、时间戳、权限和归档库而异。fixture 应禁用无关的颜色/图标输出，固定 locale 和依赖版本，仅归一化声明的非确定性字段，并保留退出码、stdout 和 stderr 语义。

### 8.6 网络和源漂移

仓库、包注册表、视频、文档页面和数据端点可能变化或消失。Source commit 和本地 task asset 必须在许可允许的情况下固定。外部链接检查应记录日期；链接失效不自动是 Agent 失败——如果 artifact 在运行时使用了有效源。

### 8.7 Verifier 不完备性

基于程序的 verifier 近似规格说明；它们不是规格说明本身。它们可能遗漏有效的替代行为或允许不完整的实现。DeepSWE 的作者明确激励行为验证，同时也指出 verifier 设计是需要持续改进的领域。[^deepswe-methodology] Harness 变更需要版本化并重新评估可比较性。

## 9. 局限性和有效性威胁

### 9.1 构造有效性

本 benchmark 在特定 prompt、工具、超时、环境和 verifier 下测量性能，评估对象聚焦 Agent 在任务仓库中的实现与验证过程。

### 9.2 外部有效性

DeepSWE 覆盖五种语言，官方语料集中在 TypeScript、Go 和 Python，取自成熟的开源仓库。[^deepswe-methodology] SWE-bench Pro 在本 benchmark 中采用覆盖 Python、TypeScript、Go 和 JavaScript 的 30 题固定校准集，并按该集合单独报告。

### 9.3 选择偏差

DeepSWE 使用固定 revision 下的完整 113-task 任务集，其语言与难度分布沿用上游语料。SWE-bench Pro 子集依赖上游九组公开轨迹的通过频次，所选任务按该 30-task 集合单独报告。

### 9.4 污染

DeepSWE 和 SWE-bench Pro 通过使用原始任务而非从已有公共 commit 复制修复来降低基准泄露。[^deepswe-methodology] 这降低但不能消除污染：模型可能见过底层仓库、库、发布后的任务描述或相似实现。代码生成 benchmark 的研究发现，与训练语料库的表面和语义重叠都可能实质性膨胀测量性能。[^contamination-paper]

### 9.5 时间有效性

模型 API、Agent 实现、包注册表、benchmark artifact 和源仓库都在持续演化。每次发布应注明 benchmark revision、选择时间戳、模型标识符、Agent 版本、配置和执行周期。不同 revision 下的结果在没有兼容性审计的情况下不能直接比较。

### 9.6 统计功效和相关性

113 个 DeepSWE 任务提供完整 suite 覆盖；30 个 SWE-bench Pro 任务按固定子集报告。同一仓库、语言或 Agent 运行时内的结果可能相关，因此以 task 为配对单位。当前运行采用单 replicate。

### 9.7 成本和超时效应

长程性能对 token 预算、推理强度、工具调用限制、墙钟超时、网络访问和服务 tier 敏感。更多资源可能提高完成率同时增加成本。因此能力和效率应一起报告，不要在没有显式效用函数的情况下折叠。

### 9.8 Round 与工具调用语义

跨 Agent 的 round 和工具调用由各自 adapter 归一化，并与 elapsed、input/output token 和 evidence coverage 一起报告。

## 10. 复现检查清单

发布或比较一次运行前：

- 冻结 benchmark revision 和选择 artifact；
- 验证 DeepSWE 任务集包含 113 个唯一任务（go 34、python 34、typescript 35、rust 5、javascript 5；band 分布 easy 26 / medium-easy 29 / medium-hard 27 / hard 31），SWE-bench Pro 选择包含 30 个唯一任务；
- 记录官方 task/trial artifact URL 和获取时间；
- 验证所有任务声明和 harness schema；
- 固定 source commit、依赖 lockfile、容器镜像、locale 和运行时版本；
- 发布 agent/model/effort 矩阵、replicate 数量、超时、并发和网络策略；
- 保留原始事件、归一化 round、仓库 diff、verifier 输出和 retry lineage；
- 区分有效任务失败和 infrastructure-invalid 运行；
- 所有比率包含计数和分母；
- 标注每个排除、重跑、harness revision 和人工判断；
- 当前为单 replicate，不做回归模型拟合。

## 11. 参考文献

[^deepswe-home]: Datacurve AI, "DeepSWE," 官方 benchmark 网站和 v1.1 leaderboard, <https://deepswe.datacurve.ai/> (accessed 2026-07-12).

[^deepswe-methodology]: Datacurve AI, "DeepSWE: Measuring frontier coding agents on original, long-horizon engineering tasks," 方法论、分析和局限性, <https://deepswe.datacurve.ai/blog/deepswe> (accessed 2026-07-12).

[^deepswe-repository]: Datacurve AI, "deep-swe," 任务定义和 benchmark 源仓库, <https://github.com/datacurve-ai/deep-swe> (accessed 2026-07-12).

[^swebenchpro-repository]: Scale AI, "SWE-bench_Pro-os," 任务定义和 benchmark 源仓库, <https://github.com/scaleapi/SWE-bench_Pro-os> (accessed 2026-07-28).

[^pier-repository]: Allen Institute for AI, "Pier: Workspace manager for coding agents," <https://github.com/allenai/pier> (accessed 2026-07-12).

[^harbor-tasks]: Harbor Framework, "Task Structure," 任务 metadata、指令、环境、verifier、解决方案和网络策略格式, <https://www.harborframework.com/docs/tasks> (accessed 2026-07-12).

[^swebench-paper]: Carlos E. Jimenez, John Yang, Alexander Wettig, Shunyu Yao, Kexin Pei, Ofir Press, and Karthik Narasimhan, "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?", _ICLR 2024_, arXiv:2310.06770, <https://arxiv.org/abs/2310.06770>.

[^contamination-paper]: Yiming Yang, Wenjin Yao, Yujia Zhang, Patricio P. B. Gusmao, and others, "Quantifying Contamination in Evaluating Code Generation Capabilities of Language Models," _Proceedings of ACL 2024_, <https://aclanthology.org/2024.acl-long.761/>.

额外实现证据见 [ello-bench 源码](../../packages/ello-bench/src/) 和 [当前发布产物](results/)。
