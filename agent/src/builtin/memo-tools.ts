import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolPlugin, ToolDefinition } from "../agent/tool-plugin.js";

const REQUEST_TIMEOUT = 30_000;

interface MemoSearchResult {
  id: string;
  repo_name: string;
  source_file: string;
  content: string;
  summary: string;
  entry_type: string;
  score: number;
}

interface MemoSearchResponse {
  results: MemoSearchResult[];
}

export class MemoToolsPlugin implements ToolPlugin {
  name = "memo-tools";
  private memoUrl: string;
  private dataDir: string;

  constructor(memoUrl: string, dataDir: string) {
    this.memoUrl = memoUrl;
    this.dataDir = dataDir;
  }

  async init(): Promise<void> {
    try {
      const resp = await fetch(`${this.memoUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) console.log(`[memo-tools] Memo service reachable at ${this.memoUrl}`);
    } catch {
      console.warn(`[memo-tools] Memo service not reachable at ${this.memoUrl} — search will fail`);
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "memory_search",
        description: "Search project knowledge base for relevant information about code changes, past Q&A, and project history",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_memory",
        description: "Get the project-level overview (MEMORY.md) — a summary of what the project is about and key knowledge",
        input_schema: { type: "object", properties: {} },
      },
    ];
  }

  getCheapTools(): string[] {
    return ["get_memory"];
  }

  summarizeInput(name: string, input: Record<string, any>): string {
    if (name === "memory_search") return `"${input.query}"`;
    return "";
  }

  async executeTool(name: string, input: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case "memory_search": return await this.memorySearch(input.query);
        case "get_memory": return this.getMemory();
        default: return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  private async memorySearch(query: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const resp = await fetch(`${this.memoUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 5 }),
        signal: controller.signal,
      });
      if (!resp.ok) return `Memory search failed: ${resp.status}`;
      const data = (await resp.json()) as MemoSearchResponse;
      if (data.results.length === 0) return "No relevant knowledge found.";
      return data.results
        .map((r) => `[${r.entry_type}] ${r.source_file}: ${r.summary}\n${r.content}`)
        .join("\n\n---\n\n");
    } catch (e: any) {
      if (e.name === "AbortError") return "Memory search timed out.";
      return "Memory search unavailable.";
    } finally {
      clearTimeout(timeout);
    }
  }

  private getMemory(): string {
    const memoryPath = join(this.dataDir, "MEMORY.md");
    try {
      return readFileSync(memoryPath, "utf-8");
    } catch {
      return "No project memory found. The knowledge base will be populated as the system tracks changes.";
    }
  }
}
