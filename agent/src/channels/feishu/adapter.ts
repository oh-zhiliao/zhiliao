import { randomUUID } from "crypto";
import type { FeishuClient, FeishuEventData } from "./client.js";
import type { AgentInvoker } from "../../agent/invoker.js";
import type { ToolRegistry } from "../../agent/tool-registry.js";
import { parseCommand } from "../../commands/router.js";
import { handleNew, handleContext, handleHelp } from "../../commands/session-commands.js";
import { buildSessionKey, type FeishuMessageContext } from "./thread-mapper.js";
import { buildCardMessage } from "./message-builder.js";
import { filterSecrets } from "./secret-filter.js";

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_MESSAGE_AGE_MS = 30 * 1000; // 30 seconds

function genLogId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

export interface FeishuAdapterDeps {
  client: FeishuClient;
  agent: AgentInvoker;
  toolRegistry: ToolRegistry;
  secretPatterns?: RegExp[];
  maxMessageAgeMs?: number;
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

    // Parse text content
    let text: string;
    try {
      const parsed = JSON.parse(msg.content);
      text = parsed.text ?? "";
    } catch {
      return; // Non-text message, ignore
    }

    // Strip @mention placeholders from text (must happen before /debug check,
    // because in group chat the mention key precedes the user's text)
    if (msg.mentions) {
      for (const mention of msg.mentions) {
        text = text.replace(mention.key, "").trim();
      }
    }

    // Check /debug prefix (after mention stripping)
    const debugMode = text.trimStart().startsWith("/debug");
    if (debugMode) {
      text = text.trimStart().slice(6).trim();
    }

    if (!text) return; // Empty after stripping

    const ctx: FeishuMessageContext = {
      chatId: msg.chat_id,
      chatType,
      threadId: msg.thread_id,
      senderId,
      senderName: "",
      messageId: msg.message_id,
      logId,
      debugMode,
    };

    console.log(`[${logId}] recv ${chatType} msg from=${senderId} chat=${msg.chat_id} msgId=${msg.message_id} debug=${debugMode} text=${JSON.stringify(text.slice(0, 100))}`);

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
      // Builtin session commands have highest priority
      if (await this.handleSessionCommand(ctx, parsed.command)) return;

      // Try plugin commands: /{plugin-name} {subcommand} {args}
      const callCtx = {
        userId: ctx.senderId,
        chatType: ctx.chatType as "p2p" | "group",
        chatId: ctx.chatId,
        logId: ctx.logId,
      };
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
      await this.handleQuestion(ctx, parsed.text);
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
      if (await this.handleSessionCommand(ctx, parsed.command)) return;

      const callCtx = {
        userId: ctx.senderId,
        chatType: ctx.chatType as "p2p" | "group",
        chatId: ctx.chatId,
        logId: ctx.logId,
      };
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

    await this.handleQuestion(ctx, parsed.text);
  }

  private async handleQuestion(ctx: FeishuMessageContext, question: string): Promise<void> {
    const sessionKey = buildSessionKey(ctx);

    // Progress callback: send "thinking" on first tool call, debug info in debug mode
    let sentThinking = false;
    const onProgress = (info: string) => {
      if (!sentThinking) {
        sentThinking = true;
        this.replySafe(ctx, "正在查阅资料...");
        if (ctx.debugMode) {
          this.replySafe(ctx, `[debug] session=${sessionKey}`);
        }
      }
      if (ctx.debugMode) {
        this.replySafe(ctx, `[debug] ${info}`);
      }
    };

    try {
      const response = await this.deps.agent.ask(question, sessionKey, onProgress);
      const filtered = filterSecrets(response.text, this.deps.secretPatterns);
      console.log(`[${ctx.logId}] agent reply len=${response.text.length} filtered=${filtered !== response.text}`);
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
}
