import type { AgentObserver, SystemSection } from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';

/**
 * 记忆 = section（注入）+ observer（回写）。
 *
 * 框架本身不设记忆专用槽：记忆要做的两件事与现成扩展点完全重合——「检索」就是
 * 注入一段系统文本（{@link SystemSection}），「观察」就是生命周期回调
 * （{@link AgentObserver}）。所以记忆在产品层用这两样拼出来即可。
 *
 * - `section`：每轮把项目/用户记忆文件渲染成一段系统文本注入；带 once-per-run
 *   缓存（按 runId），避免一个 run 内多个 turn 重复读盘。
 * - `observer`：run 结束/失败时清掉该 run 的缓存条目，防止 Map 无限增长。
 *   （v1 暂不做“自动学习并回写记忆”，留作后续；写回入口就在这里。）
 *
 * 典型装配方式：
 * ```ts
 * const memory = createCodingMemory(config);
 * createAgent({
 *   observers: [memory.observer, ...],
 *   modelInput: { systemSections: [...buildSystemSections(config, deps), memory.section] },
 * });
 * ```
 */
export function createCodingMemory(config: CodingAgentConfig): {
  section: SystemSection;
  observer: AgentObserver;
} {
  /** once-per-run 缓存：key = runId，value = 已渲染的记忆文本（空串表示无记忆）。 */
  const cache = new Map<string, string>();

  const section: SystemSection = async (run) => {
    let text = cache.get(run.runId);
    if (text === undefined) {
      const manifest = await loadCodingMemory(config.cwd);
      const rendered = renderMemoryForPrompt(manifest, config.cwd).trim();
      text = rendered ? `# Relevant memory\n${rendered}` : '';
      cache.set(run.runId, text);
    }
    return text || null;
  };

  const observer: AgentObserver = {
    onRunCompleted: (_result, ctx) => {
      cache.delete(ctx.runId);
    },
    onRunFailed: (_event, ctx) => {
      cache.delete(ctx.runId);
    },
  };

  return { section, observer };
}
