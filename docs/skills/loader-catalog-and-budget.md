# Skill 加载、目录与预算

## 文件契约

每个 Skill 是一个目录，目录名必须与 frontmatter `name` 相同，正文文件固定为 `SKILL.md`：

```yaml
---
name: zh-technical-writing
description: 中文技术文档写作规范。
---
正文指令……
```

`name` 必须匹配 kebab-case，description 长度为 1 到 1024 字节，正文不能为空且不超过 64 KiB。`parseSkillMarkdown()` 会先归一化 CRLF，再解析 YAML；任何错误都包装成包含 skill path 的异常。

## symlink 校验不是装饰

加载器对目录项执行 `realpath()` 和 `stat()`：

```ts
canonical = await realpath(linkPath);
if (!(await stat(canonical)).isDirectory()) {
  throw new Error('target is not a directory');
}
```

同一真实目录如果通过两个 linkPath 出现，加载器拒绝启动。否则同一个 Skill 会依遍历顺序覆盖自己，搜索结果和激活来源会不稳定。`baseDir` 保留用户看到的 link path，`realPath` 用于诊断和去重。

## Global 与 Project 合并

`buildCatalog()` 先加载 `~/.ello/skills`，再加载 `<cwd>/.ello/skills`，按 name 写入 Map，后者覆盖前者，最后按名称排序。项目目录不存在表示没有覆盖项；global 目录由初始化流程创建，读取失败会中止加载。

```mermaid
flowchart LR
  Global[global skill] --> Map[Map name -> AgentSkill]
  Project[project skill] --> Map
  Map --> Sorted[按 name 排序]
  Sorted --> Snapshot[Object.freeze(snapshot)]
```

每个条目保存原文的 SHA-256 `contentHash`。正文改变后，新的 snapshot 会得到新 hash，旧 run 的激活记录仍指向旧 hash。

## 搜索和索引预算

`SkillSearchIndex` 使用 `WeightedSearchIndex`：name 权重 8，description 权重 3，source 权重 1，单次最多返回 8 条。TUI 的 `skills/list?query=` 和激活失败时的相似名称建议都用这个索引。

系统提示中的 `skillIndexContext()` 按模型 context window 的 1% 计算预算，最低 400 字符：

```ts
const budget = Math.max(400, Math.floor((contextWindow ?? 160_000) * 4 * 0.01));
```

超出预算的条目只保留 `- name`，不把完整 description 塞进 system prompt。索引还写入四条固定约束：使用 `activate_skill`、`$name` 是显式请求、不要直接读 `SKILL.md`、同一 user message 后不要重复激活。
