import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type ZhiliaoConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname, ".tmp-config-test");

describe("loadConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("loads a valid config file", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
project:
  name: "test-project"
feishu:
  app_id: "cli_test"
  app_secret: "secret123"
  event_mode: "websocket"
llm:
  agent:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
  memo:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
  embedding:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-embedding"
git:
  poll_interval_minutes: 5
  deep_scan_cron: "0 2 * * *"
  ssh_key_path: "./data/deploy_key"
knowledge:
  decay_after_days: 30
  qa_compress_after_days: 30
  change_log_compress_after_days: 90
admins:
  - "ou_test123"
`
    );

    const config = loadConfig(configPath);
    expect(config.project.name).toBe("test-project");
    expect(config.feishu.app_id).toBe("cli_test");
    expect(config.llm.agent.model).toBe("claude-sonnet-4-20250514");
    expect(config.git?.poll_interval_minutes).toBe(5);
    expect(config.knowledge?.decay_after_days).toBe(30);
    expect(config.admins).toEqual(["ou_test123"]);
  });

  it("substitutes environment variables", () => {
    process.env.TEST_FEISHU_SECRET = "env_secret_value";
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
project:
  name: "test"
feishu:
  app_id: "cli_test"
  app_secret: "\${TEST_FEISHU_SECRET}"
  event_mode: "websocket"
llm:
  agent:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
  memo:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
  embedding:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-embedding"
git:
  poll_interval_minutes: 5
  deep_scan_cron: "0 2 * * *"
  ssh_key_path: "./data/deploy_key"
knowledge:
  decay_after_days: 30
  qa_compress_after_days: 30
  change_log_compress_after_days: 90
admins: []
`
    );

    const config = loadConfig(configPath);
    expect(config.feishu.app_secret).toBe("env_secret_value");
    delete process.env.TEST_FEISHU_SECRET;
  });

  it("throws on missing config file", () => {
    expect(() => loadConfig("/nonexistent/config.yaml")).toThrow();
  });
});
