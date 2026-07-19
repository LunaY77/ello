# Prompt 模块

Prompt 模块把 Agent 定义、运行环境、指令文件、Memory index、Skill index、Goal 和 Provider cache 组织成一次模型调用的 system 输入。

模块文章：

- [系统提示装配](system-prompt-assembly.md)
- [上下文来源与快照](context-sources-and-snapshot.md)
- [Provider Prompt Cache](provider-cache-layout.md)

主要源码位于 `packages/ello-agent/src/agent/context`、`agent/engine/core/model-input.ts` 和 `agent/providers/catalog/transforms.ts`。
