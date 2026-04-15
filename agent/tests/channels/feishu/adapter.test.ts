import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuAdapter, type FeishuAdapterDeps } from "../../../src/channels/feishu/adapter.js";

describe("FeishuAdapter", () => {
  let adapter: FeishuAdapter;
  const sentMessages: Array<{ chatId?: string; messageId?: string; content: string }> = [];

  let mockClient: any;
  let mockAgent: any;
  let mockToolRegistry: any;

  beforeEach(() => {
    sentMessages.length = 0;

    mockClient = {
      sendToChat: vi.fn(async (chatId: string, _type: string, content: string) => {
        sentMessages.push({ chatId, content });
      }),
      replyMessage: vi.fn(async (messageId: string, _type: string, content: string) => {
        sentMessages.push({ messageId, content });
      }),
      addReaction: vi.fn(async () => {}),
      getBotOpenId: vi.fn(() => "ou_bot_open_id"),
      onMessage: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
    };

    mockAgent = {
      ask: vi.fn(async (q: string) => ({
        text: `Answer to: ${q}`,
        sessionId: "s1",
      })),
      getSessionStats: vi.fn(() => ({ exists: false, messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0, createdAt: 0 })),
      clearSession: vi.fn(),
    };

    mockToolRegistry = {
      handleCommand: vi.fn().mockResolvedValue(null),
      filterOutput: vi.fn((text: string) => text),
    };

    const deps: FeishuAdapterDeps = {
      client: mockClient as any,
      agent: mockAgent as any,
      toolRegistry: mockToolRegistry as any,
    };

    adapter = new FeishuAdapter(deps);
  });

  it("routes DM plugin command through toolRegistry", async () => {
    mockToolRegistry.handleCommand.mockResolvedValueOnce("仓库列表: 空");

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: "om_1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/repo list" }),
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("仓库列表: 空");
    expect(mockToolRegistry.handleCommand).toHaveBeenCalledWith(
      "repo",
      "list",
      [],
      expect.objectContaining({ userId: "ou_admin", chatType: "p2p" })
    );
  });

  it("returns unknown command when toolRegistry returns null in DM", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: "om_unknown",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/nosuchcmd" }),
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("未知命令: /nosuchcmd");
  });

  it("routes group plugin command through toolRegistry", async () => {
    mockToolRegistry.handleCommand.mockResolvedValueOnce("group command result");

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: "om_grp_cmd",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 /repo list" }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("group command result");
    expect(mockToolRegistry.handleCommand).toHaveBeenCalledWith(
      "repo",
      "list",
      [],
      expect.objectContaining({ userId: "ou_admin", chatType: "group" })
    );
  });

  it("returns unknown command in group when toolRegistry returns null", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: "om_grp_unknown",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 /nosuchcmd" }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("未知命令: /nosuchcmd");
  });

  it("routes group @mention to agent", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_3",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 What is this project about?" }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
      },
    } as any);

    // Mock agent doesn't invoke tools, so no "thinking" message — just the reply
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("Answer to:");
  });

  it("ignores group @mention of non-bot user", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_5",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_2 hey there" }),
        mentions: [{ key: "@_user_2", id: { open_id: "ou_other" }, name: "SomeUser" }],
      },
    } as any);

    expect(sentMessages.length).toBe(0);
  });

  it("ignores group message without @mention", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_4",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "just chatting" }),
      },
    } as any);

    expect(sentMessages.length).toBe(0);
  });

  it("ignores topic group message without @mention", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_topic_no_at",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "just chatting in a topic" }),
        thread_id: "omt_thread1",
      },
    } as any);

    expect(sentMessages.length).toBe(0);
  });

  it("deduplicates messages with the same msgId", async () => {
    const event = {
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_dup1",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hello" }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
      },
    } as any;

    await adapter.handleMessage(event);
    await adapter.handleMessage(event); // duplicate

    // Agent should only be called once
    expect(sentMessages.length).toBe(1);
  });

  it("allows different msgIds through", async () => {
    const makeEvent = (msgId: string) => ({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: msgId,
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hello" }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
      },
    } as any);

    await adapter.handleMessage(makeEvent("om_a"));
    await adapter.handleMessage(makeEvent("om_b"));

    expect(sentMessages.length).toBe(2);
  });

  it("retries replyMessage for group chats instead of sendToChat fallback", async () => {
    // Make replyMessage fail on first call, succeed on retry
    mockClient.replyMessage
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce({ code: 0 });

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_fallback1",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hello" }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
      },
    } as any);

    // Group chats should NOT fall back to sendToChat (it creates new topics)
    expect(mockClient.sendToChat).not.toHaveBeenCalled();
    // Should have called replyMessage twice (original + retry)
    expect(mockClient.replyMessage).toHaveBeenCalledTimes(2);
  });

  it("handles /help session command in DM", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_help",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/help" }),
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("命令列表");
    // Should not go through toolRegistry
    expect(mockToolRegistry.handleCommand).not.toHaveBeenCalled();
  });

  it("ignores stale messages older than maxMessageAgeMs", async () => {
    const staleAdapter = new FeishuAdapter({
      ...({
        client: mockClient,
        agent: mockAgent,
        toolRegistry: mockToolRegistry,
      } as FeishuAdapterDeps),
      maxMessageAgeMs: 5000, // 5 seconds
    });

    const staleCreateTime = String(Date.now() - 10000); // 10 seconds ago

    await staleAdapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_stale1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: staleCreateTime,
      },
    } as any);

    expect(sentMessages.length).toBe(0);
    expect(mockAgent.ask).not.toHaveBeenCalled();
  });

  it("processes recent messages within maxMessageAgeMs", async () => {
    const recentAdapter = new FeishuAdapter({
      ...({
        client: mockClient,
        agent: mockAgent,
        toolRegistry: mockToolRegistry,
      } as FeishuAdapterDeps),
      maxMessageAgeMs: 5000,
    });

    const recentCreateTime = String(Date.now() - 1000); // 1 second ago

    await recentAdapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_recent1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: recentCreateTime,
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(mockAgent.ask).toHaveBeenCalled();
  });

  it("processes messages without create_time (backwards compat)", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_notime1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        // no create_time
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(mockAgent.ask).toHaveBeenCalled();
  });

  it("applies toolRegistry.filterOutput to agent response", async () => {
    mockAgent.ask.mockResolvedValueOnce({
      text: "The server is at internal.host.example.com",
      sessionId: "s1",
    });
    mockToolRegistry.filterOutput = vi.fn((text: string) =>
      text.replace(/internal\.host\.example\.com/g, "***")
    );

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_filter1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "where is the server?" }),
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("***");
    expect(sentMessages[0].content).not.toContain("internal.host.example.com");
    expect(mockToolRegistry.filterOutput).toHaveBeenCalled();
  });

  it("handles /new session command in DM", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_new",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/new" }),
      },
    } as any);

    expect(sentMessages.length).toBe(1);
    // Should not go through toolRegistry
    expect(mockToolRegistry.handleCommand).not.toHaveBeenCalled();
  });
});
