import type { ResolvedTask } from './contracts.js';
import { getBenchmarkSuiteForTask } from './suite.js';

export type ContainerShellMode = 'login' | 'preserve-environment';

export function containerShellMode(
  benchmark: ResolvedTask['benchmark'],
): ContainerShellMode {
  return getBenchmarkSuiteForTask(benchmark).shellMode;
}

export function containerShellFlag(mode: ContainerShellMode): '-lc' | '-c' {
  return mode === 'login' ? '-lc' : '-c';
}
