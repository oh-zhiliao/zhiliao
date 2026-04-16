import { describe, it, expect } from "vitest";
import { handleContext, handleNew, handleHelp } from "../../src/commands/session-commands.js";
import type { AgentInvoker, SessionStats } from "../../src/agent/invoker.js";

function mockAgent(stats: Partial<SessionStats> = {}): AgentInvoker {
  const defaultStats: SessionStats = {
    exists: false,
    messageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: 0,
    lastAccessedAt: 0,
    hasCompression: false,
  };
  return {
    getSessionStats: () => ({ ...defaultStats, ...stats }),
    clearSession: () => {},
  } as unknown as AgentInvoker;
}

describe("handleContext", () => {
  it("returns no-session message when session does not exist", () => {
    const result = handleContext(mockAgent({ exists: false }), "feishu:p2p:user1");
    expect(result).toContain("当前没有活跃会话");
  });

  it("includes session key in output", () => {
    const result = handleContext(
      mockAgent({
        exists: true,
        messageCount: 10,
        totalInputTokens: 5000,
        totalOutputTokens: 2000,
        createdAt: Date.now() - 30 * 60 * 1000,
        lastAccessedAt: Date.now(),
        hasCompression: false,
      }),
      "feishu:oc_abc123:main"
    );
    expect(result).toContain("feishu:oc_abc123:main");
    expect(result).toContain("10");
    expect(result).toContain("5,000");
    expect(result).toContain("2,000");
  });

  it("shows compression indicator when session was compressed", () => {
    const result = handleContext(
      mockAgent({
        exists: true,
        messageCount: 6,
        totalInputTokens: 80000,
        totalOutputTokens: 30000,
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
        lastAccessedAt: Date.now(),
        hasCompression: true,
      }),
      "feishu:p2p:user1"
    );
    expect(result).toContain("已压缩");
  });

  it("formats duration as hours + minutes", () => {
    const result = handleContext(
      mockAgent({
        exists: true,
        messageCount: 3,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        createdAt: Date.now() - 90 * 60 * 1000, // 1h30m ago
        lastAccessedAt: Date.now(),
        hasCompression: false,
      }),
      "feishu:p2p:user1"
    );
    expect(result).toContain("1 小时");
  });
});

describe("handleNew", () => {
  it("clears existing session and shows stats", () => {
    const result = handleNew(
      mockAgent({
        exists: true,
        messageCount: 20,
        totalInputTokens: 10000,
        totalOutputTokens: 5000,
        createdAt: Date.now() - 60 * 60 * 1000,
        lastAccessedAt: Date.now(),
        hasCompression: false,
      }),
      "feishu:p2p:user1"
    );
    expect(result).toContain("20 条消息");
    expect(result).toContain("15,000");
  });

  it("returns no-session when nothing to clear", () => {
    const result = handleNew(mockAgent({ exists: false }), "feishu:p2p:user1");
    expect(result).toContain("没有活跃会话");
  });
});

describe("handleHelp", () => {
  it("includes /new, /context, /help", () => {
    const result = handleHelp(true);
    expect(result).toContain("/new");
    expect(result).toContain("/context");
    expect(result).toContain("/help");
  });
});
