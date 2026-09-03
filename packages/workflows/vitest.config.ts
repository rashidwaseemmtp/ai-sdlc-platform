import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Workflow tests each spin up a worker; running them in one thread avoids task-queue clashes
    // and keeps the time-skipping server's clock coherent across tests.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
