/** 统一流事件。 */
export interface StreamEvent<TEvent = unknown> {
  /** 产生事件的 agent 标识。 */
  agentId: string;
  /** agent 名称。 */
  agentName: string;
  /** 底层模型或运行时事件。 */
  event: TEvent;
}

/** 文本 part 开始事件。 */
export interface PartStartEvent {
  eventKind: 'part_start';
  index: number;
  part: StreamTextPart;
}

/** 文本 part 增量事件。 */
export interface PartDeltaEvent {
  eventKind: 'part_delta';
  index: number;
  delta: StreamTextDelta;
}

/** 文本 part 结束事件。 */
export interface PartEndEvent {
  eventKind: 'part_end';
  index: number;
  part: StreamTextPart;
}

/** TS 版 streaming 使用的文本 part。 */
export interface StreamTextPart {
  type: 'text';
  text: string;
}

/** TS 版 streaming 使用的文本 delta。 */
export interface StreamTextDelta {
  deltaKind: 'text';
  contentDelta: string;
}

/** streaming recovery 可识别的事件。 */
export type RecoverableStreamEvent =
  | PartStartEvent
  | PartDeltaEvent
  | PartEndEvent;
