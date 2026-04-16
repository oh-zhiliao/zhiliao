/**
 * Fixture webchat server for Playwright E2E tests.
 *
 * Starts the real WebChat server with stubbed AgentInvoker + ToolRegistry.
 * Auth is bypassed via the `test_token` config option, so tests skip bcrypt.
 *
 * Started automatically by playwright.config.ts `webServer.command`.
 */
import { hashSync } from "bcryptjs";
import { randomBytes } from "crypto";
import { createWebChatServer } from "../../src/channels/webchat/server.js";
import { ChannelRouter } from "../../src/channels/channel-router.js";
import { ToolRegistry } from "../../src/agent/tool-registry.js";
import type { AgentInvoker } from "../../src/agent/invoker.js";
import type { SessionStats, StreamingCallbacks } from "../../src/agent/invoker.js";

const PORT = Number(process.env.E2E_PORT ?? 18080);
const TEST_TOKEN = process.env.E2E_TEST_TOKEN ?? "e2e-fixed-token";

// --- Fake agent: just enough for /help, /new, /context, and a stub Q&A ---

const stats = new Map<string, SessionStats>();

function ensureStats(key: string): SessionStats {
  let s = stats.get(key);
  if (!s) {
    const now = Date.now();
    s = {
      exists: false,
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: now,
      lastAccessedAt: now,
      hasCompression: false,
    };
    stats.set(key, s);
  }
  return s;
}

const fakeAgent: Partial<AgentInvoker> = {
  getSessionStats: (key: string) => ensureStats(key),
  clearSession: (key: string) => {
    stats.delete(key);
  },
  ask: async (question: string, sessionId: string) => {
    const s = ensureStats(sessionId);
    s.exists = true;
    s.messageCount += 2;
    s.totalInputTokens += 10;
    s.totalOutputTokens += 20;
    return { text: `Echo: ${question}`, sessionId };
  },
  askStreaming: async (
    question: string,
    sessionKey: string,
    callbacks: StreamingCallbacks,
  ) => {
    const s = ensureStats(sessionKey);
    s.exists = true;
    s.messageCount += 2;
    const reply = `Echo: ${question}`;
    callbacks.onTextDelta?.("Echo: ");
    callbacks.onTextDelta?.(question);
    callbacks.onComplete?.(reply);
    return reply;
  },
};

const toolRegistry = new ToolRegistry();
const router = new ChannelRouter(fakeAgent as AgentInvoker, toolRegistry, []);

const server = createWebChatServer(
  {
    port: PORT,
    passwordHash: hashSync("unused-password-bcrypt-only-as-placeholder", 4),
    jwtSecret: randomBytes(32).toString("hex"),
    testToken: TEST_TOKEN,
  },
  router,
  fakeAgent as AgentInvoker,
  toolRegistry,
  [],
);

server.start();

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
