# Subagent 权限与工具边界

## 1. 设计目标

Subagent 与主 Agent 在同一个 root Thread 中工作。用户选择的是会话权限模式，不应该因为
执行者从 main 变成 child 就被悄悄降级或重新要求审批。

必须满足以下合同：

- main 为 `bypass` 时，所有 child 都不产生工具审批；
- main 为其他模式时，child 与 main 在每次工具调用时读取同一个会话模式；
- Agent definition 可以通过工具白名单和明确拒绝缩小能力，不能扩大 root Thread 的权限；
- 父级 hard deny、外部目录边界和隔离边界不能被委派绕过；
- 只有最终决策为 `ask` 时，审批请求才交给 root connection。

fresh/fork 与 foreground/background 只描述上下文和调度，不改变权限继承语义。

## 2. 三层权限模型

工具能力拆成三个顺序明确的层次：

```text
tool visibility
  -> hard boundary
  -> root session mode and approval policy
```

### 2.1 工具可见性

definition 的 `tools` 决定 child 模型能看到哪些工具。普通命名 child 按自己的 definition
装配；fork 使用父 run 当时的 exact tools，不能在恢复或配置重载后扩大工具池。

工具未进入 child runtime 时，模型没有调用入口。权限规则不能把一个不可见工具重新加回。

### 2.2 Hard boundary

以下规则在会话模式之前判断，命中后直接 `deny`：

- 父级明确的 deny 规则；
- 父级 `external_directory` 拒绝边界；
- child definition 的明确 deny；
- definition 未允许时的递归委派拒绝；
- definition 未允许时的 task board 工具拒绝；
- workspace isolation 与 Server runtime 的固定安全限制。

`bypass` 表示跳过审批，不表示绕过这些确定性拒绝。实现时必须先判断 hard boundary，再把
剩余的 `ask` 按 `bypass` 转成自动执行。

### 2.3 Root session mode

root Thread 持久化唯一 `SessionMode`：

```ts
type SessionMode = 'plan' | 'ask-before-changes' | 'accept-edits' | 'bypass';
```

child 不保存另一套会漂移的 `permissionMode`。每次工具调用都通过 `rootThreadId` 读取与 main
相同的 mode provider：

| root mode            | child 行为                                                |
| -------------------- | --------------------------------------------------------- |
| `plan`               | 只读；编辑、Shell 等按 plan hard boundary 拒绝            |
| `ask-before-changes` | 需要审批的工具返回 `ask`，请求交给 root connection        |
| `accept-edits`       | 工作区编辑自动执行，Shell、网络等继续按该模式判断         |
| `bypass`             | hard deny 之外的调用自动执行，不创建 approval interaction |

用户在 child 运行期间切换 root mode 时，下一次工具调用读取新模式，与 main 的动态行为一致。每个
tool event 记录实际判定时的 mode，便于审计并避免事后只看当前 mode 产生误判。

## 3. 规则合成

派生函数只负责生成 child 的 hard boundary，不再决定会话模式：

```ts
deriveSubagentBoundary(parentRules, definition) = [
  parent hard deny,
  parent external-directory deny,
  definition hard deny,
  default delegation deny,
  default task-tool deny,
]
```

完整判定顺序为：

1. 校验工具是否在 child 的可见工具集合中；
2. 计算 `deriveSubagentBoundary()`，任一 deny 立即拒绝；
3. 读取 root Thread 当前 SessionMode；
4. 合并该 mode 的默认策略与普通动态规则；
5. 得到 `allow | ask | deny`；
6. `bypass` 将非 hard-boundary 的 `ask` 收口为 `allow`；
7. 只有最终结果为 `ask` 时创建审批 interaction。

父级普通 `allow` 不复制为 child 的额外授权。child 是否能调用某工具仍由 definition 工具
集合决定，调用后再受 root mode 约束。

definition 中的 `allow` 或 `ask` 不能覆盖 root mode 的 deny。需要在 `bypass` 下仍然禁止的
能力必须写成明确 deny，而不是依赖 ask。

## 4. 审批路由

权限模式和审批路由是两个不同概念。任务模型不再使用
`default | acceptEdits | bubble` 一类字段同时表达两者：

```ts
interface AgentTaskPermissionContext {
  rootThreadId: string;
  boundaryRules: PermissionRule[];
  interactionOwner: 'root-thread';
}
```

当最终决策为 `ask` 时，公开请求必须携带：

- taskId、Agent 名称和 definition；
- toolCallId、工具名称与有界参数预览；
- description、cwd 和实际 SessionMode；
- interactionId，用于幂等解决或取消。

TUI 面板必须让用户明确知道请求来自哪个 child。root connection 不可用时，Server 按配置
暂停或拒绝，不能自动放行。

`bypass` 路径不创建 interaction，也不先创建再自动接受。若 TUI 在 root 为 `bypass` 时收到
child approval，说明权限模式源发生分叉，必须作为错误处理。

## 5. 取消与审批收口

审批 interaction 属于发起它的 task：

- `x` 停止 task 子树时，取消目标及后代的 pending interaction；
- root `Ctrl+C` 中断时，取消整棵运行树的 pending interaction；
- interaction 取消后恢复等待中的 child run，使其按中断原因收口；
- 晚到的审批决定不能让已经 killed 的 task 继续执行工具。

Server 先建立 task 或 root cancellation barrier，再取消 interaction。否则 interaction 解决与
停止并发时可能在终态之后启动工具副作用。

## 6. 外部目录与 Skill

`external_directory` 规则约束工作区之外的路径，并作为 hard boundary 随 root 继承。只读和
搜索工具可以把已验证的 Skill 根目录作为 `readRoots` 交给权限系统；写工具仍按外部目录
边界判断。

在 `bypass` 下，用户明确选择跳过普通审批，但 Server 固定的 isolation boundary 和明确 deny
仍然生效。本设计的 isolation 合同只接受 shared；worktree/container 请求必须在 child 启动前
拒绝，不能降级为 shared。

## 7. 只读定义示例

只读 Subagent 应同时缩小工具集合并声明确定性拒绝：

```yaml
---
description: Inspect code without modifying the workspace.
mode: subagent
role: small
tools: [read, grep, glob]
permission:
  - permission: bash
    pattern: '**'
    action: deny
    scope: default
---
读取委派范围内的代码并返回带路径的分析结果。
```

即使 root 使用 `bypass`，`bash` 也不会出现在该 child 的工具集合中，明确 deny 仍能作为审计
边界保留。

## 8. 验收矩阵

| 场景                                  | 预期结果                                 |
| ------------------------------------- | ---------------------------------------- |
| main bypass + fresh foreground child  | 不产生审批                               |
| main bypass + fork/background child   | 不产生审批                               |
| main accept-edits + child edit        | 自动执行                                 |
| main accept-edits + child bash        | 按 accept-edits 规则审批                 |
| main ask-before-changes + child write | 请求路由到 root connection               |
| main plan + child write               | 拒绝，不允许 definition 覆盖             |
| bypass + definition hard deny         | 拒绝，不创建审批                         |
| child 运行期间 root mode 切换         | 下一次工具调用读取新模式                 |
| `x` / root interrupt 与审批同时发生   | barrier 胜出，interaction 取消，任务收口 |
| root connection 断开                  | 暂停或拒绝，不静默允许                   |

对应运行与取消边界见[Subagent 运行时架构](runtime-architecture.md)。
