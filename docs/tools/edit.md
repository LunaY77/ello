---
title: 'edit — 单文件精确替换工具设计'
description: '深度解析 ello edit 工具：唯一性匹配替换语义、oldText 定位机制、与 write 和 apply_patch 的边界划分，以及 fail-fast 的冲突检测。'
keywords: ['edit', '文本替换', 'oldText', '唯一性匹配', '非结构化编辑']
---

## 设计目标

`edit` 执行**单文件内的单次精确替换**：在目标文件中找到 `oldText` 的唯一匹配，替换为 `newText`。

核心约束：

1. **唯一性匹配** — `oldText` 在文件中必须恰好出现一次，否则直接失败。
2. **非结构化** — 不需要行号、diff hunk、AST 位置，只需要给出一段能唯一标识修改位置的文本。
3. **fail-fast** — 找不到或找到多处都立即报错，不尝试"最优匹配"——模型需要明确推理修改位置。

## 工具定义

源码路径：`src/agent/tools/fs.ts:190`

```typescript
defineCodingTool({
  name: 'edit',
  description:
    'Replace a unique text fragment in a file. Fails when the old text is not unique.',
  discovery: {
    aliases: ['replace text', 'modify file'],
    risk: 'workspace-write',
  },
  input: z
    .object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
      reason: z.string().optional(),
    })
    .strict(),
});
```

### 参数设计

| 参数      | 类型      | 说明                                     |
| --------- | --------- | ---------------------------------------- |
| `path`    | `string`  | 目标文件路径（必填）                     |
| `oldText` | `string`  | 要替换的原文本，必须在文件中恰好出现一次 |
| `newText` | `string`  | 替换后的文本（可为空字符串，即删除）     |
| `reason`  | `string?` | 操作原因                                 |

**`newText` 可为空字符串**：edit 可以直接删除一段文本，无需专门的 delete 工具。`newText: ""` + `oldText` 标记要删除的片段。

## 执行链路

```
模型调用 edit({path, oldText, newText})
  ↓
requireFs + readText          → 读取当前完整文件内容
  ↓
current.indexOf(oldText)      → 查找匹配位置
  ├─ === -1 → 抛错: "Text not found in {path}"
  │
  ├─ 第二次 indexOf ≠ -1 → 抛错: "Text is not unique in {path}"
  │
  └─ 恰好一次 →
       current.slice(0, first) + newText + current.slice(first + oldText.length)
  ↓
fs.writeText(path, next)     → 原子写入
  ↓
createFileChange(before, after) → 生成结构化 diff
  ↓
createCodingToolResult("Edited {path} (+A -D).")
```

## oldText 唯一性约束

`edit` 不提供行号定位，只接受文本内容匹配，且要求唯一。

### 为什么不支持行号？

1. **缓存友好** — 行号依赖 read 结果。如果 read 和 edit 之间文件被修改（行号漂移），行号定位会静默修改错误位置。文本匹配是幂等的：只要 oldText 仍是唯一的，结果确定。
2. **模型友好** — 模型天然擅长引用文本片段（`oldText: "const x = 1;"`），而非记住位置坐标（`line: 42, col: 7`）。
3. **评审友好** — 审批界面只需展示 `oldText` 和 `newText` 的 diff，无需额外解析行号映射。

### 为什么不允许多处匹配？

允许 `replaceAll` 看似方便，实际上会引入静默风险：模型可能不知道文件中有多处相同文本，一次 edit 意外修改了所有位置。强制唯一性迫使模型要么提供更多上下文使 oldText 唯一，要么使用 `apply_patch` 做多处修改。

## 与 write 的边界

|          | write                            | edit                   |
| -------- | -------------------------------- | ---------------------- |
| 语义     | 全量覆写                         | 局部替换               |
| 前提     | 新文件或提供 expectedContent     | oldText 在文件中唯一   |
| 适用     | 创建新文件、大规模重写           | 修改一个函数、一行配置 |
| 失败模式 | 文件存在且未提供 expectedContent | oldText 不存在或不唯一 |

**选择指南**：能精确描述修改片段时用 edit；整个文件都是新内容时用 write。不要用 edit + oldText = 整个文件来模拟 write——这绕过了 expectedContent 的乐观锁保护。

## 审批策略

与 write 一致，审批阶段即解析替换并生成 diff 预览：

```typescript
approval: async (input, ctx) =>
  decide({
    permission: 'edit',
    metadata: await editMetadata(input, ctx.agent),
  }, ctx.agent),
```

`editMetadata` 在审批阶段即读取文件、验证唯一性、生成 diff。审批弹窗中展示的是实时计算的 before/after 对比，而非模型声明的参数。

## 与上下文缓存的关系

edit 的输出是精简摘要（`Edited src/foo.ts (+3 -1).`），对上下文缓存影响极小。

但 **edit 修改了文件内容**，会话中此前的 `read` 结果可能已经过时。模型需要自行判断是否需要重新 `read` 被编辑的文件——ello 不提供自动刷新，原因同 write 的设计分析。
