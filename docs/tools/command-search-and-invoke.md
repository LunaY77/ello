---
title: 'command_search / command_invoke：内部能力发现与调用'
description: '说明 Command Catalog 如何按需发现 Ello/MCP 能力，并在唯一 command_run 入口内复用 schema、权限和领域语义。'
keywords:
  ['command_search', 'command_invoke', 'Command Catalog', 'MCP', '能力发现']
---

# command_search / command_invoke：内部能力发现与调用

Ello 的 provider 工具集合固定为 `{ command_run }`。`command_search` 与 `command_invoke` 是 Command
Catalog 内部的 Command，不是第二组 provider Tool，也不会在模型历史里形成嵌套 Tool Call。

这套结构同时解决两个问题：provider schema 保持稳定，而 Memory、Skill、Goal、Task、
Subagent、用户输入和 MCP 等动态能力仍然可以按当前 Agent、配置和权限到达。

## 能力目录

Composition root 把当前 Agent 可用的领域 `CommandModule` 编译成 Registry snapshot，再把 snapshot
传给 `createCommandRunRuntime()`。Catalog 从同一份 `defineCommand()` 定义读取：

- 准确名称和描述；
- aliases 与风险级别；
- Zod input schema / JSON Schema；
- 动态 capability、validation 和 approval；
- immediate execute 或 deferred 语义。

没有第二份手写 schema，也不会按名称猜测权限。Catalog revision 由规范化后的能力定义计算，
用于检查 checkpoint 是否仍能安全恢复。

固定内部 Command 默认直接进入 inline Catalog。模型使用 `read`、`search`、`write`、
`apply_patch`、`bash`；`search` 自己拥有 content/file 两种模式，不再依赖 `grep/glob` backing
定义。写入和 Shell 因此无法绕过同一 parser、Plan mode 或审批路径。

## command_search

`command_search` 接收：

```text
command_search [--query <text>] [--limit <count>] [--offset <count>]
```

不提供 query 时返回分页 inventory；提供 query 时，在名称、描述和 aliases 的规范化文本中
筛选。每个命中项包含准确名称、描述、风险级别和完整 input schema，因此下一模型回合可以
构造结构化参数。结果受配置的条数和字节上限约束；超限会要求缩小 query 或 limit。

搜索结果不包含：

- outer `command_run`；
- `command_search` 或 `command_invoke` 自身；
- inline Command；
- 当前 Catalog 中不存在或被过滤的能力。

搜索结果不会自动插值进同一静态 Command Run 的后续 Frame。模型不知道目标 schema 时，应先
搜索并结束本次调用，再在下一模型回合发起 `command_invoke`。

## command_invoke

`command_invoke` 只接受结构化 `input`：

```json
{
  "step": 1,
  "command": "command_invoke",
  "input": {
    "name": "mcp__issues__create_ticket",
    "arguments": {
      "title": "Failure in command replay",
      "labels": ["runtime"],
      "metadata": { "source": "ello" }
    }
  }
}
```

`input` 与 `args/body` 互斥。目标必须精确命中当前 Catalog；nested object/array 参数直接交给
目标 schema，不经过 JSON 字符串、Shell 分词、别名补全或猜测性修复。

执行链如下：

```text
command_invoke frame
  -> strict input decode
  -> exact target lookup
  -> target schema parse
  -> target dynamic capability and validation
  -> target approval
  -> immediate execute OR deferred suspend
```

事件和 Command 记录使用目标 logical name，例如 `memory_search` 或
`mcp__issues__create_ticket`，而不是无信息量的 wrapper 名。目标输出继续使用统一 preview、
artifact 和 metadata 处理。

## 权限、调度与 deferred

Registry 直接绑定目标 definition，不通过 Tool adapter。只读且明确并发安全的目标可以取得共享
Environment Gate；写入、外部状态、未知 Effect 和 deferred 目标保守串行。目标的 validation、
session mode 与 permission policy 在 phase 开始前以及批准后执行前按 runtime 契约检查。

需要审批时，checkpoint 绑定 `command_invoke` Frame 的 typed input digest、目标 logical name、权限
metadata 与 catalog revision。需要用户输入的 deferred 目标会暂停 outer Command Run，保留完成
前缀并阻断尾部；宿主结果恢复原 Command，而不是制造内部 provider Tool Result。

Plan mode 使用目标声明的真实 capability 判定。将 `write` 或 `bash` 写入 `name` 会因其不是
合法 target 而失败；把修改能力伪装成只读名称也无法改变目标自己返回的 Effect。

## Provider cache 与 transcript

按需目录不会动态修改 provider tools 数组。所有 session 和 provider 只注册同一个
`command_run` schema；发现结果位于 outer result 内容中。完整执行后，模型历史仍是：

```text
assistant command_run call
tool command_run result containing ordered Command records
```

compaction 以 outer pair 为单位保留或移除，内部能力调用不需要跨 provider 协议做消息投影。

## 示例流程

第一次模型回合发现 MCP 能力：

```json
{
  "commands": [
    {
      "step": 1,
      "command": "command_search",
      "args": ["--query", "create issue", "--limit", "5"]
    }
  ]
}
```

下一模型回合使用返回的准确 schema：

```json
{
  "commands": [
    {
      "step": 1,
      "command": "command_invoke",
      "input": {
        "name": "mcp__issues__create_ticket",
        "arguments": {
          "title": "Command Run regression",
          "labels": ["runtime", "provider"]
        }
      }
    }
  ]
}
```

Memory、Skill、Goal、Task 和 Subagent 使用同样的发现与调用流程，各领域实现、返回格式和
lifecycle 保持不变。

## 源码与测试入口

- `packages/ello-agent/src/features/command/catalog.ts`
- `packages/ello-agent/src/features/command/runtime.ts`
- `packages/ello-agent/src/app.ts`
- `packages/ello-agent/tests/command/command-run-runtime.test.ts`
- `packages/ello-agent/tests/model/provider-command-run-contract.test.ts`
