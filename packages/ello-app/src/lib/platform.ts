/**
 * 平台判定与快捷键符号的跨平台渲染。
 *
 * macOS 使用 ⌘(metaKey),Windows/Linux 使用 Ctrl;判定在模块加载时完成一次,
 * 运行期间平台不会变化。
 */

const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');

/** 是否运行在 macOS(webview 的 navigator.platform 含 "Mac")。 */
export function isMacPlatform(): boolean {
  return IS_MAC;
}

/**
 * 把快捷键文案里的 ⌘ 按平台渲染:macOS 原样保留;Windows/Linux 替换为 `Ctrl+`。
 * 不含 ⌘ 的字符串原样返回,可安全用于任意文案。
 */
export function formatKeys(text: string): string {
  return IS_MAC ? text : text.replace(/⌘/gu, 'Ctrl+');
}
