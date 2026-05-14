import { randomUUID } from "crypto";
import type { FeishuClient, FeishuEventData } from "./client.js";
import type { AgentInvoker } from "../../agent/invoker.js";
import type { ToolRegistry } from "../../agent/tool-registry.js";
import type { ZhiliaoDB, ResolvedFeishuRole } from "../../db.js";
import type { RequestContext } from "../../agent/request-context.js";
import { parseCommand } from "../../commands/router.js";
import { handleNew, handleContext, handleHelp } from "../../commands/session-commands.js";
import { buildSessionKey, type FeishuMessageContext } from "./thread-mapper.js";
import { buildCardMessage } from "./message-builder.js";
import { filterSecrets } from "./secret-filter.js";
import type { CommandCallContext } from "../../agent/tool-plugin.js";

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_MESSAGE_AGE_MS = 30 * 1000; // 30 seconds
const AGENT_FALLBACK_MARKERS = [
  "问题较复杂，已达到工具调用上限，请缩小范围或分步提问后重试。",
  "(无法生成回复，请重试)",
  "(空回复，请重试)",
];
const UNSUPPORTED_MESSAGE_REPLY = "暂不支持该消息格式，请发送纯文本或飞书富文本消息。";

function genLogId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function shouldAppendLogId(text: string): boolean {
  return AGENT_FALLBACK_MARKERS.some((marker) => text.includes(marker)) && !text.includes("[logId:");
}

function appendLogId(text: string, logId: string): string {
  return `${text}\n[logId: ${logId}]`;
}

function extractInlineText(node: unknown): string {
  if (Array.isArray(node)) {
    return node.map((item) => extractInlineText(item)).join("");
  }
  if (!node || typeof node !== "object") {
    return "";
  }

  const record = node as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (typeof record.user_name === "string") {
    return `@${record.user_name}`;
  }
  if (Array.isArray(record.content)) {
    return extractInlineText(record.content);
  }

  return "";
}

function extractTextFromPostDocument(doc: unknown): string {
  if (!doc || typeof doc !== "object") {
    return "";
  }

  const record = doc as Record<string, unknown>;
  if (!Array.isArray(record.content)) {
    return "";
  }

  const lines = record.content
    .map((row) => extractInlineText(row).trim())
    .filter(Boolean);

  return lines.join("\n");
}

function extractFeishuTextContent(rawContent: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }

  const postCandidates: unknown[] = [];
  if (record.post) {
    postCandidates.push(record.post);
  }
  postCandidates.push(parsed);
  for (const value of Object.values(record)) {
    postCandidates.push(value);
  }

  for (const candidate of postCandidates) {
    const text = extractTextFromPostDocument(candidate);
    if (text) {
      return text;
    }
  }

  return null;
}

export interface FeishuAdapterDeps {
  client: FeishuClient;
  agent: AgentInvoker;
  toolRegistry: ToolRegistry;
  db: ZhiliaoDB;
  secretPatterns?: RegExp[];
  maxMessageAgeMs?: number;
  admins?: string[];
}

export class FeishuAdapter {
  private deps: FeishuAdapterDeps;
  private recentMsgIds = new Map<string, number>();
  private maxMessageAgeMs: number;

  constructor(deps: FeishuAdapterDeps) {
    this.deps = deps;
    this.maxMessageAgeMs = deps.maxMessageAgeMs ?? DEFAULT_MAX_MESSAGE_AGE_MS;
  }

