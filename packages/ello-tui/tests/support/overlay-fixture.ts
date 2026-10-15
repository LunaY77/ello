import type { OverlayHostProps } from '../../src/tui/component/OverlayHost.js';

type OverlayCallbacks = Omit<OverlayHostProps, 'marginTop' | 'overlay'>;

export function overlayCallbacks(
  overrides: Partial<OverlayCallbacks> = {},
): OverlayCallbacks {
  return {
    onApprove: () => undefined,
    onResolveUserInput: () => undefined,
    onAcceptPlan: () => undefined,
    onChatAboutPlan: () => undefined,
    onDenyPlan: () => undefined,
    onClosePlanPreview: () => undefined,
    onSelectModelSelector: () => undefined,
    onSelectModel: () => undefined,
    onSelectSession: () => undefined,
    onSelectRewind: () => undefined,
    onUpdateSetting: async () => undefined,
    ...overrides,
  };
}
