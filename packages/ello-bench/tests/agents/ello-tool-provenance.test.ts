import { describe, expect, it } from 'vitest';

import {
  AgentArtifactRuntimeProvenanceSchema,
  AgentRuntimeProvenanceSchema,
} from '../../src/domain/contract/index.js';
import {
  effectiveToolProvenance,
  ELLO_PROVIDER_TOOLS,
} from '../../src/infra/agent/ello/tool-provenance.js';

describe('Ello tool provenance', () => {
  it('records Command Run with the observed model schema fingerprint', () => {
    expect(effectiveToolProvenance(['a'.repeat(64)])).toEqual({
      enabled: ELLO_PROVIDER_TOOLS,
      toolsetFingerprint: 'a'.repeat(64),
    });
  });

  it('rejects a provider tool schema that changes during one run', () => {
    expect(() =>
      effectiveToolProvenance(['a'.repeat(64), 'b'.repeat(64)]),
    ).toThrow('toolset changed during the main run');
  });

  it('keeps legacy runtime reading separate from new artifact writes', () => {
    const legacyRuntime = {
      schema: 'ello.benchmark.agent-runtime.v1',
      agentId: 'ello',
      displayName: 'Ello',
      agentConfigHash: 'a'.repeat(64),
      adapterContractVersion: '1',
      expectedModel: 'model',
      observedModel: 'model',
      configSha256: 'a'.repeat(64),
      kind: 'ello',
      primaryModel: 'primary',
      auxiliaryModel: 'auxiliary',
    };

    expect(AgentRuntimeProvenanceSchema.safeParse(legacyRuntime).success).toBe(
      false,
    );
    expect(AgentArtifactRuntimeProvenanceSchema.parse(legacyRuntime)).toEqual(
      legacyRuntime,
    );
  });

  it('requires prompt mode in newly written Ello runtime provenance', () => {
    const runtime = {
      schema: 'ello.benchmark.agent-runtime.v1',
      agentId: 'ello',
      displayName: 'Ello',
      agentConfigHash: 'a'.repeat(64),
      adapterContractVersion: '2',
      expectedModel: 'model',
      observedModel: 'model',
      configSha256: 'a'.repeat(64),
      kind: 'ello',
      primaryModel: 'primary',
      auxiliaryModel: 'auxiliary',
      promptMode: 'thorough',
      enabledTools: ['command_run'],
      toolsetFingerprint: 'b'.repeat(64),
    };

    expect(AgentRuntimeProvenanceSchema.parse(runtime)).toEqual(runtime);
    expect(
      AgentRuntimeProvenanceSchema.safeParse({
        ...runtime,
        promptMode: undefined,
      }).success,
    ).toBe(false);
  });
});
