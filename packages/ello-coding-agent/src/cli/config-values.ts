/**
 * 将 `ello config set <key> <value>` 拆分为 key 和原始 value。
 */
export function splitConfigSetPrompt(prompt: string): [string, string] {
  const [key, ...rest] = prompt.trim().split(/\s+/);
  if (!key || rest.length === 0) {
    throw new Error('Usage: ello config set <key> <value>');
  }
  return [key, rest.join(' ')];
}

/**
 * 解析 CLI 配置值；JSON 解析失败时保留原始字符串。
 */
export function parseConfigValue(raw: string): unknown {
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw === 'null') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
