---
title: 'tool_search / call_tool — 工具路由与上下文缓存设计'
description: 'tool_search 按需发现工具（倒排索引、BM25 加权、三级匹配），动态注入工具对 Prompt Cache 的破坏，以及 call_tool 代理执行如何保持工具数组不变——完整的设计链路与取舍分析。'
keywords:
  [
    'tool_search',
    'call_tool',
    '工具路由',
    'BM25',
    '倒排索引',
    'Prompt Cache',
    '上下文缓存',
    '前缀缓存',
  ]
---

## 问题：工具的持续膨胀

ello 目前的工具规模：4 个文件工具（read / write / edit / apply_patch）、1 个 shell 工具（bash）、2 个搜索工具（grep / glob）、7 个 task 管理工具、5 个 memory 工具。加上未来 MCP server 引入的外部工具，总量可能达到几十个。

将所有这些工具的 name、description 和 Zod schema 序列化而成的 JSON Schema 一次性放入 prompt，会引发三个相互放大的问题：

### Token 爆炸

每个工具的 JSON Schema 平均 200–500 字符。20 个工具意味着 **4,000–10,000 字符（1,000–2,500 token）的常量开销**被塞进每轮对话。这是无论模型是否需要使用某个工具都必须付出的固定成本。

更关键的是，这不仅是 token 开销，还有**缓存开销**。大多数 LLM API 的 prompt cache 按 prefix 匹配计算，将 2,500 token 的工具定义放在 system prompt 的稳定区域中，意味着每次 API 调用都需要为这部分"可能根本用不到"的内容支付缓存写入成本。

### 注意力稀释

过多的工具定义干扰模型的选择准确性。当 20+ 个工具同时可见时，模型需要在注意力机制中为每个工具分配权重。语义相近的工具——如 `task_get` 和 `memory_read`——可能被混淆。工具越多，选择出错的概率越高。

### 缓存碎片化

缓存碎片化是三者中最隐蔽的问题。ello 的 system prompt 由稳定前缀（stable prefix）和动态后缀组成。工具列表必须在稳定前缀中——模型在第一个 turn 就需要知道有哪些工具可用。

但工具列表是**条件性的**：用户的配置可能禁用了某些工具（`config.tools.disabled`）、不同的 workspace 可能连接了不同的 MCP server。后果：

- 用户 A 和用户 B 的工具列表不同 → stable prefix 不同 → **跨用户的全局缓存失效**。
- 同一个用户连接新的 MCP server → 工具列表变化 → stable prefix 变化 → **与之前对话的缓存无法复用**。

每个用户、每个项目的 stable prefix 都是独特的，prompt cache 的全局复用率趋近于零。

## 第一步：tool_search — 按需发现工具

解决上述问题的第一个想法很直接：**不要一次发送全部工具定义，让模型在需要时自己搜索**。

### 核心思路

模型可见的工具列表中只保留 `tool_search` 本身。模型不知道有什么工具可用，但它知道可以搜索。当它需要做某件事时，先用 `tool_search` 找到对应的工具和 schema，再决定如何调用。

这就需要一个搜索引擎——不是一个简单的 `tools.filter(t => t.name.includes(query))`，而是一个能理解"我想读文件"应该匹配 `read` 而非 `task_read` 的语义搜索系统。

### 索引构建

源码路径：`src/agent/tools/search-index.ts`——`buildDocuments()`

每个工具被索引为五个加权字段：

```typescript
const FIELD_WEIGHTS = {
  name: 8, // 工具名：最重要，"read" 这个词本身应精确命中
  aliases: 5, // 别名：如 read 有 "file", "directory", "cat"
  description: 3, // 自然语言描述：模型用自然语言搜索时的主要匹配源
  schema: 2, // input schema 的属性名和描述：帮助语义补全
  risk: 1, // 风险级别：权重最低，仅辅助细化
} as const;
```

