import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest requires default export
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    env: {
      FORCE_HYPERLINK: '1',
    },
  },
});
