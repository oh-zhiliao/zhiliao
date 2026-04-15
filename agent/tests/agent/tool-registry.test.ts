import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/agent/tool-registry.js";
import type { ToolPlugin, PluginCommandHandler, PluginContext, CommandCallContext } from "../../src/agent/tool-plugin.js";

function makePlugin(name: string, tools: string[], cheapTools: string[] = []): ToolPlugin {
  return {
    name,
    init: vi.fn(),
    getToolDefinitions: () => tools.map(t => ({
      name: t,
      description: `${name} ${t} tool`,
      input_schema: { type: "object", properties: {} },
    })),
    executeTool: vi.fn().mockImplementation(async (toolName: string) => `${name}:${toolName} result`),
    getCheapTools: () => cheapTools,
    summarizeInput: vi.fn().mockImplementation((toolName: string, input: Record<string, any>) =>
      `${toolName}(${JSON.stringify(input)})`
    ),
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers builtin plugin without prefix", () => {
    registry.register(makePlugin("builtin", ["list_repos", "git_search"]));
    const defs = registry.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(["list_repos", "git_search"]);
  });

  it("registers external plugin with folder prefix", () => {
    registry.register(makePlugin("cls-query", ["search", "aggregate"]));
    const defs = registry.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(["cls-query.search", "cls-query.aggregate"]);
  });

  it("combines builtin and external tools", () => {
    registry.register(makePlugin("builtin", ["list_repos"]));
    registry.register(makePlugin("cls-query", ["search"]));
    const names = registry.getToolDefinitions().map(d => d.name);
    expect(names).toEqual(["list_repos", "cls-query.search"]);
  });

  it("routes unprefixed tool to builtin plugin", async () => {
    const builtin = makePlugin("builtin", ["list_repos"]);
    registry.register(builtin);
    const result = await registry.executeTool("list_repos", {});
    expect(builtin.executeTool).toHaveBeenCalledWith("list_repos", {});
    expect(result).toBe("builtin:list_repos result");
  });

  it("routes prefixed tool to correct external plugin", async () => {
    const plugin = makePlugin("cls-query", ["search"]);
    registry.register(plugin);
    const result = await registry.executeTool("cls-query.search", { query: "error" });
    expect(plugin.executeTool).toHaveBeenCalledWith("search", { query: "error" });
    expect(result).toBe("cls-query:search result");
  });

  it("returns error for unknown tool", async () => {
    registry.register(makePlugin("builtin", ["list_repos"]));
    const result = await registry.executeTool("nonexistent", {});
    expect(result).toContain("Unknown tool");
  });

  it("returns error for unknown plugin prefix", async () => {
    const result = await registry.executeTool("unknown-plugin.search", {});
    expect(result).toContain("Unknown plugin");
  });

  it("aggregates cheap tools with correct prefixes", () => {
    registry.register(makePlugin("builtin", ["list_repos", "git_search"], ["list_repos", "git_search"]));
    registry.register(makePlugin("cls-query", ["search", "aggregate"], ["search"]));
    expect(registry.isCheapTool("list_repos")).toBe(true);
    expect(registry.isCheapTool("git_search")).toBe(true);
    expect(registry.isCheapTool("cls-query.search")).toBe(true);
    expect(registry.isCheapTool("cls-query.aggregate")).toBe(false);
    expect(registry.isCheapTool("memory_search")).toBe(false);
  });

  it("delegates summarizeToolInput to correct plugin", () => {
    const builtin = makePlugin("builtin", ["list_repos"]);
    const plugin = makePlugin("cls-query", ["search"]);
    registry.register(builtin);
    registry.register(plugin);
    registry.summarizeToolInput("cls-query.search", { query: "error" });
    expect(plugin.summarizeInput).toHaveBeenCalledWith("search", { query: "error" });
  });

  it("falls back to JSON.stringify for plugins without summarizeInput", () => {
    const plugin = makePlugin("cls-query", ["search"]);
    delete (plugin as any).summarizeInput;
    registry.register(plugin);
    const result = registry.summarizeToolInput("cls-query.search", { query: "x" });
    expect(result).toBe('{"query":"x"}');
  });

  it("concatenates system prompt addendums", () => {
    const p1 = makePlugin("cls-query", ["search"]);
    p1.getSystemPromptAddendum = () => "CLS tools available.";
    const p2 = makePlugin("k8s", ["status"]);
    p2.getSystemPromptAddendum = () => "K8s tools available.";
    registry.register(p1);
    registry.register(p2);
    const addendum = registry.getSystemPromptAddendum();
    expect(addendum).toContain("CLS tools available.");
    expect(addendum).toContain("K8s tools available.");
  });

  it("merges secret patterns from all plugins", () => {
    const p1 = makePlugin("cls-query", ["search"]);
    p1.getSecretPatterns = () => [/TENCENTCLOUD_SECRET/g];
    const p2 = makePlugin("k8s", ["status"]);
    p2.getSecretPatterns = () => [/KUBE_TOKEN/g];
    registry.register(p1);
    registry.register(p2);
    expect(registry.getSecretPatterns()).toHaveLength(2);
  });

  it("calls destroyAll on all plugins with destroy method", async () => {
    const p1 = makePlugin("builtin", ["list_repos"]);
    p1.destroy = vi.fn();
    const p2 = makePlugin("cls-query", ["search"]);
    p2.destroy = vi.fn();
    registry.register(p1);
    registry.register(p2);
    await registry.destroyAll();
    expect(p1.destroy).toHaveBeenCalled();
    expect(p2.destroy).toHaveBeenCalled();
  });

  it("throws on duplicate plugin name", () => {
    registry.register(makePlugin("cls-query", ["search"]));
    expect(() => registry.register(makePlugin("cls-query", ["other"]))).toThrow("already registered");
  });
});

