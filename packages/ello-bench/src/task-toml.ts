import { z } from 'zod';

const TaskTomlSchema = z
  .object({
    version: z.literal('1.0'),
    metadata: z
      .object({
        ext_id: z.string().min(1),
        task_id: z.string().min(1),
        display_title: z.string().min(1),
        display_description: z.string().min(1),
        original_title: z.string().min(1),
        category: z.string().min(1),
        language: z.enum(['go', 'python', 'typescript', 'rust', 'javascript']),
        repository_url: z.string().url(),
        base_commit_hash: z.string().regex(/^[0-9a-f]{7,64}$/u),
      })
      .strict(),
    verifier: z.object({ timeout_sec: z.number().positive() }).strict(),
    agent: z.object({ timeout_sec: z.number().positive() }).strict(),
    environment: z
      .object({
        docker_image: z.string().min(1),
        allow_internet: z.boolean(),
        build_timeout_sec: z.number().positive(),
        cpus: z.number().positive(),
        memory_mb: z.number().int().positive(),
        storage_mb: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type TaskToml = z.infer<typeof TaskTomlSchema>;

/** 解析 corpus v1.1 使用的标量 TOML 子集，遇到未声明语法时直接失败。 */
export function parseTaskToml(source: string): TaskToml {
  const document: Record<string, unknown> = {};
  let section: Record<string, unknown> = document;
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sectionMatch = /^\[([a-z_]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1];
      if (sectionName === undefined) throw new Error('Missing TOML section.');
      if (Object.hasOwn(document, sectionName)) {
        throw new Error(`Duplicate TOML section ${sectionName}.`);
      }
      section = {};
      document[sectionName] = section;
      continue;
    }
    const assignment = /^([a-z_]+)\s*=\s*(.+)$/u.exec(line);
    if (assignment === null) {
      throw new Error(`Unsupported task.toml syntax at line ${index + 1}.`);
    }
    const key = assignment[1];
    const rawValue = assignment[2];
    if (key === undefined || rawValue === undefined) {
      throw new Error(`Invalid task.toml assignment at line ${index + 1}.`);
    }
    if (Object.hasOwn(section, key)) {
      throw new Error(`Duplicate task.toml key ${key} at line ${index + 1}.`);
    }
    section[key] = parseScalar(rawValue, index + 1);
  }
  return TaskTomlSchema.parse(document);
}

function parseScalar(value: string, line: number): string | number | boolean {
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string') {
      throw new Error(`Expected string at task.toml line ${line}.`);
    }
    return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  throw new Error(`Unsupported task.toml value at line ${line}.`);
}
