/**
 * E2E regression test via HTTP API channel.
 * Catches: SQL alias mismatches, config errors, session persistence bugs, command crashes.
 *
 * Run: npx vitest run tests/e2e/
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { createApiServer } from "../../src/api-server.js";
import { ZhiliaoDB } from "../../src/db.js";
import { ToolRegistry } from "../../src/agent/tool-registry.js";
import { AgentInvoker } from "../../src/agent/invoker.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolPlugin, PluginCommandHandler, CommandCallContext } from "../../src/agent/tool-plugin.js";

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

/** Minimal plugin that handles /repo and /status commands for testing. */
class MockRepoPlugin implements ToolPlugin {
  name = "repo";
  private admins: string[];

  constructor(admins: string[]) {
    this.admins = admins;
  }

  async init() {}
  getToolDefinitions() { return []; }
  async executeTool() { return ""; }

  getCommandHandlers(): PluginCommandHandler {
    return {
      subcommands: {
        list: {
          description: "列出仓库",
          handle: async () => {
            return "没有已注册的仓库";
          },
        },
        add: {
          description: "添加仓库",
          handle: async (args: string[], ctx: CommandCallContext) => {
            if (!this.admins.includes(ctx.userId)) {
              return `权限不足 [logId: ${ctx.logId}]`;
            }
            return `已添加仓库: ${args[0]}`;
          },
        },
      },
    };
  }
}

class MockStatusPlugin implements ToolPlugin {
  name = "status";

  async init() {}
  getToolDefinitions() { return []; }
  async executeTool() { return ""; }

  getCommandHandlers(): PluginCommandHandler {
    return {
      subcommands: {
        "": {
          description: "系统状态",
          handle: async () => {
            return `知了状态:\n- 已注册仓库: 0\n- 服务运行中`;
          },
        },
      },
    };
  }
}

let testDir: string;
let db: ZhiliaoDB;
let app: ReturnType<typeof createApiServer>;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "zhiliao-e2e-"));
  db = new ZhiliaoDB(join(testDir, "test.sqlite"));

  const agent = new AgentInvoker({
    apiKey: "test-key",
    model: "test-model",
    systemPrompt: "You are a test assistant.",
    memoUrl: "http://localhost:0",
  });
  agent.setDB(db);

  const toolRegistry = new ToolRegistry();
  const repoPlugin = new MockRepoPlugin(["test_admin"]);
  toolRegistry.register(repoPlugin);
  const statusPlugin = new MockStatusPlugin();
  toolRegistry.register(statusPlugin);

  app = createApiServer({ agent, toolRegistry });

  // Default LLM mock: return simple text
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: "这是测试回复。" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  });
});

afterAll(() => {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("E2E: API channel regression", () => {
  it("GET /api/health returns ok", async () => {
    const res = await supertest(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/help returns command list", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/help", user_id: "test_admin" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("command");
    expect(res.body.response).toContain("知了");
    expect(res.body.response).toContain("/new");
    expect(res.body.response).toContain("/context");
  });

  it("/status returns system status", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/status", user_id: "test_admin" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("command");
    expect(res.body.response).toContain("服务运行中");
  });

  it("/context with no session returns no-session message", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/context", session_key: "e2e:fresh" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("没有活跃会话");
  });

  it("ask a question and get response", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "gigi项目用什么语言？", session_key: "e2e:chat1", user_id: "test_admin" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("question");
    expect(res.body.response).toContain("测试回复");
  });

  it("/context after question shows session stats", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/context", session_key: "e2e:chat1" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("消息数");
    expect(res.body.response).toContain("100");
  });

  it("/new clears session and shows stats", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/new", session_key: "e2e:chat1" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("会话已重置");
  });

  it("/new on empty session says no session", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/new", session_key: "e2e:empty" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("没有活跃会话");
  });

  it("session persists across calls (DB-backed)", async () => {
    // First question
    await supertest(app)
      .post("/api/chat")
      .send({ text: "第一个问题", session_key: "e2e:persist", user_id: "test_admin" });

    // Second question
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "第二个回复" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 100 },
    });
    await supertest(app)
      .post("/api/chat")
      .send({ text: "第二个问题", session_key: "e2e:persist", user_id: "test_admin" });

    // Check context - should show accumulated stats
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/context", session_key: "e2e:persist" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("300"); // 100 + 200 input tokens
  });

  it("/repo list returns repos (empty)", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/repo list", user_id: "test_admin" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("command");
    expect(res.body.response).toContain("没有已注册的仓库");
  });

  it("unknown command returns error", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/foobar" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("未知命令");
  });

  it("missing text returns 400", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("/repo list works for non-admin users", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/repo list", user_id: "regular_user_not_admin" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("command");
    // Should NOT contain permission error — /repo list is open to all users
    expect(res.body.response).not.toContain("权限不足");
  });

  it("returns 500 when agent throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("LLM service unavailable"));
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "trigger error", session_key: "e2e:error" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  it("/repo add blocked for non-admin", async () => {
    const res = await supertest(app)
      .post("/api/chat")
      .send({ text: "/repo add https://github.com/test/repo.git", user_id: "regular_user" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("权限不足");
  });
});
