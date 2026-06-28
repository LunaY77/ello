/** 高频流式输出渲染节流参数。 */
export function useRenderBudget() {
  return { maxFps: 20, flushMs: 40 };
}