**为什么别名权重比描述高？** 别名是精确设计的入口词。比如 `glob` 的别名 `"find files"` 是一个精心挑选的短语——用户大概率会搜索它。自然语言描述是长文本，token 匹配的精确度天然低于短别名。

**为什么 schema 权重低？** schema 中的属性名（如 `path`、`pattern`）过于通用，如果把 schema 权重调高，搜索 `"path"` 会匹配到几乎所有工具（因为大部分工具都有 `path` 参数），搜索结果失去区分度。

### 分词与归一化

源码路径：`src/agent/tools/weighted-search-index.ts`——`tokenize()`

```typescript
function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function tokenize(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}
```

分词使用 Unicode 字母和数字作为 token 边界（`\p{L}` 和 `\p{N}` 的 Unicode property escape），而非简单的 `\w+`。效果：

- 中文、日文、韩文等非 ASCII 文字被正确分词。
- CamelCase 工具名：`apply_patch` 被拆分为 `["apply", "patch"]`——因为 `_` 不是字母也不是数字。
- MCP 工具名：`mcp__slack__send_message` 被拆分为 `["mcp", "slack", "send", "message"]`。

**NFKC 归一化**确保全角/半角、连字等 Unicode 等价形式被统一，避免 `"ｒｅａｄ"`（全角）和 `"read"` 被当作不同 token。

### 倒排索引

源码路径：`src/agent/tools/weighted-search-index.ts`——`WeightedSearchIndex` 构造函数

```typescript
// 为每个 token 建立文档列表
for (const [index, document] of documents.entries()) {
  const terms = new Set<string>();
  for (const field of document.fields) {
    for (const token of field.tokens) {
      terms.add(token);
      const ids = this.inverted.get(token) ?? new Set<number>();
      ids.add(index);
      this.inverted.set(token, ids);
    }
  }
}
```

倒排索引是简单但关键的性能决策：工具索引只需要在 `createMetaToolRuntime` 时构建一次（每次 run 一次），且工具数量在几十个量级，O(N × K) 的构建复杂度和 O(1) 的查询复杂度完全够用。不需要引入持久化存储或增量更新——重建成本在毫秒级别。

同时为每个 token 计算**文档频率**（`documentFrequency`）和每个字段的**平均字段长度**（`averageFieldLength`），这两个统计量是 BM25 评分的基础。

### 三级匹配策略

源码路径：`src/agent/tools/weighted-search-index.ts`——`matchTerms()`

对于查询中的每个 token，搜索引擎尝试三种匹配：

| 级别       | 条件                                                 | 倍率 | 含义                                      |
| ---------- | ---------------------------------------------------- | ---- | ----------------------------------------- |
| **Exact**  | 查询 token 在索引中完全命中                          | 3.0× | "read" 匹配 "read"：最高置信度            |
| **Prefix** | 查询 token 是索引 term 的前缀，且查询 token 长度 ≥ 2 | 1.5× | "tas" 匹配 "task"：输入不完整而非精确指定 |
| **Fuzzy**  | 编辑距离在允许范围内                                 | 0.7× | "wriet" 匹配 "write"：可能是拼写错误      |

**Prefix 的长度限制（≥ 2）**很重要：单字符前缀如 `"r"` 会匹配 `"read"`、`"write"`（通过 schema 中的 `"reason"` 属性）、`"grep"` 等大量无关工具，噪声远大于信号。

**Fuzzy 的编辑距离阈值**随查询 token 长度动态调整：

```typescript
const maxDistance =
  queryToken.length >= 10 ? 2 : queryToken.length >= 4 ? 1 : 0;
```

- 短词（< 4 字符）：不做模糊匹配。`"cat"` 和 `"cut"` 虽然只差一个字符，但在工具搜索语境中它们代表完全不同的语义，模糊匹配只会引入噪声。
- 中词（4–9 字符）：允许 1 个编辑距离。`"wriet"` → `"write"`，这是典型的打字错误。
- 长词（≥ 10 字符）：允许 2 个编辑距离。长工具名或 MCP 工具完整名（如 `mcp__slack__send_message`）更容易出现多个字符偏差。

