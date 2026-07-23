/**
 * Storybook 专用基建(组件台,不进入生产 bundle 逻辑):
 * - resetAllStores:每个 story 渲染前重置全部模块 store,story 之间零泄漏;
 * - ThemeBridge:经 toolbar 全局量切换 data-theme,并铺上 canvas 底色;
 * - Screen / Padded:整页类与小组件类 story 的布局容器。
 *
 * 规则:story 只使用类型正确的协议 fixture 和显式 decorator,
 * 不连接真实 App Server、网络或本机 Tauri 能力。
 */
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { toast } from '@/components/ui/Toasts';
import { usePaletteStore } from '@/features/command-palette/commands';
import {
  useComposerStore,
  type ComposerAttachment,
  type ComposerQueueEntry,
} from '@/features/composer/composer';
import { useFilesCache, type DirectoryEntry } from '@/features/files/files';
import { initialState, useAppStore } from '@/store/store';
import type { AppState } from '@/store/types';

/** story 的种子:基于 initialState 深拷贝返回需要的状态。 */
export type StoreSeed = (state: AppState) => AppState;

export interface ComposerStorySeed {
  readonly drafts: Readonly<Record<string, string>>;
  readonly attachments: Readonly<Record<string, readonly ComposerAttachment[]>>;
  readonly queues: Readonly<Record<string, readonly ComposerQueueEntry[]>>;
}

export interface FilesStorySeed {
  readonly directories: Readonly<Record<string, readonly DirectoryEntry[]>>;
  readonly files: Readonly<Record<string, string>>;
}

export function resetAllStores(options: {
  readonly store?: StoreSeed | undefined;
  readonly paletteOpen?: boolean | undefined;
  readonly composer?: ComposerStorySeed | undefined;
  readonly files?: FilesStorySeed | undefined;
}): void {
  const base = structuredClone(initialState);
  // 根 store 是纯数据,可整体替换;功能型 store 含修改函数,按数据字段重置。
  useAppStore.setState(options.store === undefined ? base : options.store(base), true);
  useComposerStore.setState(
    options.composer ?? { drafts: {}, attachments: {}, queues: {} },
  );
  useFilesCache.setState(options.files ?? { directories: {}, files: {} });
  usePaletteStore.setState({ open: options.paletteOpen ?? false });
  toast.clear();
}

/** 主题桥:把 toolbar 全局量落到 <html data-theme>,与 app 运行时同一条路径。 */
export function ThemeBridge(props: {
  readonly theme: 'light' | 'dark';
  readonly children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.dataset['theme'] = props.theme;
  }, [props.theme]);
  return (
    <div className="min-h-screen bg-canvas font-sans text-primary">
      {props.children}
    </div>
  );
}

/** 整页/骨架类 story 的容器:撑满预览视口。 */
export function Screen(props: { readonly children: ReactNode }) {
  return <div className="flex h-screen flex-col overflow-hidden">{props.children}</div>;
}

/** 小组件 story 的容器:留白 + 可居中。 */
export function Padded(props: {
  readonly children: ReactNode;
  readonly center?: boolean;
  readonly width?: number;
}) {
  return (
    <div
      className={props.center === true ? 'flex min-h-[320px] items-center justify-center p-8' : 'p-6'}
      style={props.width === undefined ? undefined : { maxWidth: props.width }}
    >
      {props.children}
    </div>
  );
}

/** 需要路由上下文的页面级 story 装饰器。 */
export function withRouter(story: ReactNode): ReactElement {
  return <MemoryRouter>{story}</MemoryRouter>;
}
