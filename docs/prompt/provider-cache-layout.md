# Provider Prompt Cache

## 为什么区分稳定前缀和动态后缀

Provider cache 依赖长前缀复用。Goal、工具路由状态等高变化内容如果插在稳定规则中间，后面的 system 内容也会失去缓存。

ello 用 `<cache-dynamic>` 标记动态段。解析器要求所有稳定文本位于第一个动态块之前，动态块之后不能再出现稳定文本。

```text
stable system prefix

<cache-dynamic>
active goal
</cache-dynamic>

<cache-dynamic>
tool routing state
</cache-dynamic>
```

`splitSystemCacheSegments()` 遇到“动态块后又有稳定文本”会直接抛错。它不自动重排段落，因为重排可能改变 Prompt 语义。

## OpenAI cache key

OpenAI 和 openai-compatible 模型获得 `providerOptions.openai.promptCacheKey`。key 由以下值做 SHA-256：

```text
provider id
model id
prompt profile
cwd identity
toolset fingerprint
hash(stable system)
```

消息历史和动态 system 不进入 key。稳定规则或工具 schema 变化会生成新 key；会话增长、Goal 文本变化不会改变 key。

key 不包含 API key、用户 prompt 或工具输出。它是缓存命名空间，不是输入内容 hash。

## Anthropic cache breakpoint

Anthropic transform 把稳定 system 转成第一条 system message，并写 1 小时 ephemeral cache control。动态 system 作为第二条普通 system message。会话最后一条消息获得 5 分钟 cache control。

```ts
{
  role: 'system',
  content: cacheSegments.stable,
  providerOptions: {
    anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
  },
}
```

稳定规则使用较长 TTL，会话前沿使用短 TTL。长工具执行后，基础规则仍有较高概率命中；频繁推进的对话不长期占用 cache。

若调用方已给最后一条消息设置 Anthropic cacheControl，ello 会拒绝。缓存策略由 product transform 统一拥有，避免两个层级写入冲突字段。

## Capability transform 与缓存顺序

Provider transform 先把模型不支持的 image、audio、PDF part 替换成文本占位，再处理 cache。模型实际收到的消息和 fingerprint 会在 prepare 后重新计算。

当前 `composeAgent()` 的 Skill index没有使用 dynamic wrapper。它在 Agent 创建期间固定，属于稳定 system。Goal 和 tool routing 使用 dynamic wrapper。Memory index与 instruction snapshot也属于当前 run 的稳定段；Memory 变化会改变稳定 system hash和 OpenAI cache key。
