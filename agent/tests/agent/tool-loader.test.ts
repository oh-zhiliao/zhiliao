import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadPlugins } from "../../src/agent/tool-loader.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadPlugins", () => {
  let pluginsDir: string;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `zhiliao-test-plugins-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  it("returns empty array when plugins dir does not exist", async () => {
    const result = await loadPlugins("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual([]);
  });

  it("returns empty array when plugins dir is empty", async () => {
    const result = await loadPlugins(pluginsDir);
    expect(result).toEqual([]);
  });

  it("skips plugin folder without config.yaml", async () => {
    const pluginDir = join(pluginsDir, "no-config");
    mkdirSync(join(pluginDir, "src"), { recursive: true });
    writeFileSync(join(pluginDir, "src", "index.js"),
      `export default class TestPlugin {
        name = "test";
        async init() {}
        getToolDefinitions() { return []; }
        async executeTool() { return "ok"; }
      }`
    );
    const result = await loadPlugins(pluginsDir);
    expect(result).toEqual([]);
  });

  it("skips plugin with enabled: false in config", async () => {
    const pluginDir = join(pluginsDir, "disabled");
    mkdirSync(join(pluginDir, "src"), { recursive: true });
    writeFileSync(join(pluginDir, "config.yaml"), "enabled: false\n");
    writeFileSync(join(pluginDir, "src", "index.js"),
      `export default class TestPlugin {
        name = "test";
        async init() {}
        getToolDefinitions() { return []; }
        async executeTool() { return "ok"; }
      }`
    );
    const result = await loadPlugins(pluginsDir);
    expect(result).toEqual([]);
  });

  it("loads a valid plugin and sets name from folder", async () => {
    const pluginDir = join(pluginsDir, "my-plugin");
    mkdirSync(join(pluginDir, "src"), { recursive: true });
    writeFileSync(join(pluginDir, "config.yaml"), "enabled: true\nfoo: bar\n");
    writeFileSync(join(pluginDir, "src", "index.js"),
      `export default class MyPlugin {
        name = "";
        async init(config) { this._config = config; }
        getToolDefinitions() { return [{ name: "hello", description: "say hi", input_schema: { type: "object", properties: {} } }]; }
        async executeTool(name, input) { return "result"; }
      }`
    );
    const result = await loadPlugins(pluginsDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-plugin");
    expect(result[0].getToolDefinitions()).toHaveLength(1);
  });

  it("resolves ${ENV_VAR} in plugin config", async () => {
    process.env.__TEST_PLUGIN_SECRET = "s3cret";
    const pluginDir = join(pluginsDir, "env-test");
    mkdirSync(join(pluginDir, "src"), { recursive: true });
    writeFileSync(join(pluginDir, "config.yaml"), 'enabled: true\nsecret: "${__TEST_PLUGIN_SECRET}"\n');
    writeFileSync(join(pluginDir, "src", "index.js"),
      `export default class EnvPlugin {
        name = "";
        async init(config) { this._config = config; }
        getToolDefinitions() { return []; }
        async executeTool() { return this._config.secret; }
      }`
    );
    const result = await loadPlugins(pluginsDir);
    expect(result).toHaveLength(1);
    const output = await result[0].executeTool("dummy", {});
    expect(output).toBe("s3cret");
    delete process.env.__TEST_PLUGIN_SECRET;
  });

  it("continues loading other plugins when one fails", async () => {
    // Bad plugin — syntax error
    const badDir = join(pluginsDir, "aaa-bad");
    mkdirSync(join(badDir, "src"), { recursive: true });
    writeFileSync(join(badDir, "config.yaml"), "enabled: true\n");
    writeFileSync(join(badDir, "src", "index.js"), "THIS IS NOT VALID JS }{}{");

    // Good plugin (sorted after bad alphabetically)
    const goodDir = join(pluginsDir, "zzz-good");
    mkdirSync(join(goodDir, "src"), { recursive: true });
    writeFileSync(join(goodDir, "config.yaml"), "enabled: true\n");
    writeFileSync(join(goodDir, "src", "index.js"),
      `export default class GoodPlugin {
        name = "";
        async init() {}
        getToolDefinitions() { return []; }
        async executeTool() { return "ok"; }
      }`
    );
    const result = await loadPlugins(pluginsDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("zzz-good");
  });
});