  async handleMessage(data: FeishuEventData): Promise<void> {
    const logId = genLogId();
    const msg = data.message;

    // Dedup: skip if we've already seen this msgId (WS redelivery on reconnect)
    const now = Date.now();
    if (this.recentMsgIds.has(msg.message_id)) {
      return;
    }
    this.recentMsgIds.set(msg.message_id, now);
    // Cleanup expired entries
    for (const [id, ts] of this.recentMsgIds) {
      if (now - ts > DEDUP_TTL_MS) this.recentMsgIds.delete(id);
    }

    // Age gate: ignore stale messages (e.g. WS reconnect replays beyond dedup window)
    if (msg.create_time) {
      const createTimeMs = parseInt(msg.create_time, 10);
      if (!isNaN(createTimeMs) && now - createTimeMs > this.maxMessageAgeMs) {
        console.log(`[${logId}] stale msg ignored: age=${now - createTimeMs}ms > ${this.maxMessageAgeMs}ms msgId=${msg.message_id}`);
        return;
      }
    }

    const senderId = data.sender.sender_id?.open_id ?? data.sender.sender_id?.user_id ?? "";
    const chatType = msg.chat_type as "group" | "p2p";
    const ctx: FeishuMessageContext = {
      chatId: msg.chat_id,
      chatType,
      threadId: msg.thread_id,
      senderId,
      senderName: "",
      messageId: msg.message_id,
      logId,
      debugLevel: 0,
    };

    // Parse text content
    let text = extractFeishuTextContent(msg.content);
    if (text === null) {
      console.warn(
        `[${logId}] unsupported feishu message content type=${msg.message_type} chatType=${chatType} msgId=${msg.message_id}`
      );
      const botOpenId = this.deps.client.getBotOpenId();
      const botMentioned = msg.mentions?.some((m) => m.id?.open_id === botOpenId) ?? false;
      if (chatType === "p2p" || botMentioned) {
        await this.replySafe(ctx, appendLogId(UNSUPPORTED_MESSAGE_REPLY, logId));
      }
      return;
    }

    // Strip @mention placeholders from text (must happen before /debug check,
    // because in group chat the mention key precedes the user's text)
    if (msg.mentions) {
      for (const mention of msg.mentions) {
        text = text.replace(mention.key, "").trim();
      }
    }

    // Check /debug or /debug2 prefix (after mention stripping)
    let debugLevel: 0 | 1 | 2 = 0;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("/debug2")) {
      const isAdmin = this.deps.admins?.includes(senderId);
      debugLevel = isAdmin ? 2 : 1;  // non-admin falls back to basic
      text = trimmed.slice(7).trim();
    } else if (trimmed.startsWith("/debug")) {
      debugLevel = 1;
      text = trimmed.slice(6).trim();
    }

    if (!text) return; // Empty after stripping
    ctx.debugLevel = debugLevel;

    console.log(`[${logId}] recv ${chatType} msg from=${senderId} chat=${msg.chat_id} msgId=${msg.message_id} debug=${debugLevel > 0} text=${JSON.stringify(text.slice(0, 100))}`);

