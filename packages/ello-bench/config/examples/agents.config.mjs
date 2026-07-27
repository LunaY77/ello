export const agents = [
  {
    id: 'ello',
    displayName: 'Ello',
    kind: 'ello',
    models: {
      'benchmark-pro': {
        protocol: 'anthropic',
        authScheme: 'bearer',
        apiModel: '<your-model-id>',
        baseUrl: 'https://api.example.com/anthropic',
        apiKeyEnv: 'ELLO_BENCH_API_KEY',
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        reasoningEffort: 'high',
      },
      'benchmark-flash': {
        protocol: 'anthropic',
        authScheme: 'bearer',
        apiModel: '<your-fast-model-id>',
        baseUrl: 'https://api.example.com/anthropic',
        apiKeyEnv: 'ELLO_BENCH_API_KEY',
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        reasoningEffort: 'medium',
      },
    },
    primaryModel: 'benchmark-pro',
    auxiliaryModel: 'benchmark-flash',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    kind: 'claude-code',
    model: '<your-model-id>',
    binary: {
      pathEnv: 'ELLO_BENCH_CLAUDE_EXE',
      expectedVersion: '2.1.217',
      sha256:
        '0000000000000000000000000000000000000000000000000000000000000000',
    },
    connection: {
      baseUrl: 'https://api.example.com/anthropic',
      apiKeyEnv: 'ELLO_BENCH_API_KEY',
    },
    environment: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true',
    },
  },
];
