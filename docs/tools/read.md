---
title: 'read — 文件读取工具设计'
description: '深度解析 ello read 工具：从路径安全、目录列表、二进制检测到行号渲染，以及输出截断与上下文缓存的关系。'
keywords: ['read', '文件读取', '上下文注入', '编码检测', '二进制检测']
---

## 设计目标

`read` 是 ello 最频繁使用的工具，负责将工作区文件内容注入模型上下文。核心约束：

1. **路径安全** — 所有路径必须经 `AgentFileSystem` 的 `allowedPaths` 边界检查，不允许越界读取。
2. **类型适配** — 区分目录、文本文件、二进制文件，每种产出不同格式的模型可消费结果。
3. **上下文预算** — 大文件必须截断，避免单个 `tool_result` 撑爆上下文窗口。

## 工具定义

源码路径：`src/agent/tools/fs.ts:35`

```typescript
defineCodingTool({
  name: 'read',
  description:
    'Read a UTF-8 text file with optional offset and limit. Output includes line numbers.',
  discovery: { aliases: ['file', 'directory', 'cat'], risk: 'readonly' },
  input: z
    .object({
      path: z.string().min(1),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    })
    .strict(),
});
```

### 参数设计

| 参数     | 类型     | 默认值 | 说明                                                                   |
| -------- | -------- | ------ | ---------------------------------------------------------------------- |
| `path`   | `string` | —      | 文件或目录路径（必填），相对路径通过 `resolveRuntimePath` 转为绝对路径 |
| `offset` | `number` | `1`    | 起始行号（从 1 开始），仅对文本文件生效                                |
| `limit`  | `number` | `400`  | 最大返回行数，硬上限 2000                                              |

**limit 硬上限 2000 行** 是有意设置的无界限制。不提供"读取全部"选项，强制模型在上下文中对文件内容做出取舍。需要更多内容时，模型必须发起多次带 `offset` 的调用——这要求模型明确知道它想读哪一部分，而不是无脑 dump 整个文件。这是对上下文预算的主动管控。

## 执行链路

```
模型调用 read({path: "src/foo.ts"})
  ↓
requireFs(ctx.agent)          → 取出环境的文件系统能力（缺省抛错）
  ↓
resolveRuntimePath(fs, path)  → 路径安全检查 + 绝对路径解析
  ↓
statRuntimePath(fs, path)     → 判断文件/目录
  ↓
  ├─ 目录 → listDir + stat 每个子项 → 表格式输出（文件名 | 类型 | 大小）
  │
  ├─ 文件 → readFile Buffer
  │   ├─ 二进制（含 NUL 或 UTF-8 \uFFFD）→ 返回类型标记 + 字节数 + attachment 引用
  │   └─ UTF-8 文本 → 分行 → offset/limit 切片 → 5 位行号前缀 → truncate(MAX_TOOL_OUTPUT)
  │
  └─ createCodingToolResult(title, output, metadata)
```

## 二进制检测

源码路径：`src/agent/tools/fs.ts:370`

```typescript
function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  return buffer.toString('utf8').includes('\uFFFD');
}
```

两条启发式规则：

1. **NUL 字节** — 二进制文件几乎必定包含 `\x00`。
2. **UTF-8 替换字符** — `Buffer.toString('utf8')` 对非法字节序列插入 `\uFFFD`（U+FFFD REPLACEMENT CHARACTER）。

任一条命中即判定为二进制。不输出原始内容，返回：

```
Binary file src/image.png (24567 bytes).
Content is available as an attachment artifact only.
```

同时生成 `attachment` 引用（`{ type: 'binary', mime: 'application/octet-stream', ... }`），供 TUI 侧展示可下载/预览资源。

## 行号渲染

```typescript
`${String(offset + index).padStart(5, ' ')}  ${line}`;
```

5 位右对齐行号，从 `offset` 开始编号。此约定贯穿整个协议：`edit` 工具引用的 `oldText` 不包含行号前缀，行号仅为人类和模型定位提供方便，不参与 diff 计算。

## 输出截断

源码路径：`src/agent/tools/shared.ts:18`

```typescript
export const MAX_TOOL_OUTPUT = 12_000;
```

所有 `read` 输出经 `truncate()` 处理后上限 12,000 字符（≈ 3,000 token）。超出部分替换为 `... truncated ...`。

**为什么不扩大上限？** 一次 `read` 不应占据过多上下文预算。需要更多内容时，模型应使用 `offset` + `limit` 分段读取——这会自然形成"模型主动管理上下文"而非被动接受大段 dump 的行为模式。

## 审批策略

```typescript
approval: (input, ctx) =>
  decide({
    permission: 'read',
    patterns: [input.path],
    always: [input.path],
    paths: [input.path],
    metadata: { kind: 'read', path: input.path },
  }, ctx.agent),
```

`permission: 'read'` 声明只读操作。审批由 `makeApprovalPolicy` 根据用户配置的 `PermissionRule` 动态判定：

- `always: [path]` — 命中 `allow` 规则时永久放行。
- `patterns: [path]` — 供 glob 匹配器判断路径是否符合允许列表。

用户可在 `.ello/config.yml` 配置 `allow: ["src/**"]` 跳过对特定目录的逐次审批。

## 与上下文缓存的关系

`read` 是上下文内容的**主要注入源**。每次 `read` 的结果进入对话历史，而对话历史是 prompt cache 的组成部分。

**关键不变量**：同一 `(path, offset, limit)` 三元组必须产生完全相同的输出（不考虑文件外部修改），否则 prefix 变化导致 prompt cache 大面积失效。

当前实现通过纯函数式的 `offset`/`limit` 切片保证这一性质：不依赖运行环境状态，不插入时间戳或会话 ID。如果需要"读取最近 500 行"，模型需显式计算 `totalLines - 500` 作为 `offset`，而非依赖一个 `tail` 模式。

**与 write/edit 的协作**：`write` 完成后不自动触发重读，模型需要显式发出新的 `read` 调用才能获得更新后的文件内容。这避免了隐式重读引入缓存抖动——模型自己决定何时刷新对缓存的影响。
