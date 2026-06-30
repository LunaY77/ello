import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ello/agent': new URL('../ello-agent/src/index.ts', import.meta.url)
        .pathname,
      '@ello/agent/extensions': new URL(
        '../ello-agent/src/extensions/index.ts',
        import.meta.url,
      ).pathname,
      '@ello/agent/presets': new URL(
        '../ello-agent/src/presets/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
