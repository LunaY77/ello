import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  validateBenchmarkConfig,
  validateBenchmarkDefinition,
  type BenchmarkConfig,
  type BenchmarkDefinition,
} from './contracts.js';
import { sha256, stableJson } from './hash.js';
import { getBenchmarkSuite } from './suite.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const DEFAULT_CONFIG_PATH = path.join(
  packageRoot,
  'config',
  'benchmark.config.mjs',
);

export async function loadBenchmarkConfig(
  configPath = DEFAULT_CONFIG_PATH,
): Promise<BenchmarkConfig> {
  const resolvedPath = path.resolve(configPath);
  const module = (await import(pathToFileURL(resolvedPath).href)) as {
    readonly default?: unknown;
  };
  if (module.default === undefined) {
    throw new Error(`Benchmark config must export default: ${resolvedPath}`);
  }
  return resolveBenchmarkDefinition(
    validateBenchmarkDefinition(module.default),
  );
}

export function resolveBenchmarkDefinition(
  definition: BenchmarkDefinition,
): BenchmarkConfig {
  const suite = getBenchmarkSuite(definition.suite);
  const actualTaskSetHash = sha256(stableJson(suite.tasks));
  if (actualTaskSetHash !== suite.metadata.taskSetHash) {
    throw new Error(
      `Suite task-set hash mismatch: expected ${suite.metadata.taskSetHash}, received ${actualTaskSetHash}.`,
    );
  }
  return validateBenchmarkConfig({
    schema: 'ello.benchmark.resolved-config.v1',
    suite: suite.metadata,
    execution: definition.execution,
    report: definition.report,
    agents: definition.agents,
    tasks: suite.tasks,
  });
}
