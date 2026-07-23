import { useEffect } from 'react';

export interface Hotkey {
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** mod 只匹配 Cmd。 */
export function matchHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  const modPressed = event.metaKey;
  if (hotkey.mod === true && !modPressed) return false;
  if (hotkey.mod !== true && modPressed) return false;
  if ((hotkey.shift ?? false) !== event.shiftKey) return false;
  if ((hotkey.alt ?? false) !== event.altKey) return false;
  return event.key.toLowerCase() === hotkey.key.toLowerCase();
}

/** 注册全局快捷键;handler 返回 true 时 preventDefault。 */
export function useGlobalHotkey(
  hotkey: Hotkey,
  handler: (event: KeyboardEvent) => boolean | void,
): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!matchHotkey(event, hotkey)) return;
      if (handler(event) !== false) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });
}
