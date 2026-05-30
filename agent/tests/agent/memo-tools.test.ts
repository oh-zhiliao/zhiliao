import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoToolsPlugin } from "../../src/builtin/memo-tools.js";
import type { RequestContext } from "../../src/agent/request-context.js";

describe("MemoToolsPlugin", () => {
  const requestContext: RequestContext = {
    channel: "feishu",
    chatType: "group",
    chatId: "oc_group_1",
    userId: "ou_user_1",
    role: "complaint",
    logId: "log1",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the current role to memory search", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);
    const plugin = new MemoToolsPlugin("http://localhost:8090", "/tmp/memo-test");

    await plugin.executeTool("memory_search", { query: "auth" }, requestContext);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "auth", limit: 5, role: "complaint" }),
      }),
    );
  });

  it("passes the current role to memory save", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: "saved-id", status: "saved" }),
    } as Response);
    const plugin = new MemoToolsPlugin("http://localhost:8090", "/tmp/memo-test");

    await plugin.executeTool(
      "memory_save",
      { repo_name: "proj", summary: "auth fact", content: "fact" },
      requestContext,
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/save",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repo_name: "proj",
          source: "chat",
          summary: "auth fact",
          content: "fact",
          role: "complaint",
        }),
      }),
    );
  });
});
