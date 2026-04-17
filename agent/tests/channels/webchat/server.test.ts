import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { hashSync, compareSync } from "bcryptjs";
import jwt from "jsonwebtoken";
import type { WebChatConfig } from "../../../src/channels/webchat/server.js";
import { WebChatChannel } from "../../../src/channels/webchat/channel.js";

const TEST_PASSWORD = "test-password";
const TEST_JWT_SECRET = "test-secret-key-for-jwt";

describe("WebChatConfig", () => {
  const config: WebChatConfig = {
    port: 0,
    passwordHash: hashSync(TEST_PASSWORD, 10),
    jwtSecret: TEST_JWT_SECRET,
  };

  it("has required fields", () => {
    expect(config.port).toBeDefined();
    expect(config.passwordHash).toBeDefined();
    expect(config.jwtSecret).toBeDefined();
  });

  it("bcrypt hash matches correct password", () => {
    expect(compareSync(TEST_PASSWORD, config.passwordHash)).toBe(true);
  });

  it("bcrypt hash rejects wrong password", () => {
    expect(compareSync("wrong-password", config.passwordHash)).toBe(false);
  });

  it("JWT sign and verify round-trip", () => {
    const token = jwt.sign({ sub: "webchat_user" }, config.jwtSecret, {
      expiresIn: "1h",
      audience: "session",
    });
    const decoded = jwt.verify(token, config.jwtSecret, { audience: "session" }) as jwt.JwtPayload;
    expect(decoded.sub).toBe("webchat_user");
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("JWT verify rejects invalid token", () => {
    expect(() => jwt.verify("invalid.token.here", config.jwtSecret)).toThrow();
  });

  it("JWT verify rejects wrong secret", () => {
    const token = jwt.sign({ sub: "webchat_user" }, config.jwtSecret, { audience: "session" });
    expect(() => jwt.verify(token, "wrong-secret")).toThrow();
  });
});

describe("WebChatChannel", () => {
  it("returns correct session key", () => {
    const channel = new WebChatChannel();
    const ctx = {
      channelName: "webchat",
      userId: "webchat_user",
      sessionKey: "",
      extra: { sessionId: "abc123" },
    };
    expect(channel.getSessionKey(ctx)).toBe("webchat:abc123");
  });

  it("supports streaming", () => {
    const channel = new WebChatChannel();
    expect(channel.supportsStreaming()).toBe(true);
  });

  it("has name webchat", () => {
    const channel = new WebChatChannel();
    expect(channel.name).toBe("webchat");
  });

  it("register and unregister socket", () => {
    const channel = new WebChatChannel();
    const mockWs = { readyState: 1, send: vi.fn() } as any;

    channel.registerSocket("sess1", mockWs);
    expect(channel.getSocket("sess1")).toBe(mockWs);

    channel.unregisterSocket("sess1");
    expect(channel.getSocket("sess1")).toBeUndefined();
  });

  it("sendReply sends message_complete via WebSocket", async () => {
    const channel = new WebChatChannel();
    const mockWs = { readyState: 1, send: vi.fn() } as any;
    channel.registerSocket("sess1", mockWs);

    const ctx = {
      channelName: "webchat",
      userId: "webchat_user",
      sessionKey: "webchat:sess1",
      extra: { sessionId: "sess1" },
    };

    await channel.sendReply(ctx, "Hello world");
    expect(mockWs.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("message_complete");
    expect(sent.sessionId).toBe("sess1");
    expect(sent.content).toBe("Hello world");
  });

  it("sendReply skips when socket is not open", async () => {
    const channel = new WebChatChannel();
    const mockWs = { readyState: 3, send: vi.fn() } as any; // CLOSED
    channel.registerSocket("sess1", mockWs);

    const ctx = {
      channelName: "webchat",
      userId: "webchat_user",
      sessionKey: "webchat:sess1",
      extra: { sessionId: "sess1" },
    };

    await channel.sendReply(ctx, "Hello");
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it("sendReply skips when no socket registered", async () => {
    const channel = new WebChatChannel();
    const ctx = {
      channelName: "webchat",
      userId: "webchat_user",
      sessionKey: "webchat:unknown",
      extra: { sessionId: "unknown" },
    };
    // Should not throw
    await channel.sendReply(ctx, "Hello");
  });

  it("sendStreamDelta sends delta via WebSocket", async () => {
    const channel = new WebChatChannel();
    const mockWs = { readyState: 1, send: vi.fn() } as any;
    channel.registerSocket("sess1", mockWs);

    const ctx = {
      channelName: "webchat",
      userId: "webchat_user",
      sessionKey: "webchat:sess1",
      extra: { sessionId: "sess1" },
    };

    await channel.sendStreamDelta(ctx, { type: "text_delta", content: "chunk" });
    expect(mockWs.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("text_delta");
    expect(sent.content).toBe("chunk");
    expect(sent.sessionId).toBe("sess1");
  });

  it("sendProgress is a no-op", async () => {
    const channel = new WebChatChannel();
    const ctx = {
      channelName: "webchat",
      userId: "webchat_user",
      sessionKey: "webchat:sess1",
      extra: { sessionId: "sess1" },
    };
    // Should not throw
    await channel.sendProgress(ctx, "doing stuff");
  });
});

describe("createWebChatServer HTTP endpoints", () => {
  let server: { start: () => void; stop: () => void };
  let baseUrl: string;
  let httpServer: any;

  const config: WebChatConfig = {
    port: 0, // random port
    passwordHash: hashSync(TEST_PASSWORD, 10),
    jwtSecret: TEST_JWT_SECRET,
  };

  // Minimal mock of AgentInvoker
  const mockAgent = {
    clearSession: vi.fn(),
    ask: vi.fn().mockResolvedValue({ text: "mock response", sessionId: "test" }),
    askStreaming: vi.fn().mockResolvedValue("mock response"),
  } as any;

  // Minimal mock of ToolRegistry
  const mockToolRegistry = {
    filterOutput: vi.fn((t: string) => t),
    getToolDefinitions: vi.fn(() => []),
    getSecretPatterns: vi.fn(() => []),
    getSystemPromptAddendum: vi.fn(() => ""),
    handleCommand: vi.fn().mockResolvedValue(null),
  } as any;

  // Minimal mock of ChannelRouter
  const mockRouter = {
    handleMessage: vi.fn(),
  } as any;

  beforeAll(async () => {
    // Dynamically import to avoid module-level side effects
    const { createWebChatServer } = await import("../../../src/channels/webchat/server.js");
    server = createWebChatServer(config, mockRouter, mockAgent, mockToolRegistry, []);

    // Start on random port and capture URL
    await new Promise<void>((resolve) => {
      // Access internal server via the start function — we need to intercept the listen
      // Instead, we call start() which uses config.port=0 for random port
      server.start();
      // Give it a tick to bind
      setTimeout(() => resolve(), 100);
    });

    // We need to get the actual port. Since createWebChatServer encapsulates
    // the http.Server, let's use a different approach: test via supertest-like fetch
    // Actually, port 0 means the OS assigns a random port. We need to access
    // the server's address. Let's re-create with a known port for testing.
    server.stop();

    // Recreate with a specific port approach — use dynamic import
    const { createServer } = await import("http");
    const express = (await import("express")).default;

    // Just test the HTTP endpoints directly via fetch against a real server
    const testPort = 19876 + Math.floor(Math.random() * 1000);
    const configWithPort: WebChatConfig = { ...config, port: testPort };
    server = createWebChatServer(configWithPort, mockRouter, mockAgent, mockToolRegistry, []);

    await new Promise<void>((resolve) => {
      server.start();
      setTimeout(() => resolve(), 200);
    });

    baseUrl = `http://127.0.0.1:${testPort}`;
  });

  afterAll(() => {
    server?.stop();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/health returns ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("POST /api/auth/login with correct password returns token", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    // Verify the token is valid
    const decoded = jwt.verify(body.token, TEST_JWT_SECRET) as jwt.JwtPayload;
    expect(decoded.sub).toBe("webchat_user");
  });

  it("POST /api/auth/login with wrong password returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid password");
  });

  it("POST /api/auth/login with no password returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/sessions/:id with valid token clears session", async () => {
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const res = await fetch(`${baseUrl}/api/sessions/test-session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockAgent.clearSession).toHaveBeenCalledWith("webchat:test-session");
  });

  it("DELETE /api/sessions/:id without token returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-session`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/sessions/:id with invalid token returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-session`, {
      method: "DELETE",
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    expect(res.status).toBe(401);
  });

  // P0 regression: a signed oauth_state JWT must NOT be usable as a session Bearer token.
  // Before the audience-scoped fix, the state JWT (5m, same secret, HS256) passed
  // verifyToken and let an attacker DELETE arbitrary sessions.
  it("DELETE /api/sessions/:id rejects oauth_state JWT as Bearer token", async () => {
    const stateJwt = jwt.sign({ nonce: "attacker" }, TEST_JWT_SECRET, {
      expiresIn: "5m",
      audience: "oauth_state",
    });
    const res = await fetch(`${baseUrl}/api/sessions/target-session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${stateJwt}` },
    });
    expect(res.status).toBe(401);
    expect(mockAgent.clearSession).not.toHaveBeenCalled();
  });
});

describe("createWebChatServer WebSocket", () => {
  let server: { start: () => void; stop: () => void };
  let baseUrl: string;
  let wsUrl: string;
  let testPort: number;

  const config: WebChatConfig = {
    port: 0,
    passwordHash: hashSync(TEST_PASSWORD, 10),
    jwtSecret: TEST_JWT_SECRET,
  };

  const mockAgent = {
    clearSession: vi.fn(),
    ask: vi.fn().mockResolvedValue({ text: "mock response", sessionId: "test" }),
    askStreaming: vi.fn().mockImplementation(async (_q: string, _s: string, callbacks: any) => {
      callbacks.onTextDelta?.("hello ");
      callbacks.onComplete?.("hello world");
      return "hello world";
    }),
  } as any;

  const mockToolRegistry = {
    filterOutput: vi.fn((t: string) => t),
    getToolDefinitions: vi.fn(() => []),
    getSecretPatterns: vi.fn(() => []),
    getSystemPromptAddendum: vi.fn(() => ""),
    handleCommand: vi.fn().mockResolvedValue(null),
  } as any;

  const mockRouter = {
    handleMessage: vi.fn(),
  } as any;

  beforeAll(async () => {
    const { createWebChatServer } = await import("../../../src/channels/webchat/server.js");
    testPort = 19876 + Math.floor(Math.random() * 1000);
    const configWithPort: WebChatConfig = { ...config, port: testPort };
    server = createWebChatServer(configWithPort, mockRouter, mockAgent, mockToolRegistry, []);

    await new Promise<void>((resolve) => {
      server.start();
      setTimeout(() => resolve(), 200);
    });

    baseUrl = `http://127.0.0.1:${testPort}`;
    wsUrl = `ws://127.0.0.1:${testPort}`;
  });

  afterAll(() => {
    server?.stop();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects WebSocket connection without token", async () => {
    const { WebSocket: WS } = await import("ws");
    const ws = new WS(`${wsUrl}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on("close", (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on("error", () => {
        // Connection refused or closed is expected
        resolve();
      });
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  });

  it("rejects WebSocket connection with invalid token", async () => {
    const { WebSocket: WS } = await import("ws");
    const ws = new WS(`${wsUrl}/ws?token=invalid.jwt.token`);

    await new Promise<void>((resolve, reject) => {
      ws.on("close", (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on("error", () => resolve());
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  });

  // P0 regression: oauth_state JWT must NOT authorize a WebSocket connection.
  it("rejects WebSocket connection presenting an oauth_state JWT", async () => {
    const { WebSocket: WS } = await import("ws");
    const stateJwt = jwt.sign({ nonce: "attacker" }, TEST_JWT_SECRET, {
      expiresIn: "5m",
      audience: "oauth_state",
    });
    const ws = new WS(`${wsUrl}/ws?token=${stateJwt}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("close", (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on("error", () => resolve());
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  });

  it("accepts WebSocket connection with valid token", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const ws = new WS(`${wsUrl}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", (err) => reject(err));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  });

  it("handles message and receives streaming response", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const ws = new WS(`${wsUrl}/ws?token=${token}`);

    const messages: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "message",
          sessionId: "test-session-1",
          content: "hello",
        }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        // Wait for message_complete
        if (msg.type === "message_complete") {
          ws.close();
          resolve();
        }
      });

      ws.on("error", (err) => reject(err));
      setTimeout(() => {
        ws.close();
        reject(new Error("timeout waiting for response"));
      }, 5000);
    });

    // Should have received text_delta and message_complete
    expect(messages.some(m => m.type === "text_delta")).toBe(true);
    expect(messages.some(m => m.type === "message_complete")).toBe(true);
    expect(mockAgent.askStreaming).toHaveBeenCalled();
  });

  it("handles history request", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const ws = new WS(`${wsUrl}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "history",
          sessionId: "test-session-2",
        }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        expect(msg.type).toBe("history");
        expect(msg.sessionId).toBe("test-session-2");
        expect(msg.messages).toEqual([]);
        ws.close();
        resolve();
      });

      ws.on("error", (err) => reject(err));
      setTimeout(() => {
        ws.close();
        reject(new Error("timeout"));
      }, 3000);
    });
  });

  it("handles invalid JSON gracefully", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const ws = new WS(`${wsUrl}/ws?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send("not valid json{{{");
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        expect(msg.type).toBe("error");
        expect(msg.message).toBe("Invalid JSON");
        ws.close();
        resolve();
      });

      ws.on("error", (err) => reject(err));
      setTimeout(() => {
        ws.close();
        reject(new Error("timeout"));
      }, 3000);
    });
  });

  it("routes commands through ChannelRouter", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const ws = new WS(`${wsUrl}/ws?token=${token}`);

    // Make handleMessage resolve and send a reply
    mockRouter.handleMessage.mockImplementation(async (ch: any, ctx: any, _text: string) => {
      await ch.sendReply(ctx, "command result");
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "message",
          sessionId: "cmd-session",
          content: "/help",
        }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "message_complete") {
          expect(msg.content).toBe("command result");
          ws.close();
          resolve();
        }
      });

      ws.on("error", (err) => reject(err));
      setTimeout(() => {
        ws.close();
        reject(new Error("timeout"));
      }, 3000);
    });

    expect(mockRouter.handleMessage).toHaveBeenCalled();
  });

  it("rejects duplicate session messages", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h", audience: "session" });
    const ws = new WS(`${wsUrl}/ws?token=${token}`);

    // Make askStreaming hang to simulate a long-running request
    let resolveStreaming: (() => void) | undefined;
    mockAgent.askStreaming.mockImplementation(() =>
      new Promise<string>((resolve) => { resolveStreaming = () => resolve("done"); })
    );

    const messages: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // Send first message
        ws.send(JSON.stringify({
          type: "message",
          sessionId: "dup-session",
          content: "first",
        }));

        // Send duplicate immediately
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "message",
            sessionId: "dup-session",
            content: "second",
          }));
        }, 50);
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === "error" && msg.message === "Already processing") {
          // Release the first streaming call
          resolveStreaming?.();
          setTimeout(() => {
            ws.close();
            resolve();
          }, 100);
        }
      });

      ws.on("error", (err) => reject(err));
      setTimeout(() => {
        resolveStreaming?.();
        ws.close();
        reject(new Error("timeout"));
      }, 5000);
    });

    expect(messages.some(m => m.type === "error" && m.message === "Already processing")).toBe(true);
  });
});

// --- Feishu OAuth2 endpoint tests ---

describe("Feishu OAuth2 endpoints", () => {
  let server: { start: () => void; stop: () => void };
  let baseUrl: string;
  let testPort: number;

  const FEISHU_CONFIG: WebChatConfig = {
    port: 0,
    passwordHash: hashSync(TEST_PASSWORD, 10),
    jwtSecret: TEST_JWT_SECRET,
    feishuAuth: {
      appId: "cli_test_app",
      appSecret: "test_app_secret",
      redirectUri: "http://localhost:9999/api/auth/feishu/callback",
      userIdField: "open_id",
      allowedUsers: [],
    },
  };

  const NO_FEISHU_CONFIG: WebChatConfig = {
    port: 0,
    passwordHash: hashSync(TEST_PASSWORD, 10),
    jwtSecret: TEST_JWT_SECRET,
  };

  const mockAgent = { clearSession: vi.fn(), askStreaming: vi.fn() } as any;
  const mockToolRegistry = { filterOutput: vi.fn((t: string) => t) } as any;
  const mockRouter = { handleMessage: vi.fn() } as any;

  async function startServer(config: WebChatConfig) {
    const { createWebChatServer } = await import("../../../src/channels/webchat/server.js");
    testPort = 29876 + Math.floor(Math.random() * 1000);
    const configWithPort = { ...config, port: testPort };
    server = createWebChatServer(configWithPort, mockRouter, mockAgent, mockToolRegistry, []);
    await new Promise<void>((resolve) => {
      server.start();
      setTimeout(() => resolve(), 200);
    });
    baseUrl = `http://127.0.0.1:${testPort}`;
  }

  afterEach(() => {
    server?.stop();
    vi.clearAllMocks();
  });

  describe("GET /api/auth/feishu/config", () => {
    it("returns enabled:false when feishuAuth is not configured", async () => {
      await startServer(NO_FEISHU_CONFIG);
      const res = await fetch(`${baseUrl}/api/auth/feishu/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
    });

    it("returns enabled:true when feishuAuth is configured", async () => {
      await startServer(FEISHU_CONFIG);
      const res = await fetch(`${baseUrl}/api/auth/feishu/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
    });
  });

  describe("GET /api/auth/feishu/authorize", () => {
    it("redirects to Feishu with state and correct params", async () => {
      await startServer(FEISHU_CONFIG);
      const res = await fetch(`${baseUrl}/api/auth/feishu/authorize`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("accounts.feishu.cn/open-apis/authen/v1/authorize");
      expect(location).toContain("client_id=cli_test_app");
      expect(location).toContain("response_type=code");
      expect(location).toContain("scope=contact%3Auser.base%3Areadonly");

      // Extract and verify state is a valid JWT
      const url = new URL(location);
      const state = url.searchParams.get("state")!;
      const decoded = jwt.verify(state, TEST_JWT_SECRET) as jwt.JwtPayload;
      expect(decoded.nonce).toBeDefined();
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
    });

    it("returns 404 when feishuAuth is not configured", async () => {
      await startServer(NO_FEISHU_CONFIG);
      const res = await fetch(`${baseUrl}/api/auth/feishu/authorize`, { redirect: "manual" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/auth/feishu/callback", () => {
    it("rejects missing state", async () => {
      await startServer(FEISHU_CONFIG);
      const res = await fetch(`${baseUrl}/api/auth/feishu/callback?code=test_code`, { redirect: "manual" });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Missing state");
    });

    it("rejects invalid/expired state", async () => {
      await startServer(FEISHU_CONFIG);
      const res = await fetch(`${baseUrl}/api/auth/feishu/callback?code=test_code&state=garbage`, { redirect: "manual" });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid state");
    });

    it("rejects expired state JWT", async () => {
      await startServer(FEISHU_CONFIG);
      // Create an already-expired state JWT
      const expiredState = jwt.sign({ nonce: "x" }, TEST_JWT_SECRET, {
        expiresIn: "0s",
        audience: "oauth_state",
      });
      // Wait a tick for it to truly expire
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(
        `${baseUrl}/api/auth/feishu/callback?code=test_code&state=${expiredState}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid state");
    });

    it("rejects missing code", async () => {
      await startServer(FEISHU_CONFIG);
      const state = jwt.sign({ nonce: "test" }, TEST_JWT_SECRET, { expiresIn: "5m", audience: "oauth_state" });
      const res = await fetch(
        `${baseUrl}/api/auth/feishu/callback?state=${state}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Missing code");
    });

    it("rejects Feishu error parameter", async () => {
      await startServer(FEISHU_CONFIG);
      const res = await fetch(
        `${baseUrl}/api/auth/feishu/callback?error=access_denied`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("access_denied");
    });

    it("handles valid state + code with mocked Feishu APIs", async () => {
      await startServer({
        ...FEISHU_CONFIG,
        feishuAuth: {
          ...FEISHU_CONFIG.feishuAuth!,
          allowedUsers: [], // allow all
        },
      });

      const state = jwt.sign({ nonce: "test" }, TEST_JWT_SECRET, { expiresIn: "5m", audience: "oauth_state" });

      // Mock global fetch for Feishu API calls
      const originalFetch = globalThis.fetch;
      let fetchCallCount = 0;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCallCount++;
        if (url.includes("/authen/v2/oauth/token")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, access_token: "mock_user_token" }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/authen/v1/user_info")) {
          return Promise.resolve(new Response(
            JSON.stringify({
              code: 0,
              data: {
                open_id: "ou_test123",
                name: "Test User",
                email: "test@example.com",
                avatar_url: "https://avatar.example.com/test.jpg",
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        // Fall through to real fetch for non-Feishu requests
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const res = await fetch(
          `${baseUrl}/api/auth/feishu/callback?code=test_code&state=${state}`,
          { redirect: "manual" },
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        // Should be the success HTML with localStorage write
        expect(html).toContain("localStorage.setItem");
        expect(html).toContain("zhiliao_token");

        // Extract token from HTML and verify
        const tokenMatch = html.match(/"([eyJ][^"]+)"/);
        expect(tokenMatch).toBeTruthy();
        const token = tokenMatch![1];
        const decoded = jwt.verify(token, TEST_JWT_SECRET) as jwt.JwtPayload;
        expect(decoded.sub).toBe("ou_test123");
        expect(decoded.name).toBe("Test User");
        expect(decoded.auth_method).toBe("feishu");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rejects user not in allowlist", async () => {
      await startServer({
        ...FEISHU_CONFIG,
        feishuAuth: {
          ...FEISHU_CONFIG.feishuAuth!,
          allowedUsers: ["ou_allowed"],
        },
      });

      const state = jwt.sign({ nonce: "test" }, TEST_JWT_SECRET, { expiresIn: "5m", audience: "oauth_state" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/authen/v2/oauth/token")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, access_token: "mock_user_token" }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/authen/v1/user_info")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, data: { open_id: "ou_blocked", name: "Blocked" } }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const res = await fetch(
          `${baseUrl}/api/auth/feishu/callback?code=test_code&state=${state}`,
          { redirect: "manual" },
        );
        expect(res.status).toBe(403);
        const html = await res.text();
        expect(html).toContain("Access denied");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("allows user in allowlist", async () => {
      await startServer({
        ...FEISHU_CONFIG,
        feishuAuth: {
          ...FEISHU_CONFIG.feishuAuth!,
          allowedUsers: ["ou_allowed"],
        },
      });

      const state = jwt.sign({ nonce: "test" }, TEST_JWT_SECRET, { expiresIn: "5m", audience: "oauth_state" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/authen/v2/oauth/token")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, access_token: "mock_user_token" }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/authen/v1/user_info")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, data: { open_id: "ou_allowed", name: "Allowed" } }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const res = await fetch(
          `${baseUrl}/api/auth/feishu/callback?code=test_code&state=${state}`,
          { redirect: "manual" },
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("localStorage.setItem");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles Feishu token exchange failure", async () => {
      await startServer(FEISHU_CONFIG);
      const state = jwt.sign({ nonce: "test" }, TEST_JWT_SECRET, { expiresIn: "5m", audience: "oauth_state" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/authen/v2/oauth/token")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 400, msg: "invalid code" }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const res = await fetch(
          `${baseUrl}/api/auth/feishu/callback?code=bad_code&state=${state}`,
          { redirect: "manual" },
        );
        expect(res.status).toBe(502);
        const html = await res.text();
        expect(html).toContain("Token exchange failed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("falls back to open_id when user_id_field is empty", async () => {
      await startServer({
        ...FEISHU_CONFIG,
        feishuAuth: {
          ...FEISHU_CONFIG.feishuAuth!,
          userIdField: "email",
          allowedUsers: [],
        },
      });

      const state = jwt.sign({ nonce: "test" }, TEST_JWT_SECRET, { expiresIn: "5m", audience: "oauth_state" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/authen/v2/oauth/token")) {
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, access_token: "mock_user_token" }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/authen/v1/user_info")) {
          // Email is empty — should fall back to open_id
          return Promise.resolve(new Response(
            JSON.stringify({ code: 0, data: { open_id: "ou_fallback", name: "Fallback User", email: "" } }),
            { headers: { "Content-Type": "application/json" } },
          ));
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const res = await fetch(
          `${baseUrl}/api/auth/feishu/callback?code=test_code&state=${state}`,
          { redirect: "manual" },
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        const tokenMatch = html.match(/"([eyJ][^"]+)"/);
        const token = tokenMatch![1];
        const decoded = jwt.verify(token, TEST_JWT_SECRET) as jwt.JwtPayload;
        expect(decoded.sub).toBe("ou_fallback"); // fell back from email
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
