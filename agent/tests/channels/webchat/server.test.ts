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
    const token = jwt.sign({ sub: "webchat_user" }, config.jwtSecret, { expiresIn: "1h" });
    const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    expect(decoded.sub).toBe("webchat_user");
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("JWT verify rejects invalid token", () => {
    expect(() => jwt.verify("invalid.token.here", config.jwtSecret)).toThrow();
  });

  it("JWT verify rejects wrong secret", () => {
    const token = jwt.sign({ sub: "webchat_user" }, config.jwtSecret);
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
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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

  it("accepts WebSocket connection with valid token", async () => {
    const { WebSocket: WS } = await import("ws");
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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
    const token = jwt.sign({ sub: "webchat_user" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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
