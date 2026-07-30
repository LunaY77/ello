import type { HarnessReport, PatchArtifact } from '../domain/contract/index.js';

import type { ResolvedTaskFiles } from './corpus.js';

export interface VerifierRuntime {
  run(options: {
    readonly attemptId: string;
    readonly harnessRoot: string;
    readonly gitCacheRoot: string;
    readonly taskFiles: ResolvedTaskFiles;
    readonly patch: PatchArtifact;
    readonly lastAgentVerificationRound: number | null;
  }): Promise<HarnessReport>;
}

export interface VerifierFailure extends Error {
  readonly processEvidence: import('../domain/contract/index.js').ArtifactReference;
}
