# @ello/agent

`@ello/agent` 是 ello 的框架层 Agent SDK。它只负责一件事: 把一次 agent run 跑清楚。

它提供的核心能力很少:

- `createAgent`
- `agent.run`
- `agent.stream`
- `defineTool`
- `environment`
- `session`
- `modelInput.systemSections`
- `observers`
- `eventRecorder`
- `modelInput`

它不负责产品层 UI，也不负责把你的业务能力预打包成一堆 presets。

## 快速开始

```ts
import {
  createAgent,
  createLocalShellEnvironment,
  defineTool,
  z,
} from '@ello/agent';

const agent = createAgent({
  model: 'test:model',
  instructions: '你是一个简洁的助手。',
  environment: createLocalShellEnvironment({
    cwd: process.cwd(),
    allowedPaths: [process.cwd()],
  }),
  tools: [
    defineTool({
      name: 'echo',
      description: '返回输入文本',
      input: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    }),
  ],
});

const result = await agent.run('你好');
console.log(result.output);

await agent.close();
```

## 执行模型

一次 run 的基本路径是:

1. 创建 `RunSession`
2. `environment.setup(ctx)`
3. 读取 session，并通过 `modelInput` 组装环境与产品上下文
4. 构建 `ModelInput`
5. 调用模型
6. 执行工具
7. 派发 `observers`
8. 结束 run，关闭 environment

`stream()` 和 `run()` 走的是同一条核心路径。

## Agent

`createAgent(options)` 返回一个 `Agent`，常用方法如下:

- `agent.run(input, options?)`
- `agent.stream(input, options?)`
- `agent.resume(deferred, options?)`
- `agent.close()`

`run()` 会在内部持续消费事件流并返回最终结果。
`stream()` 的调用方必须持续消费 async iterator，再读取 `stream.final`。未消费事件的数量超过 `CreateAgentOptions.stream.maxBufferedEvents`（默认 1024）时，运行以 `AgentStreamBackpressureError` 失败，不会无限增长内存。

`run.completed` 只包含 `runId`、`finishReason` 与 `usage`。完整 `AgentRunResult` 只从 `stream.final` 返回。

## Tool

工具通过 `defineTool()` 定义。

```ts
const readNote = defineTool({
  name: 'read_note',
  description: '读取笔记文件',
  input: z.object({ path: z.string() }),
  execute: async ({ path }, ctx) => {
    return ctx.environment.fileSystem?.readText(path);
  },
});
```

工具执行上下文 `ctx` 里最重要的是:

- `ctx.environment`
- `ctx.runId`
- `ctx.metadata`

## Environment

`environment` 是框架的一等抽象。它负责外部世界能力的注入和生命周期管理。

`AgentEnvironment` 目前包含:

- `fileSystem`
- `shell`
- `resources`
- `setup(ctx)`
- `getContextInstructions(ctx)`
- `close()`

框架提供的最小本地实现是 `createLocalShellEnvironment()`。
`createLocalEnvironment()` 是同一个实现的别名。

### Local environment

```ts
const env = createLocalShellEnvironment({
  cwd: process.cwd(),
  allowedPaths: [process.cwd()],
});

const result = await env.shell?.run('pwd');
```

### Resource registry

`environment.resources` 提供一个轻量资源注册表。

```ts
env.resources?.register('cache', {
  setup: async () => {},
  getContextInstructions: async () => 'Cache is enabled.',
  close: async () => {},
});
```

资源工厂会拿到完整 `environment`，适合做需要依赖文件系统、shell 或其他资源的对象。

## ModelInput

`modelInput` 用来控制一次模型调用时的输入组装。

```ts
const agent = createAgent({
  model: 'test:model',
  modelInput: {
    systemSections: [async () => '额外系统提示。'],
    messageTransforms: [async (messages) => messages.slice(-20)],
    providerOptions: async () => ({
      temperature: 0.2,
    }),
  },
});
```

适合放进这里的内容:

- system prompt 片段
- message trim / compaction
- provider options
- 最后一次 input 微调

## Session

`session` 负责持久化对话历史。

```ts
const agent = createAgent({
  model: 'test:model',
  session: {
    async load(sessionId) {
      return [];
    },
    async append(sessionId, messages) {
      void sessionId;
      void messages;
    },
  },
});
```

## Memory

`@ello/agent` 不内置 memory 内容模型或存储协议。产品层通过现有扩展点组合长期记忆：

- `modelInput.systemSections` 注入本次 run 的记忆索引；
- `tools` 提供检索与 revision-safe mutation；
- `observers` 或产品运行时在 run 完成后排 durable extraction job。

`@ello/coding-agent` 的文件型 memory 就建立在这三个边界上，topic 正文不会默认进入 model context。

## Observers

`observers` 是框架层事件出口。

它适合做:

- 日志
- 指标
- trace
- 调试面板

```ts
const agent = createAgent({
  model: 'test:model',
  observers: [
    {
      onRunStarted: ({ runId }) => console.log('started', runId),
      onRunCompleted: (result) => console.log(result.finishReason),
    },
  ],
});
```

## Event recorder

`eventRecorder` 是产品层持久化出口。core 会把事件交给 recorder，记录范围与批处理策略由产品决定；`flush()` 在 run 收尾时执行。recorder 写入失败会直接使 run 失败。

```ts
const agent = createAgent({
  model: 'test:model',
  eventRecorder: {
    record: async (event, ctx) => {
      if (event.type === 'run.completed') {
        await saveRunSummary(ctx.runId, event);
      }
    },
    flush: async () => flushRunSummaries(),
  },
});
```

## 推荐用法

- 框架层只放通用能力
- 环境能力放进 `environment`
- 业务工具放进 `tools`
- 历史持久化放进 `session`
- 长期记忆在产品层组合 `modelInput.systemSections`、`tools` 与 durable job
- 生命周期观测放进 `observers`
- 产品事件持久化放进 `eventRecorder`
- 输入组装放进 `modelInput`

## 不推荐

- 把产品层工具逻辑塞进 framework
- 把 observability 再包装成第二套入口
- 把 environment 只当成普通工具函数集合
- 在业务代码里直接依赖 `src/internal`

## 目录说明

- `src/core` - agent loop 和内部运行时
- `src/environment` - 本地 environment 实现
- `src/public` - 对外类型与接口
- `src/docs` - 这份文档
