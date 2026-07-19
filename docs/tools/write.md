---
title: 'write — 文件写入工具设计'
description: '深度解析 ello write 工具：全量覆写语义、expectedContent 乐观并发控制、审批前 diff 预览，以及与 read 的缓存协作。'
keywords:
  ['write', '文件写入', '乐观并发控制', 'expectedContent', 'overwrite 安全']
---

## 设计目标

`write` 执行文件的全量覆写（overwrite），不是增量追加。核心约束：

1. **覆写安全** — 已有文件必须提供 `expectedContent` 做乐观锁校验，防止覆盖他人的并发修改。
2. **审批前预览** — 审批阶段即生成 diff，让用户在确认前看清全部改动。
3. **原子写入** — 通过 `AgentFileSystem.writeText` 完成，不提供部分写入或断点恢复。

## 工具定义

源码路径：`src/agent/tools/fs.ts:138`

```typescript
defineCodingTool({
  name: 'write',
  description:
    'Create or overwrite a file. Requires approval outside bypass or accept-edits mode.',
  discovery: {
    aliases: ['create file', 'overwrite file'],
    risk: 'workspace-write',
  },
  input: z
    .object({
      path: z.string().min(1),
      content: z.string(),
      expectedContent: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict(),
});
```

### 参数设计

| 参数              | 类型      | 说明                                 |
| ----------------- | --------- | ------------------------------------ |
| `path`            | `string`  | 目标文件路径（必填）                 |
| `content`         | `string`  | 写入的完整内容（必填）               |
| `expectedContent` | `string?` | 期望的当前文件内容，用于乐观并发控制 |
| `reason`          | `string?` | 操作原因，展示在审批界面             |

**`expectedContent` 的语义**：如果文件已存在但 `expectedContent` 未提供，write 直接拒绝。如果提供但与当前实际内容不匹配，同样拒绝。这防止模型基于过期 `read` 结果做出错误的覆写决策。新文件（文件不存在）可以省略此参数。

## 执行链路

```
模型调用 write({path, content, expectedContent?})
  ↓
requireFs + readOptional       → 读取当前文件内容（为 null 表示不存在）
  ↓
assertWriteExpectedContent     → 文件存在但未提供 expectedContent? → 拒绝
                              → expectedContent 与当前不一致? → 拒绝
  ↓
fs.writeText(path, content)    → 原子写入
  ↓
createFileChange(before, after) → 生成结构化 diff
  ↓
createCodingToolResult(        → "Wrote N bytes (+A -D)."
  title, output, metadata)
```

## 乐观并发控制

```typescript
function assertWriteExpectedContent(
  targetPath: string,
  previous: string | null,
  expectedContent: string | undefined,
): void {
  if (previous === null) return; // 新文件，放行
  if (expectedContent === undefined) {
    // 文件存在但未声明预期内容
    throw new Error(
      `Refusing to overwrite existing file without expectedContent: ${targetPath}`,
    );
  }
  if (expectedContent !== previous) {
    // 内容冲突
    throw new Error(`File changed since last read: ${targetPath}`);
  }
}
```

写入冲突保护要求使用以下工作流：**read → 修改 → write(expectedContent=read 的结果)**。任何中断此链条的操作（如两轮 read 之间他人修改了文件）都会在 write 阶段被拦截。

**为什么不做 merge？** ello 的设计原则是 fail fast。当检测到冲突时，不应静默合并或覆盖，应暴露给模型让其重新 decision——模型可以再次 read 最新内容，重新生成合适的 `content`。

## 审批策略

```typescript
approval: async (input, ctx) =>
  decide({
    permission: 'edit',
    patterns: [input.path],
    always: [input.path],
    paths: [input.path],
    metadata: await writeMetadata(input, ctx.agent),
  }, ctx.agent),
```

审批元数据 (`writeMetadata`) 在审批阶段即执行 `readOptional` + `createFileChange`，生成完整的 before/after diff。用户在审批弹窗中看到的 diff 基于**磁盘当前状态实时计算**，而非模型声明的 `expectedContent`。

**审批阶段的竞争**：`writeMetadata` 与被批准后的 `execute` 之间文件可能被外部修改。此时 `execute` 内部再次 `readOptional` + `assertWriteExpectedContent`，形成双重校验。

## 输出格式

```
Wrote 1234 bytes to src/foo.ts (+56 -12).
```

不返回文件完整内容。如需确认写入结果，模型应显式 `read`。这避免 write 输出过大，同时保持上下文缓存稳定——write 输出仅包含统计信息。

## 与上下文缓存的关系

`write` 输出是极短的摘要行，对上下文缓存几乎无影响。但 write 可能引发的**后续 read** 需要注意：

**模型行为约束**：write 完成后，对话历史中的旧 `read` 结果已经过时。模型如果继续引用旧内容，会做出错误决策。当前设计中，依赖模型自身的推理能力判断何时需要重新 read，不提供隐式的"写入后自动刷新缓存"机制。

**为什么不自动刷新？** 如果 write 后自动重新 read 并注入对话历史，将引入不可控的上下文增长。且"需要刷新哪些文件"只有模型自己最清楚——可能写入只影响一个接口，无需重读整个文件。
