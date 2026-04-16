import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "nanoclaw/**",
      "node_modules/**",
      "tests/web/**",        // L2 runs via vitest.web.config.ts
      "tests/e2e-web/**",    // L4 runs via playwright
    ],
  },
});
