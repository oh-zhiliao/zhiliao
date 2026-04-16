import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 18080);
const TEST_TOKEN = process.env.E2E_TEST_TOKEN ?? "e2e-fixed-token";

export default defineConfig({
  testDir: "./tests/e2e-web",
  fullyParallel: false, // Shared in-process server
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "tests/e2e-web/results.json" }]],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node --import tsx/esm tests/e2e-web/fixture-server.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 15_000,
    reuseExistingServer: !process.env.CI,
    env: {
      E2E_PORT: String(PORT),
      E2E_TEST_TOKEN: TEST_TOKEN,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

export { TEST_TOKEN, PORT };
