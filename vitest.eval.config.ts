/**
 * Vitest config for LLM evals only (`npm run eval`). The default `vitest run`
 * has no config file and its include pattern (*.test / *.spec) never matches
 * *.eval.ts, so the normal suite stays LLM-free.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    setupFiles: ['evals/_support/setup.ts'],
    reporters: ['langsmith/vitest/reporter'],
    testTimeout: 90_000,
    // Keep request rate modest: one file at a time, tests in a file run sequentially.
    fileParallelism: false,
  },
});
