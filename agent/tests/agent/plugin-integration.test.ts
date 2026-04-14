import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/agent/tool-registry.js";
import type { ToolPlugin } from "../../src/agent/tool-plugin.js";

class MockBuiltinPlugin implements ToolPlugin {
  name = "";

  async init(_config: Record<string, any>): Promise<void> {}

  getToolDefinitions() {
    return [
      {
        name: "list_repos",
        description: "List tracked repos",
        input_schema: { type: "object" as const, properties: {} },
      },
      {
        name: "git_file_read",
        description: "Read a file from a repo",
        input_schema: {
          type: "object" as const,
          properties: { repo: { type: "string" }, path: { type: "string" } },
          required: ["repo", "path"],
        },
      },
    ];
  }

  async executeTool(name: string, _input: Record<string, any>): Promise<string> {
    if (name === "list_repos") return "Repos:\n- proj (main)";
    if (name === "git_file_read") return "file contents";
    return `Unknown tool: ${name}`;
  }

  getCheapTools(): string[] { return ["list_repos", "git_file_read"]; }
}

class MockCLSPlugin implements ToolPlugin {
  name = "";

  async init(_config: Record<string, any>): Promise<void> {}

  getToolDefinitions() {
    return [
      {
        name: "search",
        description: "Search CLS logs",
        input_schema: {
          type: "object" as const,
          properties: {
            topic: { type: "string", description: "Topic name" },
            query: { type: "string", description: "CQL query" },
          },
          required: ["topic", "query"],
        },
      },
    ];
  }

  async executeTool(name: string, input: Record<string, any>): Promise<string> {
    if (name === "search") {
      return `Found 3 log entries for query "${input.query}" in topic "${input.topic}"`;
    }
    return `Unknown tool: ${name}`;
  }

  getCheapTools(): string[] { return []; }

  summarizeInput(name: string, input: Record<string, any>): string {
    return `${input.topic}: "${input.query}"`;
  }

  getSystemPromptAddendum(): string {
    return "You have access to CLS log search. Use cls-query.search to find logs.";
  }

  getSecretPatterns(): RegExp[] {
    return [/TENCENTCLOUD_SECRET_KEY\s*=\s*\S+/g];
  }
}

describe("Plugin Integration", () => {
  it("multiple plugins coexist in registry", async () => {
    const gitPlugin = new MockBuiltinPlugin();
    gitPlugin.name = "git-tools";

    const clsPlugin = new MockCLSPlugin();
    clsPlugin.name = "cls-query";

    const registry = new ToolRegistry();
    registry.register(gitPlugin);
    registry.register(clsPlugin);

    // Tool definitions include both plugins with namespace prefixes
    const defs = registry.getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain("git-tools.list_repos");
    expect(names).toContain("git-tools.git_file_read");
    expect(names).toContain("cls-query.search");

    // Git plugin tool works with prefix routing
    const repoList = await registry.executeTool("git-tools.list_repos", {});
    expect(repoList).toContain("proj");

    // CLS plugin tool works with prefix routing
    const clsResult = await registry.executeTool("cls-query.search", {
      topic: "backend",
      query: "level:ERROR",
    });
    expect(clsResult).toContain("3 log entries");
    expect(clsResult).toContain("level:ERROR");

    // Cheap tool checks
    expect(registry.isCheapTool("git-tools.list_repos")).toBe(true);
    expect(registry.isCheapTool("cls-query.search")).toBe(false);

    // System prompt addendum
    expect(registry.getSystemPromptAddendum()).toContain("CLS log search");

    // Secret patterns
    expect(registry.getSecretPatterns()).toHaveLength(1);

    // Summarize delegates to correct plugin
    const summary = registry.summarizeToolInput("cls-query.search", { topic: "backend", query: "error" });
    expect(summary).toBe('backend: "error"');
  });
});