**Bounded Levenshtein**：模糊匹配使用带上限的编辑距离算法——一旦当前行的最小编辑距离已经超过 maxDistance，立即返回 `maxDistance + 1` 提前终止。这避免了对长字符串做完整的 O(n²) 计算。

### BM25 评分

源码路径：`src/agent/tools/weighted-search-index.ts`——`score()`

每对 `(查询 token, 匹配 term, 文档, 字段)` 的评分公式：

```
idf = log(1 + (N - df + 0.5) / (df + 0.5))

norm = tf + 1.2 × (0.25 + 0.75 × fieldLength / avgFieldLength)

score += fieldWeight × matchMultiplier × idf × (tf × 2.2 / norm + 0.5)
```

逐项解释：

- **IDF（逆文档频率）**：如果一个 token 出现在几乎所有工具中（如 "file"），它的区分能力极低。`idf` 对数压缩了 `N/df`，使高频词的评分权重自然下降。
- **归一化项（norm）**：考虑字段长度的影响。`description` 字段可能很长（50+ token），而 `name` 字段通常只有 1–2 个 token。长字段中 token 出现一次不应被过度惩罚——`1.2` 和 `0.75` 是 BM25 的标准参数，调节了长度归一化的强度。
- **tf × 2.2**：`2.2` 是饱和参数——同一 token 在同字段中出现 3 次和 30 次的评分差异远小于 1 次和 3 次的差异。这防止某个工具的描述中反复出现某个词而导致虚高评分。
- **fieldWeight × matchMultiplier**：字段权重（name 8× > aliases 5× > description 3×）和匹配倍率（exact 3× > prefix 1.5× > fuzzy 0.7×）是乘法关系。

### 覆盖衰减（Coverage Decay）

评分完成后还有一个关键的二次调整：

```typescript
finalScore = score × (coveredQueryTokens / totalQueryTokens);
```

如果查询有 3 个 token（如 `"search file content"`），但某个文档只命中了其中 1 个（如只命中了 `"file"`），其最终得分会乘以 1/3。

**为什么需要覆盖衰减？** BM25 将每个查询 token 的得分独立求和。如果不做衰减，一个 30 分的单 token 匹配可能排在 25 分的三 token 全匹配前面。但 "search file content" 三个词全部命中 `grep`（description 中有 "search"、alias 中有 "find content"）的语义相关性，远超只命中了一个 `"file"` 词的结果。

覆盖衰减确保**查询越精确，结果越精准**——多 token 查询天然得到更强的信号放大，单 token 查询则在覆盖衰减等于 1 时不受影响。

### 两种调用模式

`tool_search` 根据 `query` 参数区分为两种模式：

| 模式                  | 触发                 | 返回内容                              | 支持分页 |
| --------------------- | -------------------- | ------------------------------------- | :------: |
| **Inventory（清单）** | `query` 未提供       | 工具名 + 描述（不含 input schema）    |    是    |
| **Search（搜索）**    | 提供有意义的 `query` | 工具名 + 描述 + **完整 input schema** |    否    |

```typescript
execute: ({ query, limit, offset = 0 }) => {
  const inventory = query === undefined || isInventoryQuery(query);
  if (!inventory && offset !== 0) {
    throw new Error('tool_search offset is only valid for inventory mode.');
  }
  const results = inventory
    ? options.index.list(limit, offset)
    : options.index.search(query, limit);
  // ...
};
```

**Inventory 模式**让模型先纵览"有哪些工具"，获得工具名和一句话描述。它支持 `offset` 分页——如果工具超过 `limit`，`truncated: true` + `nextOffset` 提示模型继续翻页。

**Search 模式**返回完整 input schema。模型用自然语言搜索找到目标工具后，直接获得该工具的入参结构（JSON Schema），无需再发第二次请求。

