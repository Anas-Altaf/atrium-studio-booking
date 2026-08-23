import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // These tests run against a real database on purpose. The risky logic here
    // is the constraints and the trigger, and a mocked database would test the
    // mock rather than the invariant.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
