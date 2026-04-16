import type { AgentInvoker, SessionStats } from "../agent/invoker.js";

export function handleNew(agent: AgentInvoker, sessionKey: string): string {
  const stats = agent.getSessionStats(sessionKey);
  agent.clearSession(sessionKey);
  if (stats.exists) {
    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
    return `会话已重置。\n（已清除 ${stats.messageCount} 条消息，共 ${totalTokens.toLocaleString()} tokens）`;
  }
  return "当前没有活跃会话，无需重置。";
}

export function handleContext(agent: AgentInvoker, sessionKey: string): string {
  const stats = agent.getSessionStats(sessionKey);
  if (!stats.exists) {
    return "当前没有活跃会话。发送消息后可查看会话信息。";
  }
  const ageMin = Math.round((Date.now() - stats.createdAt) / 60000);
  const ageStr = ageMin < 60 ? `${ageMin} 分钟` : `${Math.floor(ageMin / 60)} 小时 ${ageMin % 60} 分钟`;
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const compressed = stats.hasCompression ? " (已压缩)" : "";
  return [
    `当前会话信息:`,
    `- Session: ${sessionKey}`,
    `- 消息数: ${stats.messageCount}${compressed}`,
    `- Tokens: ${totalTokens.toLocaleString()} (入 ${stats.totalInputTokens.toLocaleString()} / 出 ${stats.totalOutputTokens.toLocaleString()})`,
    `- 会话时长: ${ageStr}`,
  ].join("\n");
}

export function handleHelp(isDM: boolean): string {
  const lines = [
    "知了命令列表:",
    "",
    "**会话管理:**",
    "- /new — 重置当前会话上下文",
    "- /context — 查看当前会话信息（消息数、token 用量、时长）",
    "- /help — 显示此帮助信息",
    "",
    "插件命令格式: /{插件名} {子命令}",
  ];
  return lines.join("\n");
}
