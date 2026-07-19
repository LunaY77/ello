---
title: 'bash — Shell 命令执行工具设计'
description: '深度解析 ello bash 工具：命令执行超时与资源边界、审批策略中的风险分析、输出截断与持久化、以及 Shell 环境隔离设计。'
keywords: ['bash', 'shell', '命令执行', '审批', '风险分析', '超时控制']
---

## 设计目标

`bash` 是 ello 与操作系统交互的唯一入口，负责执行用户工作区内的 shell 命令。

核心约束：

1. **安全隔离** — 通过审批系统限制命令范围，高危命令需要明确批准。
2. **资源边界** — 超时、cwd、输出截断，每一项都有硬上限，防止失控进程消耗资源。
3. **输出可控** — stdout/stderr 合并输出，超出预算部分截断并标注。

## 工具定义

源码路径：`src/agent/tools/shell.ts`

```typescript
defineCodingTool({
  name: 'bash',
  description:
    'Run a shell command in the workspace with timeout and captured stdout/stderr.',
  discovery: { aliases: ['shell', 'terminal', 'command'], risk: 'external' },
  input: z
    .object({
      command: z.string().min(1),
      timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
      cwd: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict(),
});
```

### 参数设计

| 参数        | 类型      | 默认值       | 说明                                    |
| ----------- | --------- | ------------ | --------------------------------------- |
| `command`   | `string`  | —            | Shell 命令（必填）                      |
| `timeoutMs` | `number`  | `30_000`     | 超时毫秒数，范围 1000–120,000（2 分钟） |
| `cwd`       | `string?` | 工作区根目录 | 命令执行的工作目录                      |
| `reason`    | `string?` | —            | 执行原因，展示在审批界面                |

**超时 120 秒硬上限**：任何超过 2 分钟的命令不被允许。这防止模型启动长时间运行的服务或陷入死循环。需要长期运行的进程（如 dev server）应通过外部方式管理，而非 ello 的 bash 工具。

## 执行链路

```
模型调用 bash({command, timeoutMs, cwd?})
  ↓
requireShell(ctx.agent)         → 取出环境的 Shell 能力
                                → 缺省抛错: "Environment has no shell"
  ↓
shell.run(command, {            → 委托给 AgentShell 实现
  timeout: timeoutMs,
  cwd: workingDirectory,
})
  ↓
合并 stdout + stderr
  ↓
truncate(output)                → 12,000 字符上限
  ↓
createCodingToolResult(
  title: "bash {command}",
  output, metadata: { exitCode, durationMs, stdoutBytes, stderrBytes }
)
```

## 风险分析

```typescript
function analyzeCommandRisk(command: string): 'normal' | 'dangerous' {
  return /\b(rm\s+-rf|sudo|chmod\s+-R|chown\s+-R|mkfs|dd\s+if=)/u.test(command)
    ? 'dangerous'
    : 'normal';
}
```

对已知高危模式做关键词匹配：

| 模式       | 含义           |
| ---------- | -------------- |
| `rm -rf`   | 递归强制删除   |
| `sudo`     | 提权操作       |
| `chmod -R` | 递归修改权限   |
| `chown -R` | 递归修改所有者 |
| `mkfs`     | 格式化文件系统 |
| `dd if=`   | 裸设备写入     |

危险标记使审批 UI 可以高亮警告，但不自动拒绝——决定权在用户。审批策略声明 `risk: 'external'`，表示即使宽松权限模式下也不会自动放行。

## 审批策略

```typescript
approval: async (input, ctx) =>
  decide({
    permission: 'bash',
    patterns: [input.command],
    always: [input.command],
    paths: [input.cwd ?? config.cwd],
    metadata: shellMetadata(input, config),
  }, ctx.agent),
```

`permission: 'bash'` 是 shell 专用权限类别，与文件操作 (`read` / `edit`) 分开。用户可以为命令执行设置单独的策略。

`paths` 使用 `cwd` 值，确保工作目录在 `allowedPaths` 范围内。

## 输出处理

```typescript
const output = [
  result.stdout.length > 0 ? result.stdout : '',
  result.stderr.length > 0 ? `stderr:\n${result.stderr}` : '',
]
  .filter(Boolean)
  .join('\n');
```

stdout 在前，stderr 在后（带 `stderr:` 前缀）。exitCode 非零不自动视为错误——很多有用的命令退出码非零（如 `grep` 找不到匹配时返回 1，`diff` 发现差异时返回 1）。

**模型的责任**：模型应读取 `exitCode` 和 stderr 内容自行判断命令是否"成功"。ello 不替模型判断——exitCode 只在 metadata 中记录，不作为 Error 抛出。

## 与上下文缓存的关系

bash 的输出可能很大（如 `cat large.log`、`npm install` 的完整输出）。截断至 12,000 字符后仍可能占据可观上下文预算。

**关键约束**：bash 输出是不可缓存的动态内容——每次执行的输出几乎必定不同。但如果模型重复执行完全相同的命令（如 `ls src/`），相同输出会形成 prefix match，prompt cache 可以复用。

**模型行为引导**：bash 输出在 metadata 中标记了 `truncated`（若超出 12,000 字符），模型可根据此标记判断是否需要 `grep` 或 `read` 进一步分析输出文件。
