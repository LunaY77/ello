import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { OverlayState } from '../component/OverlayHost.js';

/** Overlay 的单一状态入口，保持请求 overlay 与手动 overlay 可组合。 */
export function useOverlay(): {
  readonly overlay: OverlayState;
  readonly setOverlay: Dispatch<SetStateAction<OverlayState>>;
} {
  const [overlay, setOverlay] = useState<OverlayState>({ type: 'none' });
  return { overlay, setOverlay };
}
