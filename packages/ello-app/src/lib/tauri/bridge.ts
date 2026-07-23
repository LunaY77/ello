/**
 * Tauri 原生能力的窄封装。业务组件只经这里触达窗口、文件选择、外部打开;
 * WebView 纯浏览器开发环境下调用直接抛错,不静默降级。
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauri(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

function assertTauri(capability: string): void {
  if (!isTauri()) {
    throw new Error(`${capability} requires the Tauri desktop runtime.`);
  }
}

/** 调起系统目录选择器;用户取消时返回 null。 */
export async function pickDirectory(title: string): Promise<string | null> {
  assertTauri('Directory picker');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ title, directory: true, multiple: false });
  if (selected === null) return null;
  if (typeof selected !== 'string') {
    throw new Error('Directory picker returned a non-string path.');
  }
  return selected;
}

/** 调起系统文件选择器;用户取消时返回 null。 */
export async function pickFiles(title: string): Promise<readonly string[]> {
  assertTauri('File picker');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ title, directory: false, multiple: true });
  if (selected === null) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** 在系统默认应用中打开路径或 URL。 */
export async function openExternal(target: string): Promise<void> {
  assertTauri('Open external');
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await openPath(target);
}

/** 发送系统通知(应用不在前台时)。 */
export async function sendSystemNotification(
  title: string,
  body: string,
): Promise<void> {
  assertTauri('System notification');
  const notification = await import('@tauri-apps/plugin-notification');
  let granted = await notification.isPermissionGranted();
  if (!granted) {
    granted = (await notification.requestPermission()) === 'granted';
  }
  if (!granted) return;
  notification.sendNotification({ title, body });
}
