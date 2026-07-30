import { parse } from 'smol-toml';
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

/** 使用正式 TOML 解析器读取 corpus 契约，再由唯一 schema 拒绝未知字段。 */
export function parseTaskToml(source: string): TaskToml {
  return TaskTomlSchema.parse(parse(source));
}
