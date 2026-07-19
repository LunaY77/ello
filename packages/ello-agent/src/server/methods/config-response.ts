/**
 * RPC 配置响应只暴露运行参数，不暴露任何可用于认证的值。键名采用递归判断，
 * 因而 provider options、模型 headers 和未来新增的嵌套配置也受同一契约保护。
 */
export function sanitizeConfigForResponse(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigForResponse(item));
  }
  if (typeof value === 'string') return sanitizeCredentialUrl(value);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      isCredentialKey(key)
        ? []
        : [[key, sanitizeConfigForResponse(nested)] as const],
    ),
  );
}

/** base_url 等非凭证字段也可能把 userinfo 或 token query 嵌入 URL。 */
function sanitizeCredentialUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.username !== '' || url.password !== '') {
    url.username = '';
    url.password = '';
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (!isCredentialKey(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  return changed ? url.toString() : value;
}

function isCredentialKey(key: string): boolean {
  const parts = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part !== '');
  const normalized = parts.join('');

  if (
    normalized === 'auth' ||
    normalized === 'authorization' ||
    normalized === 'authentication' ||
    normalized === 'proxyauthorization' ||
    normalized === 'authheader' ||
    normalized === 'authheaders' ||
    normalized === 'headers' ||
    normalized.endsWith('headers') ||
    normalized === 'cookie' ||
    normalized === 'setcookie'
  ) {
    return true;
  }
  if (
    parts.includes('auth') ||
    parts.includes('password') ||
    parts.includes('passwd') ||
    parts.includes('secret') ||
    parts.includes('credential') ||
    parts.includes('credentials')
  ) {
    return true;
  }
  if (hasAdjacentParts(parts, 'api', 'key')) return true;
  if (hasAdjacentParts(parts, 'private', 'key')) return true;

  const tokenIndex = parts.indexOf('token');
  if (tokenIndex < 0) return false;
  const credentialQualifiers = new Set([
    'access',
    'api',
    'auth',
    'bearer',
    'client',
    'github',
    'gitlab',
    'id',
    'jwt',
    'oauth',
    'personal',
    'refresh',
    'session',
  ]);
  if (parts.some((part) => credentialQualifiers.has(part))) return true;

  // token budget/limit 是模型参数而非 credential，必须保留其功能语义。
  const measurementQualifiers = new Set([
    'budget',
    'count',
    'counts',
    'input',
    'limit',
    'max',
    'maximum',
    'minimum',
    'output',
    'reserved',
    'usage',
  ]);
  return !parts.some((part) => measurementQualifiers.has(part));
}

function hasAdjacentParts(
  parts: readonly string[],
  left: string,
  right: string,
): boolean {
  return parts.some(
    (part, index) => part === left && parts[index + 1] === right,
  );
}
