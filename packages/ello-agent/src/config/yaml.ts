import { parse, parseDocument, stringify } from 'yaml';

/** 统一封装 YAML 解析，空文件按空对象处理。 */
export function parseYamlConfig(text: string): Record<string, unknown> {
  const value = parse(text);
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('YAML config root must be an object.');
  }
  return value as Record<string, unknown>;
}

/** 统一封装 YAML 序列化，并保证文件末尾有换行。 */
export function stringifyYamlConfig(value: Record<string, unknown>): string {
  return stringify(value, { lineWidth: 0 });
}

/** 路径级更新 YAML，保留未触达区域的注释与排版。 */
export function updateYamlConfigValues(
  text: string,
  entries: readonly {
    readonly path: readonly string[];
    readonly value: unknown;
  }[],
): string {
  const document = parseDocument(text);
  assertValidDocument(document.errors);
  for (const entry of entries) {
    document.setIn([...entry.path], entry.value);
  }
  return ensureTrailingNewline(String(document));
}

/** 路径级删除 YAML，保留未触达区域的注释与排版。 */
export function deleteYamlConfigValues(
  text: string,
  paths: readonly (readonly string[])[],
): string {
  const document = parseDocument(text);
  assertValidDocument(document.errors);
  for (const path of paths) {
    document.deleteIn([...path]);
  }
  return ensureTrailingNewline(String(document));
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function assertValidDocument(errors: readonly Error[]): void {
  if (errors.length > 0) {
    throw new Error(`Invalid YAML config: ${errors[0]!.message}`);
  }
}
