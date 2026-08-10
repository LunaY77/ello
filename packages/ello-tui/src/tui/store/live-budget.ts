/**
 * live 区行数预算。
 *
 * Ink 6 在 `lastOutputHeight >= stdout.rows` 时会切换成
 * `clearTerminal + 全部 Static 历史 + 当前帧` 的整屏重绘（见 ink `ink.js` 的
 * `onRender`）。流式输出每帧都触发一次整屏重绘 + 整个会话历史重写，就是 TUI 上
 * 看到的闪屏。
 *
 * 因此 dynamic frame 必须始终矮于终端高度。约束只能落在**内容**上：给 Box 设固定
 * `height` 并不会裁剪，Ink 会把超高的 column 子节点压扁成非连续的行，把 composer
 * 边框和 footer 撕碎。
 *
 * 这里把预算算清楚：dock 用掉多少行是已知量，剩下的才交给 live 区。
 */

/** live 区在还有空间时至少保留的行数，保证 `working Ns` 不会被挤掉。 */
export const MIN_LIVE_ROWS = 3;

/** Agent switcher 最多渲染的 child 行数，超出显示 `… +N more`。 */
export const AGENT_SWITCHER_MAX_TASK_ROWS = 6;

/** BottomDock 固定开销：marginTop 1 + composer 单边框上下 2 + footer 3 行。 */
const DOCK_FIXED_ROWS = 6;

/** overlay 走 `InlineSelect` 的固定窗口，加标题、scrollbar 和边框的上界。 */
export const OVERLAY_MAX_ROWS = 12;

/** 每张运行中 tool card 的行数上界：headline + details + working + marginBottom。 */
export const TOOL_CARD_ROWS = 4;

/** 每个 Command Run 分组的行数上界。 */
export const COMMAND_RUN_ROWS = 6;

/** 每个运行中 subagent 的行数上界：marginTop + 标题 + 4 tool + 状态 + 隐藏计数。 */
export const SUBAGENT_ROWS = 8;

export interface DockRowCost {
  /** Composer 文本占用的视觉行数（至少 1）。 */
  readonly composerRows: number;
  /** Agent switcher 行数；0 表示不渲染。 */
  readonly agentRows: number;
  /** 是否有 overlay 挂在 dock 顶部。 */
  readonly overlayOpen: boolean;
}

/** BottomDock 实际占用的终端行数。 */
export function dockRows(cost: DockRowCost): number {
  return (
    DOCK_FIXED_ROWS +
    Math.max(1, cost.composerRows) +
    cost.agentRows +
    (cost.overlayOpen ? OVERLAY_MAX_ROWS : 0)
  );
}

/**
 * live 区可用行数。
 *
 * 额外扣掉 1 行：Ink 在 `outputHeight >= rows` 时就会整屏重绘，所以目标是
 * `frameHeight <= rows - 1`，而不是 `<= rows`。
 *
 * dock 自己就撑满终端时返回 0。这里不设下限：硬留几行只会把 frame 顶过终端高度，
 * 反而触发整屏重绘。
 */
export function liveViewportRows(
  terminalRows: number,
  cost: DockRowCost,
): number {
  return Math.max(0, terminalRows - dockRows(cost) - 1);
}

/**
 * 终端是否装得下 dock。
 *
 * 装不下时（很矮的终端 + 打开的 overlay + 多个 child）live 区让到 0 行也无解，Ink 会
 * 整屏重绘。这是显式承认的降级边界，不是可以靠预算消除的情况。
 */
export function dockFitsTerminal(
  terminalRows: number,
  cost: DockRowCost,
): boolean {
  return dockRows(cost) + 1 <= terminalRows;
}

export interface LiveSectionBudget {
  /** compaction 提示占用的行数（0 或 1）。 */
  readonly compactionRows: number;
  /** reasoning 尾部预览占用的行数（0 或 1）。 */
  readonly reasoningRows: number;
  /** assistant 流式文本保留的尾部行数。 */
  readonly assistantRows: number;
  readonly toolCount: number;
  readonly commandRunCount: number;
  readonly subagentCount: number;
  readonly steerCount: number;
}

export interface LiveSectionInput {
  readonly maxRows: number;
  readonly hasCompaction: boolean;
  readonly hasReasoning: boolean;
  /** assistant 是否有流式文本；具体行数由预算决定。 */
  readonly hasAssistant: boolean;
  readonly toolCount: number;
  readonly commandRunCount: number;
  readonly subagentCount: number;
  readonly steerCount: number;
  readonly statusRows: number;
}

/** 即使工具很多，也先给 assistant 流式文本留下的最小可读行数。 */
const ASSISTANT_MIN_ROWS = 3;

/**
 * 分配 live 区行数。
 *
 * 先保住"读得懂当前发生了什么"所需的最小集合：运行状态、compaction/reasoning 各一行
 * 尾部预览、assistant 的前几行；再按 subagent → command run → tool 的顺序放卡片；
 * 剩下的行全部还给 assistant 尾部文本。
 */
export function allocateLiveRows(input: LiveSectionInput): LiveSectionBudget {
  let remaining = Math.max(0, input.maxRows);

  const take = (rows: number): number => {
    const granted = Math.max(0, Math.min(rows, remaining));
    remaining -= granted;
    return granted;
  };
  const takeCards = (count: number, rowsPerCard: number): number => {
    const affordable = Math.floor(remaining / rowsPerCard);
    const granted = Math.min(count, Math.max(0, affordable));
    remaining -= granted * rowsPerCard;
    return granted;
  };

  take(input.statusRows);
  const compactionRows = input.hasCompaction ? take(1) : 0;
  const reasoningRows = input.hasReasoning ? take(1) : 0;
  const assistantFloor = input.hasAssistant ? take(ASSISTANT_MIN_ROWS) : 0;
  const steerCount =
    input.steerCount === 0 ? 0 : takeSteers(input.steerCount, take);
  const subagentCount = takeCards(input.subagentCount, SUBAGENT_ROWS);
  const commandRunCount = takeCards(input.commandRunCount, COMMAND_RUN_ROWS);
  const toolCount = takeCards(input.toolCount, TOOL_CARD_ROWS);
  const assistantRows =
    assistantFloor + (input.hasAssistant ? take(remaining) : 0);

  return {
    compactionRows,
    reasoningRows,
    assistantRows,
    toolCount,
    commandRunCount,
    subagentCount,
    steerCount,
  };
}

/** steer 区含 marginTop 与标题共 2 行固定开销，逐条再占 1 行。 */
function takeSteers(count: number, take: (rows: number) => number): number {
  const header = take(2);
  if (header < 2) return 0;
  return take(count);
}
