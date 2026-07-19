---
title: 'glob — 文件路径匹配工具设计'
description: '深度解析 ello glob 工具：轻量级文件查找、* 和 ** 通配符语义、与 grep 的职责分离、遍历上限与排序策略。'
keywords: ['glob', '文件查找', '通配符', '目录遍历', '路径匹配']
---

## 设计目标

`glob` 是 ello 的**纯路径匹配文件查找工具**——与 grep 不同，它不检查文件内容，只匹配文件路径。

核心约束：

1. **轻量查名** — 只做路径字符串匹配，不读取文件内容，快且省内存。
2. **Shell 兼容** — `*` 匹配路径段内任意字符（不跨 `/`），`**` 匹配零或多段路径（跨 `/`）。
3. **遍历共享** — 复用与 grep 相同的 `walk()` 函数和忽略目录列表。

## 工具定义

源码路径：`src/agent/tools/search.ts`

```typescript
defineCodingTool({
  name: 'glob',
  description:
    'Find files using * and ** glob syntax. Does not traverse symlinked directories and ignores .git, node_modules, dist, build, and coverage.',
  discovery: {
    aliases: ['find files', 'match paths', 'files'],
    risk: 'readonly',
  },
  input: z
    .object({
      pattern: z.string().min(1),
      path: z.string().default('.'),
      limit: z.number().int().min(1).max(1000).default(200),
    })
    .strict(),
});
```

### 参数设计

| 参数      | 类型     | 默认值 | 说明                      |
| --------- | -------- | ------ | ------------------------- |
| `pattern` | `string` | —      | Glob 模式（必填）         |
| `path`    | `string` | `"."`  | 搜索起始目录              |
| `limit`   | `number` | `200`  | 最大返回文件数，上限 1000 |

**limit 上限 1000** 比 grep（500）更高，因为 glob 只做路径字符串匹配，即使 1000 条结果也远小于 500 行源代码的 token 量。

## Glob 语法

```typescript
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?'; // **/ 匹配零或多级目录
        index += 2;
      } else {
        source += '.*'; // ** 匹配所有内容
        index += 1;
      }
      continue;
    }
    if (character === '*') {
      source += '[^/]*'; // * 不跨 /
      continue;
    }
    source += /[.+^${}()|[\]\\]/u.test(character ?? '')
      ? `\\${character}`
      : character;
  }
  return new RegExp(`^${source}$`, 'u');
}
```

| 模式     | 语义                                       | 示例                                        |
| -------- | ------------------------------------------ | ------------------------------------------- |
| `*`      | 匹配当前目录层级的任意字符序列（不跨 `/`） | `*.ts` → `src/foo.ts` ✓, `src/sub/foo.ts` ✗ |
| `**`     | 匹配任意层级的目录（跨 `/`）               | `**/*.ts` → 所有 `.ts` 文件                 |
| `**/`    | 可选的零或多级目录前缀                     | `**/test/**/*.test.ts` → 任意深度的测试文件 |
| 普通字符 | 精确匹配                                   | `package.json` → 只匹配根级 `package.json`  |

## 与 grep 的职责分离

|                | glob                | grep                 |
| -------------- | ------------------- | -------------------- |
| 匹配目标       | 文件路径            | 文件内容             |
| 输入           | Glob pattern        | 正则表达式           |
| 速度           | 快（纯路径匹配）    | 慢（需读文件内容）   |
| 结果量         | 1000 上限           | 500 上限             |
| 典型场景       | "列出所有 .ts 文件" | "找到所有 TODO 注释" |
| 是否需要读文件 | 否                  | 是                   |

**组合使用**：先用 glob 缩小文件范围，再用 grep 在这些文件中搜索具体内容——两步分离避免 grep 扫描不相关的文件。

grep 参数的 `glob` 字段是这种两阶段模式的内置优化：遍历收集所有文件后，先按 glob 过滤，再对剩余文件做内容匹配。

## 结果排序

```typescript
const matches = files
  .filter((file) => matcher.test(path.relative(root, file)))
  .sort((left, right) => left.localeCompare(right))
  .slice(0, limit);
```

结果按字母序排序后取前 `limit` 条。排序是**确定性的**——同一文件系统状态下，相同 pattern 的查询总是返回相同顺序的结果。这对缓存友好。

## 遍历限制

glob 使用与 grep 相同的 `walk` 函数，默认收集上限为 100,000 个文件（硬编码）。与 grep 的 `limit × 200` 不同，glob 的 walk limit 是固定的——因为 glob 不需要预留"每个文件搜索 buffer"的成本。

## 与上下文缓存的关系

glob 输出是纯文件路径列表（每行一个相对路径），结构固定，token 开销小。对于频繁执行的 glob（如 `glob({pattern: '*.ts'})` 在稳定仓库中），结果可能命中缓存。

实际中 glob 的缓存价值有限——模型很少在同一个会话中重复执行相同路径的 glob。更有价值的缓存场景是下游的 read：glob 列出文件后，模型 read 了其中几个，这些 read 形成了可缓存的 prefix。
