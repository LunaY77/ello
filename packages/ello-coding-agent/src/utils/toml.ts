import { parse, stringify } from 'smol-toml';

/** 统一封装 TOML 解析，便于调用方只依赖普通 Record。 */
export function parseTomlConfig(text: string): Record<string, unknown> {
  return parse(text) as Record<string, unknown>;
}

/** 统一封装 TOML 序列化，并保证文件末尾有换行。 */
export function stringifyTomlConfig(value: Record<string, unknown>): string {
  return `${stringify(value)}\n`;
}
