import type {
  DeepSweTaskDeclaration,
  ResolvedTask,
  SweBenchProTaskDeclaration,
} from '../domain/contract/index.js';

export interface DeepSweTaskFiles {
  readonly benchmark: 'deep-swe';
  readonly task: Extract<ResolvedTask, { benchmark: 'deep-swe' }>;
  readonly taskRoot: string;
  readonly instruction: string;
  readonly instructionPath: string;
  readonly verifierScriptPath: string;
  readonly verifierPatchPath: string;
}

export interface SweBenchProTestSpec {
  readonly selectedTests: readonly string[];
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
}

export interface SweBenchProTaskFiles {
  readonly benchmark: 'swe-bench-pro';
  readonly task: Extract<ResolvedTask, { benchmark: 'swe-bench-pro' }>;
  readonly instruction: string;
  readonly runScriptPath: string;
  readonly parserPath: string;
  readonly workspaceSetupCommands: readonly (readonly string[])[];
  readonly workspacePatch: string;
  readonly testSpec: SweBenchProTestSpec;
}

export type ResolvedTaskFiles = DeepSweTaskFiles | SweBenchProTaskFiles;

export interface TaskCorpus {
  loadDeepSwe(declaration: DeepSweTaskDeclaration): Promise<DeepSweTaskFiles>;
  loadSweBenchPro(
    declaration: SweBenchProTaskDeclaration,
  ): Promise<SweBenchProTaskFiles>;
}