两种模式的分离还有一个隐式收益：Inventory 的结果不含 schema（文本量小、结构固定），对上下文缓存友好——同一个 session 中模型可能多次翻页浏览工具列表，每次翻页的结果有相同的 prefix，可以命中缓存。

## 第二步：上下文缓存的困境——动态注入的问题

tool_search 解决了"不需要时不给模型看 schema"的问题。但一个自然的后续想法出现了：

```
模型搜索工具 → tool_search 返回 read 的 schema →
系统把 read 添加到模型的工具定义数组中 →
模型直接调用 read({path: "src/foo.ts"})
```

这种做法会把工具动态注册进 system prompt，同时破坏上下文缓存的稳定前缀。

### System Prompt 的缓存结构

ello 的 system prompt 分为两部分（源码：`src/agent/context/cache-layout.ts`）：

```
┌──────────────────────────┐
│  Stable Prefix           │  ← scope: 'global'
│  ├─ 核心行为规则           │    跨所有用户/组织缓存
│  ├─ 工具定义数组           │    （包括每个工具的 name + description + inputSchema）
│  ├─ 指令格式说明           │
│  └─ 输出规范              │
├──────────────────────────┤
│  <cache-dynamic>         │  ← 分界标记
│  Dynamic Suffix          │  ← scope: 'org' 或无缓存
│  ├─ 环境信息              │    因会话而异
│  ├─ 用户记忆              │
│  └─ 项目特定指令           │
└──────────────────────────┘
```

工具定义数组**必须在 Stable Prefix 中**。原因是 LLM 需要在第一个 turn 就知道所有可用的工具——它不能在中途突然发现一个之前不存在的工具。API 协议要求工具列表在每次请求中完整发送。

### 动态注入的缓存破坏

假设在某个 turn，模型通过 `tool_search` 找到了 `read`，系统动态把 `read` 注入到工具数组中。下一次 API 请求的 system prompt 变为：

```
┌──────────────────────────┐
│  Stable Prefix           │
│  ├─ 核心行为规则           │  ← 这部分没变
│  ├─ tool_search           │  ← 这部分没变
│  ├─ call_tool             │  ← 这部分没变
│  ├─ read  ← NEW!          │  ← 这里变了！
│  └─ 输出规范              │  ← 后面的全部偏移
└──────────────────────────┘
```

变化点：`read` 被插入到工具数组中。后果：

1. **前缀缓存全量失效** — 从 `read` 的插入点开始，后续所有字节的 hash 都变了。即使前面的规则文本完全没变，cache 也无法命中。
2. **累积效应** — 模型每次搜索并动态注入一个新工具，Stable Prefix 就变化一次。一个 session 中使用 5 个不同工具，Stable Prefix 就变化 5 次，产生 5 个不同的缓存 key。
3. **跨 session 不可复用** — session A 中模型搜索并注入了 `read`、`grep`、`bash`；session B 中模型搜索并注入了 `write`、`glob`、`bash`。两个 session 的 Stable Prefix 不同，无法共享缓存。

**本质问题**：Stable Prefix 被要求是 stable 的——它应该对所有用户、所有 session 完全一致。但动态注入工具破坏了这种稳定性——Stable Prefix 的内容取决于模型在本次 session 中的搜索行为，而搜索行为是不可预测的。

### 具体量化

假设工具的 JSON Schema 平均 300 字符。每次动态注入一个工具：

- Stable Prefix 长度 +300 字符。
- Prefix cache 命中窗口向后偏移 300 字符。
- 所有在注入点之后的 content（对话历史、工具结果）的缓存 hash 全部变化。

如果模型在一个 session 中使用了 8 个工具，Stable Prefix 变化了 8 次，产生了 8 个不同的缓存断点。每次断点意味着**前一轮对话的缓存完全无法被下一轮复用**，API 需要重新计算整个 prompt prefix 的缓存。

## 第三步：call_tool — 稳定工具数组的代理执行

动态注入的问题揭示了一个核心约束：**模型可见的工具定义数组必须在整个 session、乃至跨 session 之间保持绝对不变**。

