import type { Channel, ChannelMessageContext } from "./channel.js";
import type { AgentInvoker } from "../agent/invoker.js";
import type { ToolRegistry } from "../agent/tool-registry.js";
import { parseCommand } from "../commands/router.js";
import { handleNew, handleContext, handleHelp } from "../commands/session-commands.js";
import { filterSecrets } from "./feishu/secret-filter.js";

export class ChannelRouter {
  constructor(
    private agent: AgentInvoker,
    private toolRegistry: ToolRegistry,
    private secretPatterns: RegExp[],
  ) {}

  async handleMessage(
    channel: Channel,
    context: ChannelMessageContext,
    text: string,
  ): Promise<void> {
    const parsed = parseCommand(text);

    if (parsed.type === "command") {
      await this.handleCommand(channel, context, parsed.command, parsed.subcommand, parsed.args);
      return;
    }

    await this.handleQuestion(channel, context, parsed.text);
  }

  private async handleCommand(
    channel: Channel,
    context: ChannelMessageContext,
    command: string,
    subcommand: string | undefined,
    args: string[],
  ): Promise<void> {
    const sessionKey = channel.getSessionKey(context);

    // Builtin session commands
    if (command === "new") {
      const result = handleNew(this.agent, sessionKey);
      await channel.sendReply(context, result);
      return;
    }
    if (command === "context") {
      const result = handleContext(this.agent, sessionKey);
      await channel.sendReply(context, result);
      return;
    }
    if (command === "help") {
      const result = handleHelp(true);
      await channel.sendReply(context, result);
      return;
    }

    // Plugin commands
    const callCtx = {
      userId: context.userId,
      chatType: "p2p" as const,
      chatId: context.channelName,
      logId: context.messageId ?? "",
    };
    const result = await this.toolRegistry.handleCommand(command, subcommand ?? "", args, callCtx);
    if (result !== null) {
      await channel.sendReply(context, result);
      return;
    }

    await channel.sendReply(context, `未知命令: /${command}`);
  }

  private async handleQuestion(
    channel: Channel,
    context: ChannelMessageContext,
    question: string,
  ): Promise<void> {
    const sessionKey = channel.getSessionKey(context);

    const onProgress = (info: string) => {
      channel.sendProgress?.(context, info);
    };

    try {
      const response = await this.agent.ask(question, sessionKey, onProgress);
      const secretFiltered = filterSecrets(response.text, this.secretPatterns);
      const filtered = this.toolRegistry.filterOutput(secretFiltered);
      await channel.sendReply(context, filtered);
    } catch (e: any) {
      const code = e.status ?? e.code ?? "UNKNOWN";
      await channel.sendReply(context, `处理失败 (code: ${code})\n请稍后重试。`);
    }
  }
}
