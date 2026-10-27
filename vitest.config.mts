import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The executable starts real listeners and exits the process. Its wiring is tested via container.ts.
      exclude: ['src/**/*.d.ts', 'src/**/index.ts', 'src/server.ts'],
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 99, statements: 99, functions: 99, branches: 93 },
    },
  },
});