解决方式是将工具数组固定为两个工具：

```
模型可见的工具数组: [tool_search, call_tool]
```

`read`、`write`、`bash` 等执行工具**不出现在模型可见的工具数组中**。模型通过 `tool_search` 发现工具的 name 和 schema，通过 `call_tool` 代理执行——`call_tool` 接收 `{name: "read", arguments: {...}}`，在内部查找真正的工具实现并委托执行。

### 两组工具集合

源码路径：`src/agent/tools/meta-tools.ts`——`createMetaToolRuntime()`

```typescript
return {
  executionTools: [...targetTools, toolSearch, callTool, ...directTools],
  modelTools: [toolSearch, callTool, ...directTools],
  usesToolRouting: true,
};
```

这是两个**不同的集合**，用在不同阶段：

| 集合             | 用途                 | 内容                                          |
| ---------------- | -------------------- | --------------------------------------------- |
| `modelTools`     | 发送给模型的工具列表 | `tool_search` + `call_tool` + direct tools    |
| `executionTools` | 运行时可执行的工具表 | 全部 target tools + meta tools + direct tools |

`modelTools` 是常量——与有多少 target tools、哪些被启用/禁用完全无关。`executionTools` 包含所有目标工具，供 `call_tool` 在运行时按名查找。

**关键不变量**：`modelTools` 对所有用户、所有项目、所有 session 完全相同。Stable Prefix 获得真正的全局缓存（`scope: 'global'`）。

### call_tool 的执行链

源码路径：`src/agent/tools/meta-tools.ts`——`createCallTool()`

```typescript
const targets = new Map<string, AgentTool<unknown, unknown>>();
for (const tool of targetTools) {
  if (tool.execution !== 'immediate') {
    throw new Error(`call_tool target cannot be deferred: ${tool.name}`);
  }
  targets.set(tool.name, tool);
}
```

**`targets` 表在 `createMetaToolRuntime` 时构建一次，之后不变。** 不按名称做运行时猜测、补全或动态查找——如果 `call_tool` 收到一个不在 `targets` 中的名称，直接报错并返回完整可用工具列表。

```
模型调用 call_tool({name: "read", arguments: {path: "src/foo.ts"}})
  ↓
resolveTargetCall(input):
  ├─ META_TOOL_NAMES.has(input.name)? → 拒绝递归
  ├─ targets.get(input.name) === undefined? → 报错 + 列出可用工具名
  ├─ target.input.parse(input.arguments) → Zod schema 校验 → 失败则报具体 issue
  └─ 返回 {target, input: 类型化参数}
  ↓
审批委托:
  target.approval?.(resolved.input, context)
  → 决策 metadata 追加 proxiedTool 字段
  ↓
执行委托:
  target.execute(resolved.input, context)
  → 结果原样返回
```

### 审批代理的正确性

当模型通过 `call_tool` 调用 `read` 时，审批系统看到的是 `call_tool` 的调用，但权限规则应该匹配 `read` 的权限策略——用户批准的是"读取文件"，而不是"调用 call_tool"。

```typescript
function proxyApprovalDecision(targetName, decision): AgentApprovalDecision {
  return {
    ...decision,
    metadata: { ...(decision.metadata ?? {}), proxiedTool: targetName },
  };
}
```

`proxiedTool` 字段存储实际工具名。当用户批准后，持久化的权限规则（如 `allow: ["read"]`）可以正确匹配后续的 `read` 调用——即使是再次通过 `call_tool` 发起的。

### 错误纠正

`call_tool` 对两种常见错误做了明确的纠正信息：

```typescript
// 目标工具不存在
throw new Error(
  `Unknown or disabled target tool: ${input.name}. ` +
    `Available targets: ${[...targets.keys()].join(', ')}`,
);

// arguments 不符合 schema
throw new Error(`Invalid arguments for tool '${input.name}': ${issues}`);
```

