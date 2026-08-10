---
title: 'MCP：外部工具与资源接入'
description: '说明 Ello 如何加载 MCP 配置、连接 stdio 或 Streamable HTTP 服务器，并通过 Command Run 使用远端工具与资源。'
keywords:
  ['MCP', 'Model Context Protocol', 'stdio', 'Streamable HTTP', '工具扩展']
---

# MCP：外部工具与资源接入

Ello 通过 [Model Context Protocol](https://modelcontextprotocol.io/) 连接外部工具服务。MCP
不是绕过 Agent 运行时的特殊通道：远端能力进入内部 Command Catalog，继续经过输入校验、
权限审批、Environment Gate、Command 事件、Thread 持久化和大结果 artifact 处理。Provider
始终只看见一个 `command_run` Tool。

## 配置文件

默认配置文件是 `~/.ello/mcp.json`。也可以在 `config.yaml` 设置
`mcp_config_path`；相对路径按项目工作目录解析，修改该字段后需要重启 App Server。

配置文件顶层只有 `servers`：

```json
{
  "servers": {
    "local-notes": {
      "command": "node",
      "args": ["./scripts/mcp-notes-server.mjs"],
      "cwd": ".",
      "env": {
        "NOTES_ROOT": "/srv/notes"
      },
      "timeout_ms": 60000
    },
    "issue-tracker": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${ISSUE_TRACKER_TOKEN}"
      },
      "timeout_ms": 60000
    }
  }
}
```

`command` 表示 stdio 服务器；未写 `type` 时也按 stdio 处理。`cwd` 相对 MCP 配置文件所在
目录解析。`url` 表示 Streamable HTTP 服务器，`type` 可写为 `http` 或
`streamable-http`。`headers` 和 `env` 的值按原样传递，不会展开 `${...}`；凭证应通过
安全的配置生成方式写入，避免将明文提交到仓库。

设置 `enabled: false` 可以暂时跳过某个服务器。服务器名只能使用字母、数字、下划线和连字符，
长度不超过 32 个字符。

## 工具与资源

远端工具名会转换为 `mcp__<服务器名>__<工具名>`。工具名中的不兼容字符会替换成下划线；
过长名称会追加短哈希，避免超过模型供应商的工具名长度限制。

例如服务器 `issue-tracker` 的 `create_ticket` 会显示为：

```text
mcp__issue-tracker__create_ticket
```

支持资源能力的服务器还会增加两个只读工具：

```text
mcp__<服务器名>__list_resources
mcp__<服务器名>__read_resource
```

前者使用可选的 `cursor` 翻页，后者接收资源 `uri`。资源内容会保留文本、图片和二进制附件；
工具结果超过会话输出上限时，Ello 沿用普通工具的 artifact 持久化策略。

MCP 工具始终按需发现，不存在直接暴露给 provider 的兼容模式。模型在 Command Run 中先用
`command_search` 获取准确名称和完整 JSON Schema，再在后续模型回合通过 `command_invoke` 的结构化
`input` 执行目标。模型已经知道名称和 schema 时，也可以把 `command_invoke` 放进当前 Command
Run 的后续 phase；运行时不会把搜索结果插值进尚未编译的 Frame。

`command_search` 与 `command_invoke` 是内部 Command，不是 provider Tool。它们不能发现或递归调用
`command_run`、`command_search`、`command_invoke`，也不能代理核心 `read`、`search`、`write`、
`apply_patch` 和 `bash`，因此权限或 Plan mode 限制不能通过 wrapper 绕过。

## 安全与并发

Ello 读取 MCP `annotations`：

| MCP 注解                                              | Ello 行为                          |
| ----------------------------------------------------- | ---------------------------------- |
| `readOnlyHint: true` 且 `destructiveHint` 不为 `true` | 只读调用，可与其他安全读取并发     |
| 其他情况                                              | 按可能修改外部状态处理，使用独占锁 |
| `destructiveHint: true`                               | 明确标记为可能修改数据，使用独占锁 |

工具参数先按服务器提供的 JSON Schema 校验，再进入权限审批。只读 MCP 工具使用 Ello 的
`read` 权限；其他 MCP 工具使用 `mcp` 权限。Plan 模式拒绝可能修改外部状态的 MCP 工具，
其他常规模式默认要求审批，用户可以通过权限规则细化允许或拒绝范围。

每个 App Server 对同一 MCP 配置文件只建立一组客户端连接，多次创建 Agent 时会复用连接。
App Server 关闭时会关闭所有客户端；对于 stdio 服务器，这会一并结束对应子进程。
