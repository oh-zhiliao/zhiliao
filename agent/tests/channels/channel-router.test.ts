import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelRouter } from "../../src/channels/channel-router.js";
import type { Channel, ChannelMessageContext } from "../../src/channels/channel.js";
import type { AgentInvoker } from "../../src/agent/invoker.js";
import type { ToolRegistry } from "../../src/agent/tool-registry.js";

function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: "test",
    getSessionKey: (ctx) => `test:${ctx.userId}`,
    sendReply: vi.fn().mockResolvedValue(undefined),
    supportsStreaming: () => false,
    ...overrides,
  };
}

function createMockContext(userId = "u1"): ChannelMessageContext {
  return { channelName: "test", userId, sessionKey: `test:${userId}`, extra: {} };
}

describe("ChannelRouter", () => {
  let mockAgent: any;
  let mockRegistry: any;
  let router: ChannelRouter;

  beforeEach(() => {
    mockAgent = {
      ask: vi.fn().mockResolvedValue({ text: "agent response", sessionId: "s1" }),
      clearSession: vi.fn(),
      getSessionStats: vi.fn().mockReturnValue({ exists: true, messageCount: 5, totalInputTokens: 100, totalOutputTokens: 50, createdAt: Date.now(), lastAccessedAt: Date.now() }),
    };
    mockRegistry = {
      handleCommand: vi.fn().mockResolvedValue(null),
      filterOutput: vi.fn((t: string) => t),
    };
    router = new ChannelRouter(mockAgent, mockRegistry, []);
  });

  it("routes questions to agent.ask and sends filtered reply", async () => {
    const channel = createMockChannel();
    const ctx = createMockContext();
    await router.handleMessage(channel, ctx, "what is this?");
    expect(mockAgent.ask).toHaveBeenCalledWith("what is this?", "test:u1", expect.any(Function));
    expect(channel.sendReply).toHaveBeenCalledWith(ctx, "agent response");
  });

  it("routes /new command to session reset", async () => {
    const channel = createMockChannel();
    const ctx = createMockContext();
    await router.handleMessage(channel, ctx, "/new");
    expect(mockAgent.clearSession).toHaveBeenCalled();
    expect(channel.sendReply).toHaveBeenCalled();
  });

  it("routes /help command", async () => {
    const channel = createMockChannel();
    const ctx = createMockContext();
    await router.handleMessage(channel, ctx, "/help");
    expect(channel.sendReply).toHaveBeenCalled();
    const replyText = (channel.sendReply as any).mock.calls[0][1];
    expect(replyText).toContain("知了命令列表");
  });

  it("routes plugin commands via toolRegistry", async () => {
    mockRegistry.handleCommand.mockResolvedValue("plugin response");
    const channel = createMockChannel();
    const ctx = createMockContext();
    await router.handleMessage(channel, ctx, "/git-repos list");
    expect(mockRegistry.handleCommand).toHaveBeenCalledWith("git-repos", "list", [], expect.any(Object));
    expect(channel.sendReply).toHaveBeenCalledWith(ctx, "plugin response");
  });

  it("reports unknown commands", async () => {
    const channel = createMockChannel();
    const ctx = createMockContext();
    await router.handleMessage(channel, ctx, "/nonexistent");
    expect(channel.sendReply).toHaveBeenCalled();
    const replyText = (channel.sendReply as any).mock.calls[0][1];
    expect(replyText).toContain("未知命令");
  });

  it("applies secret filtering and plugin output filtering", async () => {
    mockRegistry.filterOutput.mockImplementation((t: string) => t.replace("secret", "[REDACTED]"));
    const channel = createMockChannel();
    const ctx = createMockContext();
    mockAgent.ask.mockResolvedValue({ text: "contains secret data" });
    await router.handleMessage(channel, ctx, "tell me");
    const replyText = (channel.sendReply as any).mock.calls[0][1];
    expect(replyText).toContain("[REDACTED]");
  });

  it("calls sendProgress on channel when agent reports progress", async () => {
    const sendProgress = vi.fn().mockResolvedValue(undefined);
    const channel = createMockChannel({ sendProgress });
    const ctx = createMockContext();
    mockAgent.ask.mockImplementation(async (_q: string, _s: string, onProgress?: Function) => {
      onProgress?.("tool: git-repos.search(query)");
      return { text: "done" };
    });
    await router.handleMessage(channel, ctx, "search something");
    expect(sendProgress).toHaveBeenCalledWith(ctx, "tool: git-repos.search(query)");
  });
});