模型收到这些信息后可以立即修正——重新 `tool_search` 确认工具名，或调整 arguments 结构。这利用了 LLM 的自我纠正能力，而非在 `call_tool` 内部做容错。

## 完整的上下文缓存分析

现在可以从全局视角审视整个设计的缓存行为。

### 路由模式下的缓存布局

```
┌──────────────────────────────────────────┐
│  Stable Prefix                           │  ← scope: 'global'
│  ├─ 核心行为规则                           │
│  ├─ tool_search (name + desc + schema)   │  ← 对所有用户完全相同
│  ├─ call_tool   (name + desc + schema)   │  ← 对所有用户完全相同
│  └─ 输出规范                               │
├──────────────────────────────────────────┤
│  Dynamic Suffix                           │  ← scope: 'org'
│  ├─ Tool Routing Instructions             │  ← 告知模型使用 search → call 模式
│  ├─ 环境信息 / 记忆 / 项目指令              │
│  └─ ...                                   │
├──────────────────────────────────────────┤
│  Messages                                 │  ← message-level cache
│  ├─ User: "帮我读一下 src/foo.ts"         │
│  ├─ Assistant: tool_search({query: "read file"})
│  ├─ Tool Result: {name: "read", schema: {...}}
│  ├─ Assistant: call_tool({name: "read", args: {...}})
│  ├─ Tool Result: (文件内容)                │
│  └─ ...                                   │
└──────────────────────────────────────────┘
```

### 缓存命中的场景

**Stable Prefix 全局命中** — 所有用户、所有项目的每次 API 调用，Stable Prefix 完全相同。API 提供商可以将这一段缓存为 `scope: 'global'`，在跨组织之间复用。

**Tool Search 结果缓存** — 同一 session 中，模型可能多次调用 `tool_search` 搜索同一个工具。第二次搜索的 prompt prefix（到上次搜索结果之前的内容）完全相同 → prefix cache 命中。

**call_tool 前缀缓存** — 连续调用多个工具时，`call_tool` 的 `tool_use` 部分只有 2 个字段（`name` + `arguments`），且结构固定。前缀（到上一条 tool result 结束为止）可以缓存。

### 缓存失效的场景

**用户配置变化** — 启用/禁用工具影响的是 `executionTools`（运行时工具表），不影响 `modelTools`（模型可见集合）。因此 **Stable Prefix 不受影响**，缓存仍然有效。只有 `tool_search` 的搜索结果可能变化（少一个工具），但这仅影响对话历史中的某条 tool result 及其之后的内容。

**MCP server 连接** — 新工具被加入 `executionTools`，`modelTools` 依然不变。Stable Prefix 缓存完全保留。

工具集的变化（增减、启用/禁用、MCP 连接/断开）**只改变对话历史中的 `tool_search` 结果**，不改变 system prompt 中的工具定义数组。Stable Prefix 保持稳定。

### 缓存的代价

稳定数组不是零成本的：

| 代价                           | 解释                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **额外 round trip**            | 模型需要先 `tool_search` 再 `call_tool`，某些场景下多一次 API 调用（约 1–2 秒延迟）。但模型可以在同一条 assistant message 中批处理 search + call。 |
| **路由指令开销**               | `TOOL_ROUTING_INSTRUCTIONS` 约 400 字，注入到 dynamic suffix 中。它在 org 级别缓存，是固定成本。                                                   |
| **call_tool 不能并行未知工具** | 模型不知道工具能否并行，因为它没有 schema。但这正是设计的意图——避免模型在 batch 中同时发 `call_tool` 和 `tool_search`。                            |

总的来说，路由模式的取舍是：

**付出**：一个额外的 search round trip（首次使用某个工具时），一段固定的路由指令文本。

**获得**：Stable Prefix 的全局缓存、工具数组永远不变、工具集变化不影响缓存结构、模型注意力集中在少数 meta 工具上。

对于 ello 这样一个工具数量必然持续增长的 agent 系统而言，这是一笔清晰的净收益交易。
