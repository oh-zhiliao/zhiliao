import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuAdapter, type FeishuAdapterDeps } from "../../../src/channels/feishu/adapter.js";

describe("FeishuAdapter", () => {
  let adapter: FeishuAdapter;
  const sentMessages: Array<{ chatId?: string; messageId?: string; content: string }> = [];

  let mockClient: any;
  let mockAgent: any;
  let mockToolRegistry: any;
  let mockDb: any;

  function makeDmEvent(text: string, openId = "ou_user1", overrides: Record<string, unknown> = {}) {
    return {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: "om_dm",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
        ...overrides,
      },
    } as any;
  }

  function makeGroupEvent(text: string, openId = "ou_user1", overrides: Record<string, unknown> = {}) {
    return {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: "om_group",
        chat_id: "oc_group1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        thread_id: "omt_thread1",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "GitMemo" }],
        ...overrides,
      },
    } as any;
  }

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

    mockDb = {
      resolveFeishuRole: vi.fn(() => ({ role: "default", source: "chat_type_default" })),
      assignChatRole: vi.fn(),
      revokeChatRole: vi.fn(),
      getChatRole: vi.fn(() => null),
      listChatRoles: vi.fn(() => []),
      setChatTypeDefaultRole: vi.fn(),
      revokeChatTypeDefaultRole: vi.fn(),
      getChatTypeDefaultRole: vi.fn(() => null),
    };

    const deps: FeishuAdapterDeps = {
      client: mockClient as any,
      agent: mockAgent as any,
      toolRegistry: mockToolRegistry as any,
      db: mockDb as any,
      admins: ["ou_admin"],
    };

    adapter = new FeishuAdapter(deps);
  });

  it("routes DM plugin command through toolRegistry", async () => {
    mockToolRegistry.handleCommand.mockResolvedValueOnce("仓库列表: 空");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await adapter.handleMessage(makeDmEvent("/repo list", "ou_admin", { message_id: "om_1" }));

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("仓库列表: 空");
    expect(mockToolRegistry.handleCommand).toHaveBeenCalledWith(
      "repo",
      "list",
      [],
      expect.objectContaining({ userId: "ou_admin", chatType: "p2p", channel: "feishu", role: "default" })
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("role matched: role=default source=chat_type_default")
    );
    logSpy.mockRestore();
  });

  it("rejects non-role commands when no role is configured", async () => {
    mockDb.resolveFeishuRole.mockReturnValueOnce(null);

    await adapter.handleMessage(makeDmEvent("hello"));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("chat_id=oc_dm1");
    expect(mockAgent.ask).not.toHaveBeenCalled();
  });

  it("allows /help without an existing chat role", async () => {
    mockDb.resolveFeishuRole.mockReturnValueOnce(null);

    await adapter.handleMessage(makeDmEvent("/help"));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("命令列表");
    expect(mockAgent.ask).not.toHaveBeenCalled();
  });

  it("allows /role help for admins without an existing chat role", async () => {
    mockDb.resolveFeishuRole.mockReturnValueOnce(null);

    await adapter.handleMessage(makeDmEvent("/role", "ou_admin"));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("/role assign <chat_id> <role>");
  });

  it("rejects /role for non-admin users", async () => {
    await adapter.handleMessage(makeDmEvent("/role assign oc_dm1 prod_readonly", "ou_user1"));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("只有管理员可以执行 /role 命令");
  });

  it("routes /role assign for admins", async () => {
    await adapter.handleMessage(makeDmEvent("/role assign oc_dm1 prod_readonly", "ou_admin"));

    expect(mockDb.assignChatRole).toHaveBeenCalledWith("oc_dm1", "prod_readonly", "ou_admin");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("已设置 role");
  });

  it("routes /role read and mutate subcommands for admins", async () => {
    mockDb.getChatRole.mockReturnValueOnce("prod_readonly");
    mockDb.listChatRoles.mockReturnValueOnce([{ chatId: "oc_dm1", role: "prod_readonly" }]);
    mockDb.getChatTypeDefaultRole
      .mockReturnValueOnce("default")
      .mockReturnValueOnce(null);

    await adapter.handleMessage(makeDmEvent("/role get oc_dm1", "ou_admin", { message_id: "om_role_get" }));
    await adapter.handleMessage(makeDmEvent("/role list", "ou_admin", { message_id: "om_role_list" }));
    await adapter.handleMessage(makeDmEvent("/role default group default", "ou_admin", { message_id: "om_role_default" }));
    await adapter.handleMessage(makeDmEvent("/role default-revoke group", "ou_admin", { message_id: "om_role_default_revoke" }));
    await adapter.handleMessage(makeDmEvent("/role revoke oc_dm1", "ou_admin", { message_id: "om_role_revoke" }));

    expect(mockDb.setChatTypeDefaultRole).toHaveBeenCalledWith("group", "default", "ou_admin");
    expect(mockDb.revokeChatTypeDefaultRole).toHaveBeenCalledWith("group");
    expect(mockDb.revokeChatRole).toHaveBeenCalledWith("oc_dm1");
    expect(sentMessages.some((msg) => msg.content.includes("当前 role: chat_id=oc_dm1, role=prod_readonly"))).toBe(true);
    expect(sentMessages.some((msg) => msg.content.includes("当前已配置 1 个 chat role 绑定"))).toBe(true);
    expect(sentMessages.some((msg) => msg.content.includes("已设置默认 role: chat_type=group, role=default"))).toBe(true);
    expect(sentMessages.some((msg) => msg.content.includes("已删除默认 role: chat_type=group"))).toBe(true);
    expect(sentMessages.some((msg) => msg.content.includes("已删除 role: chat_id=oc_dm1"))).toBe(true);
  });

  it("keeps /new behind the role gate when no role is configured", async () => {
    mockDb.resolveFeishuRole.mockReturnValueOnce(null);

    await adapter.handleMessage(makeDmEvent("/new"));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("当前会话未配置权限角色");
    expect(mockAgent.clearSession).not.toHaveBeenCalled();
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

    await adapter.handleMessage(makeGroupEvent("@_user_1 /repo list", "ou_admin", { message_id: "om_grp_cmd" }));

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("group command result");
    expect(mockToolRegistry.handleCommand).toHaveBeenCalledWith(
      "repo",
      "list",
      [],
      expect.objectContaining({ userId: "ou_admin", chatType: "group", channel: "feishu", role: "default" })
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
    await adapter.handleMessage(makeGroupEvent("@_user_1 What is this project about?", "ou_user1", { message_id: "om_3" }));

    // Mock agent doesn't invoke tools, so no "thinking" message — just the reply
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("Answer to:");
    expect(mockAgent.ask).toHaveBeenCalledWith(
      "What is this project about?",
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ channel: "feishu", chatType: "group", chatId: "oc_group1", role: "default" }),
    );
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
        db: mockDb,
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
        db: mockDb,
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

  it("extracts plain text from feishu post content", async () => {
    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_post1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "",
            content: [
              [{ tag: "text", text: "给我10个满足以下条件的手机号" }],
              [{ tag: "text", text: "1.存在期次是M1的有效保单" }],
              [{ tag: "text", text: "2.存在二次进线" }],
            ],
          },
        }),
      },
    } as any);

    expect(mockAgent.ask).toHaveBeenCalledWith(
      "给我10个满足以下条件的手机号\n1.存在期次是M1的有效保单\n2.存在二次进线",
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ channel: "feishu", chatType: "p2p", chatId: "oc_dm1", role: "default" }),
    );
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("Answer to:");
  });

  it("warns and replies when message content cannot be extracted in DM", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_unsupported1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "interactive",
        content: JSON.stringify({ foo: "bar" }),
      },
    } as any);

    expect(mockAgent.ask).not.toHaveBeenCalled();
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("暂不支持该消息格式");
    expect(sentMessages[0].content).toContain("[logId: ");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported feishu message content")
    );

    warnSpy.mockRestore();
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

  it("does not append logId to normal agent replies", async () => {
    mockAgent.ask.mockResolvedValueOnce({
      text: "正常回复内容",
      sessionId: "s1",
    });

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_normal1",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    } as any);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("正常回复内容");
    expect(sentMessages[0].content).not.toContain("[logId:");
  });

  it("appends logId to fallback no-reply protection text", async () => {
    mockAgent.ask.mockResolvedValueOnce({
      text: "问题较复杂，已达到工具调用上限，请缩小范围或分步提问后重试。",
      sessionId: "s1",
    });

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_fallback_logid",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    } as any);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("已达到工具调用上限");
    expect(sentMessages[0].content).toContain("[logId: ");
  });

  it("shows limit progress in basic debug mode", async () => {
    mockAgent.ask.mockImplementationOnce(async (_q: string, _sessionId: string, onProgress?: (info: string) => void) => {
      onProgress?.("tool: mysql-query.query(summary)");
      onProgress?.("limit: expensive=3/3 total=8 awaiting_user_confirmation");
      return {
        text: "任务似乎比较复杂，目前达到了执行限制，是否要继续执行？如需继续，可以直接回复或补充新的要求。",
        sessionId: "s1",
      };
    });

    await adapter.handleMessage({
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      message: {
        message_id: "om_debug_limit",
        chat_id: "oc_dm1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/debug hello" }),
      },
    } as any);

    expect(sentMessages.some((msg) => msg.content.includes("[debug] limit: expensive=3/3 total=8 awaiting_user_confirmation"))).toBe(true);
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
