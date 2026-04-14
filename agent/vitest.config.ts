import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["nanoclaw/**", "node_modules/**"],
  },
});
