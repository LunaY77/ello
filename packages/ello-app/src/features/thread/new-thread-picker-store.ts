import { create } from 'zustand';

interface PickerState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * 新建会话归属选择器的打开状态。独立小 store(对齐命令面板的 usePaletteStore 模式),
 * 由 newThreadInContext 在未选中工作区时触发。
 */
export const useNewThreadPickerStore = create<PickerState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
