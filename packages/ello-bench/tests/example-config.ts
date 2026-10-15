import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 检入仓库的示例配置路径。
 *
 * 本地 config 模块含私有 endpoint 与模型 id，已被 gitignore。测试直接加载
 * 检入仓库的 TOML 示例，确保拆分后的文档可以被严格解析。
 */
export const EXAMPLE_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'examples',
  'deep-swe.toml',
);

export const SWE_BENCH_PRO_EXAMPLE_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'examples',
  'swe-bench-pro.toml',
);
