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
  created_at?: string;
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
        name: "memory_save",
        description: "Save a verified knowledge entry to the project knowledge base. Use sparingly — only for confirmed facts, corrected errors, or hard-won conclusions. Content will be auto-distilled before storage.",
        input_schema: {
          type: "object",
          properties: {
            repo_name: { type: "string", description: "Which repo this knowledge relates to" },
            summary: { type: "string", description: "One-line summary (under 80 chars)" },
            content: { type: "string", description: "The knowledge to save (under 500 chars, factual, no raw tool output)" },
          },
          required: ["repo_name", "summary", "content"],
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
    if (name === "memory_save") return `${input.repo_name}: "${input.summary}"`;
    return "";
  }

  async executeTool(name: string, input: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case "memory_search": return await this.memorySearch(input.query);
        case "memory_save": return await this.memorySave(input.repo_name, input.summary, input.content);
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
        .map((r) => {
          const time = r.created_at ? ` (${r.created_at.slice(0, 10)})` : "";
          return `[${r.entry_type}${time}] ${r.source_file}: ${r.summary}\n${r.content}`;
        })
        .join("\n\n---\n\n");
    } catch (e: any) {
      if (e.name === "AbortError") return "Memory search timed out.";
      return "Memory search unavailable.";
    } finally {
      clearTimeout(timeout);
    }
  }

  private async memorySave(repoName: string, summary: string, content: string): Promise<string> {
    if (content.length > 500) {
      content = content.slice(0, 500);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const resp = await fetch(`${this.memoUrl}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_name: repoName, source: "chat", summary, content }),
        signal: controller.signal,
      });
      if (!resp.ok) return `Save failed: ${resp.status}`;
      const data = await resp.json() as { id: string; status: string };
      return `Saved: ${data.id}`;
    } catch (e: any) {
      if (e.name === "AbortError") return "Save timed out.";
      return `Save failed: ${e.message}`;
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
