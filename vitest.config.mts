import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one real Postgres database; running test
    // files in parallel causes concurrent TRUNCATEs to deadlock and race.
    fileParallelism: false,
  },
});
