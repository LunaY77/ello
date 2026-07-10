import type { AgentRunContext, SystemSection } from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';

/**
 * 文件型记忆通过 system section 注入。
 *
 * 框架本身不设记忆专用槽：记忆要做的两件事与现成扩展点完全重合——「检索」就是
 * 注入一段系统文本（{@link SystemSection}），「观察」就是生命周期回调
 * （{@link AgentObserver}）。所以记忆在产品层用这两样拼出来即可。
 *
 * - `section`：每轮把项目/用户记忆文件渲染成一段系统文本注入；带 once-per-run
 *   缓存（按 runId），避免一个 run 内多个 turn 重复读盘。
 * 同一个 run 的上下文对象作为 WeakMap key，保证多个 turn 只读盘一次且不会积累
 * 已结束运行的数据。
 */
export function createCodingMemory(config: CodingAgentConfig): SystemSection {
  if (!config.context.memory.enabled) {
    return () => null;
  }

  const cache = new WeakMap<AgentRunContext, string>();

  return async (run) => {
    let text = cache.get(run);
    if (text === undefined) {
      const manifest = await loadCodingMemory(config.cwd);
      const rendered = renderMemoryForPrompt(manifest, config.cwd).trim();
      text = rendered
        ? `<memory-context>\n# Relevant memory\n${rendered}\n</memory-context>`
        : '';
      cache.set(run, text);
    }
    return text || null;
  };
}
