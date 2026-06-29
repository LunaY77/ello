export function parseTomlConfig(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let sectionPath: string[] = [];
  const lines = text.split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/u);
    if (sectionMatch !== null) {
      const section = sectionMatch[1];
      if (section !== undefined) {
        sectionPath = section.split('.');
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u);
    if (match === null) {
      continue;
    }
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    setNested(result, [...sectionPath, ...key.split('.')].join('.'), parseTomlValue(rawValue.trim()));
  }
  return result;
}

export function stringifyTomlConfig(value: Record<string, unknown>): string {
  const lines: string[] = [];
  emitTable(lines, value, []);
  return `${lines.join('\n')}\n`;
}

function emitTable(
  lines: string[],
  value: Record<string, unknown>,
  pathSegments: string[],
): void {
  const scalars: Array<[string, unknown]> = [];
  const tables: Array<[string, Record<string, unknown>]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (isPlainObject(child)) {
      tables.push([key, child]);
    } else {
      scalars.push([key, child]);
    }
  }
  if (pathSegments.length > 0 && (scalars.length > 0 || tables.length > 0)) {
    lines.push(`[${pathSegments.join('.')}]`);
  }
  for (const [key, child] of scalars) {
    lines.push(`${key} = ${formatTomlValue(child)}`);
  }
  if (scalars.length > 0 && tables.length > 0) {
    lines.push('');
  }
  tables.forEach(([key, child], index) => {
    emitTable(lines, child, [...pathSegments, key]);
    if (index < tables.length - 1) {
      lines.push('');
    }
  });
}

function setNested(
  target: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
): void {
  const parts = dottedKey.split('.');
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const existing = current[part];
    if (!isPlainObject(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

function parseTomlValue(rawValue: string): unknown {
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return JSON.parse(rawValue);
  }
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (rawValue === 'null') return null;
  if (/^[+-]?\d+$/u.test(rawValue)) return Number(rawValue);
  if (/^[+-]?\d+\.\d+$/u.test(rawValue)) return Number(rawValue);
  if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
    return JSON.parse(rawValue);
  }
  return rawValue;
}

function formatTomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