    // Route: DM → commands or questions; Group → @mention required
    try {
      if (chatType === "p2p") {
        this.deps.client.addReaction(msg.message_id, "OK").catch(() => {});
        await this.handleDM(ctx, text);
      } else {
        const botOpenId = this.deps.client.getBotOpenId();
        const botMentioned = msg.mentions?.some(
          (m) => m.id?.open_id === botOpenId
        );

        // All group types require @mention to avoid confusion
        if (!botMentioned) {
          console.log(`[${logId}] group msg ignored: botOpenId=${botOpenId} mentions=${JSON.stringify(msg.mentions)}`);
          return;
        }

        this.deps.client.addReaction(msg.message_id, "OK").catch(() => {});
        await this.handleGroupMessage(ctx, text);
      }
    } catch (e: any) {
      console.error(`[${logId}] unhandled error:`, e);
      await this.replySafe(ctx, `系统错误，请稍后重试。\n[logId: ${logId}]`);
    }
  }

  private async handleDM(ctx: FeishuMessageContext, text: string): Promise<void> {
    const parsed = parseCommand(text);

    if (parsed.type === "command") {
      if (parsed.command === "help") {
        await this.handleSessionCommand(ctx, parsed.command);
        return;
      }
      if (parsed.command === "role") {
        await this.handleRoleCommand(ctx, parsed.subcommand, parsed.args);
        return;
      }

      const resolvedRole = this.requireRole(ctx);
      if (!resolvedRole) {
        await this.reply(ctx, this.buildMissingRoleMessage(ctx));
        return;
      }

      if (await this.handleSessionCommand(ctx, parsed.command)) return;

      // Try plugin commands: /{plugin-name} {subcommand} {args}
      const callCtx = this.buildCommandContext(ctx, resolvedRole.role);
      const result = await this.deps.toolRegistry.handleCommand(
        parsed.command,
        parsed.subcommand ?? "",
        parsed.args,
        callCtx
      );
      if (result !== null) {
        console.log(`[${ctx.logId}] command /${parsed.command} ${parsed.subcommand ?? ""} reply len=${result.length}`);
        await this.reply(ctx, result);
        return;
      }

      // Unknown command
      console.log(`[${ctx.logId}] unknown command: /${parsed.command}`);
      await this.reply(ctx, `未知命令: /${parsed.command}`);
    } else {
      const resolvedRole = this.requireRole(ctx);
      if (!resolvedRole) {
        await this.reply(ctx, this.buildMissingRoleMessage(ctx));
        return;
      }
      await this.handleQuestion(ctx, parsed.text, resolvedRole.role);
    }
  }

  private async handleSessionCommand(ctx: FeishuMessageContext, command: string): Promise<boolean> {
    const sessionKey = buildSessionKey(ctx);

    if (command === "new") {
      const result = handleNew(this.deps.agent, sessionKey);
      console.log(`[${ctx.logId}] command /${command} reply len=${result.length}`);
      await this.reply(ctx, result);
      return true;
    }
    if (command === "context") {
      const result = handleContext(this.deps.agent, sessionKey);
      console.log(`[${ctx.logId}] command /${command} reply len=${result.length}`);
      await this.reply(ctx, result);
      return true;
    }
    if (command === "help") {
      const result = handleHelp(ctx.chatType === "p2p");
      console.log(`[${ctx.logId}] command /${command} reply len=${result.length}`);
      await this.reply(ctx, result);
      return true;
    }

    return false;
  }

  private async handleGroupMessage(ctx: FeishuMessageContext, text: string): Promise<void> {
    const parsed = parseCommand(text);

    if (parsed.type === "command") {
      if (parsed.command === "help") {
        await this.handleSessionCommand(ctx, parsed.command);
        return;
      }
      if (parsed.command === "role") {
        await this.handleRoleCommand(ctx, parsed.subcommand, parsed.args);
        return;
      }

      const resolvedRole = this.requireRole(ctx);
      if (!resolvedRole) {
        await this.reply(ctx, this.buildMissingRoleMessage(ctx));
        return;
      }

      if (await this.handleSessionCommand(ctx, parsed.command)) return;

      const callCtx = this.buildCommandContext(ctx, resolvedRole.role);
      const result = await this.deps.toolRegistry.handleCommand(
        parsed.command,
        parsed.subcommand ?? "",
        parsed.args,
        callCtx
      );
      if (result !== null) {
        console.log(`[${ctx.logId}] command /${parsed.command} ${parsed.subcommand ?? ""} reply len=${result.length}`);
        await this.reply(ctx, result);
        return;
      }

      await this.reply(ctx, `未知命令: /${parsed.command}`);
      return;
    }

    const resolvedRole = this.requireRole(ctx);
    if (!resolvedRole) {
      await this.reply(ctx, this.buildMissingRoleMessage(ctx));
      return;
    }

    await this.handleQuestion(ctx, parsed.text, resolvedRole.role);
  }

  private async handleQuestion(ctx: FeishuMessageContext, question: string, resolvedRole: string): Promise<void> {
    const sessionKey = buildSessionKey(ctx);

    // Progress callback: send "thinking" on first tool call, debug info in debug mode
    let sentThinking = false;
    const onProgress = (info: string) => {
      if (!sentThinking) {
        sentThinking = true;
        this.replySafe(ctx, "正在查阅资料...");
        if (ctx.debugLevel >= 1) {
          this.replySafe(ctx, `[debug] session=${sessionKey}`);
        }
      }
      if (ctx.debugLevel >= 2) {
        // Verbose: show everything (auto-inject, tool results, etc.)
        this.replySafe(ctx, `[debug] ${info}`);
      } else if (ctx.debugLevel >= 1 && (info.startsWith("tool:") || info.startsWith("limit:"))) {
        // Basic: show tool call names and explicit tool-limit events
        this.replySafe(ctx, `[debug] ${info}`);
      }
    };

    try {
      const response = await this.deps.agent.ask(question, sessionKey, onProgress, this.buildRequestContext(ctx, resolvedRole));
      const replyText = shouldAppendLogId(response.text)
        ? appendLogId(response.text, ctx.logId)
        : response.text;
      if (replyText !== response.text) {
        console.warn(`[${ctx.logId}] agent fallback reply returned to user: ${JSON.stringify(response.text)}`);
      }
      const secretFiltered = filterSecrets(replyText, this.deps.secretPatterns);
      const filtered = this.deps.toolRegistry.filterOutput(secretFiltered);
      console.log(`[${ctx.logId}] agent reply len=${replyText.length} filtered=${filtered !== replyText}`);
      await this.reply(ctx, filtered);
    } catch (e: any) {
      const code = e.status ?? e.code ?? "UNKNOWN";
      console.error(`[${ctx.logId}] agent error code=${code}:`, e.message ?? e);
      await this.reply(ctx, `处理失败 (code: ${code})\n请稍后重试。\n[logId: ${ctx.logId}]`);
    }
  }

  private async reply(ctx: FeishuMessageContext, text: string): Promise<void> {
    const msg = buildCardMessage(text);
    try {
      await this.deps.client.replyMessage(ctx.messageId, msg.msg_type, msg.content);
    } catch (e: any) {
      const code = e.code ?? e.status ?? "UNKNOWN";
      const apiLogId = e.logId ?? e.log_id ?? "";
      console.error(`[${ctx.logId}] feishu reply error code=${code} apiLogId=${apiLogId}:`, e.message ?? e);

      // For group chats, retry replyMessage — sendToChat creates a new topic in topic groups
      if (ctx.chatType === "group") {
        try {
          await this.deps.client.replyMessage(ctx.messageId, msg.msg_type, msg.content);
          console.log(`[${ctx.logId}] retry replyMessage succeeded`);
        } catch (e2: any) {
          console.error(`[${ctx.logId}] retry replyMessage also failed: ${e2.message ?? e2}`);
        }
        return;
      }

      // For p2p chats, sendToChat is a safe fallback (no thread context to lose)
      try {
        await this.deps.client.sendToChat(ctx.chatId, msg.msg_type, msg.content);
        console.log(`[${ctx.logId}] fallback sendToChat succeeded`);
      } catch (e2: any) {
        console.error(`[${ctx.logId}] fallback sendToChat also failed: ${e2.message ?? e2}`);
      }
    }
  }

  private async replySafe(ctx: FeishuMessageContext, text: string): Promise<void> {
    try {
      await this.reply(ctx, text);
    } catch {
      // Already logged in reply(), swallow to prevent unhandled rejection
    }
  }

  private isAdmin(senderId: string): boolean {
    return this.deps.admins?.includes(senderId) ?? false;
  }

  private requireRole(ctx: FeishuMessageContext): ResolvedFeishuRole | null {
    const resolved = this.deps.db.resolveFeishuRole(ctx.chatId, ctx.chatType);
    if (resolved) {
      console.log(
        `[${ctx.logId}] role matched: role=${resolved.role} source=${resolved.source} chatType=${ctx.chatType} chat=${ctx.chatId}`
      );
    } else {
      console.log(
        `[${ctx.logId}] role missing: chatType=${ctx.chatType} chat=${ctx.chatId}`
      );
    }
    return resolved;
  }

  private buildMissingRoleMessage(ctx: FeishuMessageContext): string {
    return `当前会话未配置权限角色。chat_type=${ctx.chatType}, chat_id=${ctx.chatId}。请管理员执行 /role assign <chat_id> <role>，或为该 chat_type 设置默认 role。`;
  }

  private buildCommandContext(ctx: FeishuMessageContext, role: string): CommandCallContext {
    return {
      ...this.buildRequestContext(ctx, role),
      userId: ctx.senderId,
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      logId: ctx.logId,
    };
  }

  private buildRequestContext(ctx: FeishuMessageContext, role: string): RequestContext {
    return {
      channel: "feishu",
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      userId: ctx.senderId,
      role,
      logId: ctx.logId,
    };
  }

  private getRoleHelpText(): string {
    return [
      "角色管理命令:",
      "/role help: 显示本帮助",
      "/role assign <chat_id> <role>: 为指定会话绑定 role，优先级高于默认角色",
      "/role revoke <chat_id>: 删除指定会话绑定，之后会回退到默认角色或报错",
      "/role get <chat_id>: 查看指定会话当前绑定的 role",
      "/role list: 列出所有 chat_id 绑定和 group/p2p 默认角色",
      "/role default <group|p2p> <role>: 为未单独配置的 group/p2p 会话设置默认 role",
      "/role default-revoke <group|p2p>: 删除 group/p2p 默认角色，之后未单独配置的会话会报错",
      "",
      "示例:",
      "/role assign oc_xxx prod_readonly",
      "/role default p2p default",
    ].join("\n");
  }

  private getRoleDefaultUsageText(): string {
    return [
      "用法: /role default <group|p2p> <role>",
      "作用: 为未单独配置 chat_id 的 group/p2p 会话设置兜底 role。",
      "优先级: chat_id 显式绑定高于默认角色。",
      "示例: /role default p2p default",
    ].join("\n");
  }

  private async handleRoleCommand(
    ctx: FeishuMessageContext,
    subcommand: string | undefined,
    args: string[],
  ): Promise<void> {
    if (!this.isAdmin(ctx.senderId)) {
      await this.reply(ctx, "只有管理员可以执行 /role 命令。");
      return;
    }

    const sub = subcommand ?? "help";
    switch (sub) {
      case "help":
        await this.reply(ctx, this.getRoleHelpText());
        return;
      case "assign": {
        if (args.length !== 2) {
          await this.reply(ctx, "用法: /role assign <chat_id> <role>");
          return;
        }
        this.deps.db.assignChatRole(args[0], args[1], ctx.senderId);
        await this.reply(ctx, `已设置 role: chat_id=${args[0]}, role=${args[1]}`);
        return;
      }
      case "revoke": {
        if (args.length !== 1) {
          await this.reply(ctx, "用法: /role revoke <chat_id>");
          return;
        }
        this.deps.db.revokeChatRole(args[0]);
        await this.reply(ctx, `已删除 role: chat_id=${args[0]}`);
        return;
      }
      case "get": {
        if (args.length !== 1) {
          await this.reply(ctx, "用法: /role get <chat_id>");
          return;
        }
        const role = this.deps.db.getChatRole(args[0]);
        await this.reply(ctx, role
          ? `当前 role: chat_id=${args[0]}, role=${role}`
          : `当前未配置 role: chat_id=${args[0]}`
        );
        return;
      }
      case "list": {
        const rows = this.deps.db.listChatRoles();
        const defaults = ["group", "p2p"]
          .map((chatType) => {
            const role = this.deps.db.getChatTypeDefaultRole(chatType as "group" | "p2p");
            return role ? `- ${chatType}: ${role}` : null;
          })
          .filter(Boolean);
        const lines = [
          `当前已配置 ${rows.length} 个 chat role 绑定`,
          ...rows.map((row) => `- ${row.chatId}: ${row.role}`),
          defaults.length > 0 ? "默认角色:" : null,
          ...defaults,
        ].filter(Boolean);
        await this.reply(ctx, lines.join("\n"));
        return;
      }
      case "default": {
        if (args.length !== 2 || (args[0] !== "group" && args[0] !== "p2p")) {
          await this.reply(ctx, this.getRoleDefaultUsageText());
          return;
        }
        this.deps.db.setChatTypeDefaultRole(args[0], args[1], ctx.senderId);
        await this.reply(ctx, `已设置默认 role: chat_type=${args[0]}, role=${args[1]}`);
        return;
      }
      case "default-revoke": {
        if (args.length !== 1 || (args[0] !== "group" && args[0] !== "p2p")) {
          await this.reply(ctx, "用法: /role default-revoke <group|p2p>");
          return;
        }
        this.deps.db.revokeChatTypeDefaultRole(args[0]);
        await this.reply(ctx, `已删除默认 role: chat_type=${args[0]}`);
        return;
      }
      default:
        await this.reply(ctx, "用法: /role help");
    }
  }
}
