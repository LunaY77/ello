export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const MEDIA = '(prefers-color-scheme: dark)';

/** 解析偏好为实际主题;system 跟随 OS。 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  return window.matchMedia(MEDIA).matches ? 'dark' : 'light';
}

/** 原子切换主题:只改 data-theme,所有 CSS 变量同时生效。 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset['theme'] = resolved;
  return resolved;
}

/** 监听 OS 主题变化;仅在 preference 为 system 时影响渲染。 */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(MEDIA);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
