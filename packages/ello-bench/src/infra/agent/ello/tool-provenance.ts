export const ELLO_PROVIDER_TOOLS = ['command_run'] as const;

export interface ElloEffectiveToolProvenance {
  readonly enabled: typeof ELLO_PROVIDER_TOOLS;
  readonly toolsetFingerprint: string;
}

export function effectiveToolProvenance(
  fingerprints: readonly string[],
): ElloEffectiveToolProvenance {
  if (fingerprints.length !== 1) {
    throw new Error(
      `Ello toolset changed during the main run: ${fingerprints.join(', ')}.`,
    );
  }
  const toolsetFingerprint = fingerprints[0];
  if (toolsetFingerprint === undefined) {
    throw new Error('Ello toolset fingerprint is missing.');
  }
  return {
    enabled: ELLO_PROVIDER_TOOLS,
    toolsetFingerprint,
  };
}
