---
title: 'apply_patch — 多文件结构化补丁工具设计'
description: '深度解析 ello apply_patch 工具：Begin/End Patch 协议解析、Add/Delete/Update 三操作模型、审批与执行的两阶段分离、虚拟文件系统预览与原子批量提交。'
keywords:
  ['apply_patch', '结构化补丁', '多文件编辑', 'patch 协议', '两阶段提交']
---

## 设计目标

`apply_patch` 是 ello 的**多文件批量编辑工具**。与 `edit`（单文件单替换）不同，`apply_patch` 用结构化协议描述一次跨文件的操作序列，在审批通过后一次性提交。

核心约束：

1. **协议严格解析** — 必须以 `*** Begin Patch` / `*** End Patch` 包裹，语法错误报告具体行号。
2. **审批预览完整** — 审批阶段在**虚拟文件系统**中推演全部操作，生成每个文件的 before/after diff。
3. **原子批量提交** — 审批通过后 `apply()` 一次性写入所有文件；中途任何文件写入失败则已写入的不回滚（当前实现限制）。

## Patch 协议

```
*** Begin Patch
*** Add File: src/new.ts
+第一行内容
+第二行内容
*** Delete File: src/old.ts
*** Update File: src/modify.ts
@@
 context line
-old line
+new line
 context line
*** Move to: src/renamed.ts
*** End Patch
```

### 三种操作

| 操作            | 标记                      | 行为                              |
| --------------- | ------------------------- | --------------------------------- |
| **Add File**    | `*** Add File: <path>`    | 创建新文件，内容以 `+` 开头       |
| **Delete File** | `*** Delete File: <path>` | 删除文件，无需内容行              |
| **Update File** | `*** Update File: <path>` | 修改现有文件，使用 `@@` 分隔 hunk |

Update File 可选 `*** Move to: <path>` 声明文件重命名。

### Update Hunk 格式

每个 `@@` 标记一个上下文块（hunk）：

- 以空格开头的行 = 上下文行（不修改，仅用于定位）
- 以 `-` 开头的行 = 要删除的行
- 以 `+` 开头的行 = 要添加的行

注意：与 unified diff 不同，`---`/`+++` 文件头不允许使用。Hunk 不使用 `@@ -1,7 +1,8 @@` 格式的 range 声明。

## 两阶段架构

```typescript
parseApplyPatch(patchText)    → ApplyPatch      // 阶段 1: 解析（纯文本 → 结构化）
prepareApplyPatch(fs, patch)  → PreparedApplyPatch // 阶段 2: 预览（虚拟执行 + 生成 diff）
prepared.apply()             → void            // 阶段 3: 执行（真实写入）
```

### 阶段分离原则

审批阶段只走 `parseApplyPatch` + `prepareApplyPatch`，**不触碰真实文件系统**。`prepareApplyPatch` 使用虚拟文件系统推演：

```typescript
// prepareApplyPatch 内部
const initial = new Map<string, string | null>(); // 磁盘快照
const current = new Map(initial); // 虚拟当前状态

for (const operation of patch.operations) {
  switch (operation.kind) {
    case 'add':
      current.set(path, operation.content);
      break;
    case 'delete':
      current.set(path, null);
      break;
    case 'update':
      applyChunks(current, path, operation);
      break;
  }
}

// 为每个变化文件生成 FileChange
for (const [path, after] of current) {
  const before = initial.get(path) ?? null;
  if (before !== after) {
    fileChanges.push(createFileChange(path, before, after, movePath));
  }
}
```

`initial` 保存磁盘初始状态，`current` 充当虚拟文件系统。**同一 patch 中的后续操作可以看到前序操作的结果**：Update A 引入的新函数，Update B 可以立即引用——虚拟文件系统保证了操作间的顺序一致性。

### 路径收集与权限

```typescript
// approval 阶段
const prepared = await prepareApplyPatch(fs, parseApplyPatch(input.patch));
return decide(
  {
    permission: 'edit',
    patterns: prepared.paths, // 所有受影响的文件路径
    always: prepared.paths,
    paths: prepared.paths,
    metadata: { fileChanges: prepared.fileChanges },
  },
  ctx.agent,
);
```

审批弹窗展示**所有文件的完整 diff**——不是 patch 原文，而是经 `prepareApplyPatch` 推演后的结构化变更。用户看到一个 diff 列表，可以逐文件审视。

## 错误报告

```typescript
throw new Error(`Invalid patch: first line must be '${BEGIN_PATCH}'.`);
throw invalidLine(
  index,
  "expected 'Add File:', 'Delete File:', or 'Update File:'",
);
```

解析器对每个语法错误报告**具体行号**和期望内容。模型据此修正 patch 文本后重试。

## 与 edit 的边界

|          | edit                       | apply_patch            |
| -------- | -------------------------- | ---------------------- |
| 修改范围 | 单文件                     | 多文件                 |
| 定位方式 | oldText 文本匹配           | Hunk 上下文行匹配      |
| 修改粒度 | 一次性替换                 | 多个 hunk，顺序执行    |
| 适用场景 | 改一个函数签名、修一行配置 | 跨文件重构、批量重命名 |
| 失败模式 | oldText 不唯一             | 上下文行不匹配         |

**选择指南**：一次只改一个文件的一个位置 → edit；需要改多个文件或多个位置 → apply_patch。不要用 N 次 edit 模拟 apply_patch——那样审批就需要 N 次用户确认。

## 与上下文缓存的关系

`apply_patch` 的 patch 文本可能很长（多文件多 hunk）。这直接进入对话历史中的 `tool_use` 部分，影响 prompt cache。

**设计约束**：patch 中的上下文行越多，缓存负担越大。但上下文行是定位精确性的保证——行数不够可能导致 hunk 匹配失败。当前选择偏向精度：匹配失败导致模型重试的成本，远高于多几行上下文行的 token 开销。
