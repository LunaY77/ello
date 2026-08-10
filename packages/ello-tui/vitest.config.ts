import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Screen tests mount Ink on a fake interactive TTY. Ink otherwise detects
    // GitHub Actions and defers every non-static frame until unmount.
    env: { CI: 'false' },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