function makePluginWithCommands(
  name: string,
  tools: string[],
  commands: PluginCommandHandler
): ToolPlugin {
  const p = makePlugin(name, tools);
  p.getCommandHandlers = () => commands;
  return p;
}

describe("ToolRegistry command routing", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("routes command to correct plugin handler", async () => {
    const handler = vi.fn().mockResolvedValue("repo list result");
    const plugin = makePluginWithCommands("git-repos", ["list_repos"], {
      subcommands: {
        list: { description: "List repos", handle: handler },
      },
    });
    registry.register(plugin);

    const ctx: CommandCallContext = { userId: "u1", chatType: "p2p", chatId: "c1", logId: "log1" };
    const result = await registry.handleCommand("git-repos", "list", [], ctx);
    expect(result).toBe("repo list result");
    expect(handler).toHaveBeenCalledWith([], ctx);
  });

  it("returns null for unknown plugin command", async () => {
    const ctx: CommandCallContext = { userId: "u1", chatType: "p2p", chatId: "c1", logId: "log1" };
    const result = await registry.handleCommand("nonexistent", "list", [], ctx);
    expect(result).toBeNull();
  });

  it("returns null for plugin without command handlers", async () => {
    registry.register(makePlugin("cls-query", ["search"]));
    const ctx: CommandCallContext = { userId: "u1", chatType: "p2p", chatId: "c1", logId: "log1" };
    const result = await registry.handleCommand("cls-query", "search", [], ctx);
    expect(result).toBeNull();
  });

  it("returns null for unknown subcommand", async () => {
    const plugin = makePluginWithCommands("git-repos", ["list_repos"], {
      subcommands: {
        list: { description: "List repos", handle: vi.fn() },
      },
    });
    registry.register(plugin);

    const ctx: CommandCallContext = { userId: "u1", chatType: "p2p", chatId: "c1", logId: "log1" };
    const result = await registry.handleCommand("git-repos", "unknown", [], ctx);
    expect(result).toBeNull();
  });
});

describe("ToolRegistry lifecycle", () => {
  it("calls startAll on all plugins with start method", async () => {
    const registry = new ToolRegistry();
    const p1 = makePlugin("builtin", ["list_repos"]);
    p1.start = vi.fn();
    const p2 = makePlugin("cls-query", ["search"]);
    // p2 has no start — should be skipped
    registry.register(p1);
    registry.register(p2);

    const ctx: PluginContext = { sendFeishuMessage: vi.fn() };
    await registry.startAll(ctx);
    expect(p1.start).toHaveBeenCalledWith(ctx);
  });

  it("calls stopAll on all plugins with stop method", async () => {
    const registry = new ToolRegistry();
    const p1 = makePlugin("builtin", ["list_repos"]);
    p1.stop = vi.fn();
    registry.register(p1);

    await registry.stopAll();
    expect(p1.stop).toHaveBeenCalled();
  });
});

describe("ToolRegistry filterOutput", () => {
  it("filterOutput chains all plugin filters", () => {
    const plugin1 = makePlugin("p1", ["tool1"]);
    plugin1.filterOutput = (text: string) => text.replace(/SECRET1/g, "[FILTERED]");
    const plugin2 = makePlugin("p2", ["tool2"]);
    plugin2.filterOutput = (text: string) => text.replace(/SECRET2/g, "[FILTERED]");
    const registry = new ToolRegistry();
    registry.register(plugin1);
    registry.register(plugin2);

    const result = registry.filterOutput("contains SECRET1 and SECRET2 here");
    expect(result).toBe("contains [FILTERED] and [FILTERED] here");
  });

  it("filterOutput works with no plugins having filter", () => {
    const plugin = makePlugin("p1", ["tool1"]);
    // No filterOutput defined
    const registry = new ToolRegistry();
    registry.register(plugin);

    const result = registry.filterOutput("unchanged text");
    expect(result).toBe("unchanged text");
  });
});
