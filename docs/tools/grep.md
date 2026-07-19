---
title: 'grep — 文件内容搜索工具设计'
description: '深度解析 ello grep 工具：正则匹配与 Unicode 支持、文件遍历与忽略目录、2 MiB 文件大小阈值、搜索结果格式，以及渐进式搜索的取消机制。'
keywords: ['grep', '内容搜索', '正则表达式', 'ripgrep', '文件过滤']
---

## 设计目标

`grep` 在工作区文件中搜索匹配正则表达式的行。核心约束：

1. **Unicode 正则** — `new RegExp(pattern, 'u')`，支持多语言文本。
2. **安全遍历** — 跳过 `.git`、`node_modules`、`dist`、`build`、`coverage` 目录。
3. **文件大小阈值** — 超过 2 MiB 的文件直接跳过，避免内存爆炸。
4. **二进制检测** — 含 `\x00` 或 `\uFFFD` 的文件视为二进制，跳过。
5. **上限控制** — `limit` 控制最大匹配行数，`walk` 限制遍历文件数（`limit × 200`）。

## 工具定义

源码路径：`src/agent/tools/search.ts`

```typescript
defineCodingTool({
  name: 'grep',
  description:
    'Search UTF-8 file contents with a Unicode regular expression. Skips binary files, ignored directories, and files larger than 2 MiB.',
  discovery: {
    aliases: ['search text', 'find content', 'regex'],
    risk: 'readonly',
  },
  input: z
    .object({
      pattern: z.string().min(1),
      path: z.string().default('.'),
      glob: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
});
```

### 参数设计

| 参数      | 类型      | 默认值 | 说明                                 |
| --------- | --------- | ------ | ------------------------------------ |
| `pattern` | `string`  | —      | Unicode 正则表达式（必填）           |
| `path`    | `string`  | `"."`  | 搜索起始目录                         |
| `glob`    | `string?` | —      | 文件名过滤，如 `*.ts`、`**/*.test.*` |
| `limit`   | `number`  | `100`  | 最大返回匹配行数，上限 500           |

## 执行链路

```
模型调用 grep({pattern, path, glob?, limit})
  ↓
walk(fs, root, limit * 200, signal)    → 递归遍历目录树
  ├─ 跳过 .git/node_modules/dist/build/coverage
  ├─ 跳过符号链接
  └─ 收集所有文件路径
  ↓
glob 过滤（若提供）                    → globToRegExp 编译 glob pattern
  ↓
逐文件扫描:
  ├─ stat 检查大小 → > 2 MiB 跳过
  ├─ readText → 含 \x00 或 \uFFFD 跳过（二进制检测）
  └─ 逐行匹配 RegExp → 收集匹配行
  ↓ → 到达 limit 时立即返回
  ↓
结果格式: "相对路径:行号:匹配行文本"
```

## 遍历策略

```typescript
async function walk(
  fs: AgentFileSystem,
  root: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    signal?.throwIfAborted();
    if (result.length >= limit) return;
    const entries = await fs.listDir(dir);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      // ...
    }
  }
  await visit(root);
  return result;
}
```

### 遍历上限

`walk` 的文件收集上限为 `limit × 200`：

- 默认 `limit=100` → 最多遍历 20,000 个文件。
- 到达上限时停止遍历，因此可能漏掉排在字母序后面的目录中的匹配。

**为什么是 limit × 200？** 这是一个经验性比值：假设大约每 200 个文件中有一个文件包含匹配。如果遍历更多文件仍未找到足够匹配，进一步扫描的边际收益递减——模型应先处理已找到的结果，再发起新的更精准的搜索。

### 忽略目录

```typescript
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
```

硬编码的白名单式忽略列表。不读取 `.gitignore`：`.gitignore` 可能很大且解析复杂，并且它的语义是针对 Git 版本控制的，不等同于"搜索时应忽略"（`.env` 在 `.gitignore` 中，但 grep 仍然应该能搜到）。

## 文件大小阈值

```typescript
if (info.size > 2 * 1024 * 1024) return undefined; // > 2 MiB，跳过
```

2 MiB 阈值是硬编码的。超过此大小的文件不参与搜索，无论内容是否匹配。

**取舍分析**：

- **阈值太低** → 可能漏掉大日志文件中的关键信息（如 `error.log`）。
- **阈值太高** → 一次 grep 读取大量文件消耗内存和时间，阻塞模型等待。

当前选择 2 MiB 是偏保守的——宁愿漏掉大文件中的匹配，也不让 grep 成为性能瓶颈。模型可以通过 `read` + `offset`/`limit` 手动搜索大文件。

## 结果格式

```
src/tools/fs.ts:35:      name: 'read',
src/tools/fs.ts:138:     name: 'write',
tests/fs.test.ts:12:     const result = await read({path: 'fixture.txt'});
```

`相对路径:行号:匹配行文本` — 与 `ripgrep` 的默认输出格式一致。行号从 1 开始，路径相对于 `path` 参数。

## 取消机制

```typescript
input.signal?.throwIfAborted();
```

遍历期间定期检查 `AbortSignal`，用户可以在 TUI 中取消正在执行的搜索。大型仓库的 grep 可能需要数秒完成，取消是基本操作而非可选功能。

## 与上下文缓存的关系

grep 结果可能包含大量匹配行（上限 500 行）。虽然经过 `truncate(12_000)` 处理，但 500 行源代码仍可达 10,000+ 字符。

**缓存友好性**：grep 输出是纯文本行列表，格式固定。相同 `(pattern, path, glob)` 组合对同一文件系统状态产生相同结果 → prefix match 下缓存可复用。

**但实际缓存价值有限**：grep 结果的上下文行（匹配行周围的代码）在模型下一步推理中才是关键——模型通常会立刻 `read` 匹配行所在的文件。因此 grep 本身的重用性不高，缓存收益主要来自后续的 `read`。
