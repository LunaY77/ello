import { create } from 'zustand';

interface PaletteState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * 命令面板打开状态。独立于 commands.ts(命令清单会频繁变更),
 * 避免热更新命令清单时重建 store 造成状态分裂。
 */
export const usePaletteStore = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
