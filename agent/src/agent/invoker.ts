import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFileSync } from "fs";
import { join } from "path";
import type { ToolRegistry } from "./tool-registry.js";
import type { ZhiliaoDB } from "../db.js";
import { compressHistory, type CompressorConfig } from "./session-compressor.js";

export interface AgentConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider?: string; // "anthropic" | "openai_compatible"
  systemPrompt: string;
  memoUrl: string;
  timezone?: string;
}

export interface AgentResponse {
  text: string;
  sessionId: string;
  sessionExpired?: boolean;
}

export type ProgressCallback = (info: string) => void;

// Unified internal types for provider-agnostic agentic loop
interface LLMTextBlock { type: "text"; text: string }
interface LLMToolCallBlock { type: "tool_use"; id: string; name: string; input: Record<string, any> }
type LLMContentBlock = LLMTextBlock | LLMToolCallBlock;

interface LLMResponse {
  content: LLMContentBlock[];
  stopReason: "tool_use" | "end_turn" | string;
  inputTokens: number;
  outputTokens: number;
  // Raw content for storing in history
  rawAssistantContent: any;
}

interface SessionEntry {
  history: Array<any>; // Provider-specific message format
  lastAccessedAt: number;
  createdAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface SessionStats {
  exists: boolean;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastAccessedAt: number;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 50;
const TRUNCATE_RECENT_WINDOW = 10;
const TOOL_RESULT_TRUNCATE_CHARS = 500;
const TOKEN_SOFT_LIMIT = 80000;
export const MAX_TOOL_ITERATIONS = 20;

// Hard cap on total iterations (cheap + expensive) to prevent infinite loops
const MAX_TOTAL_ITERATIONS = 50;

const LLM_TIMEOUT_MS = 120_000; // 120 seconds per LLM call
const LLM_MAX_RETRIES = 2; // 2 retries = 3 total attempts
const LLM_RETRY_DELAYS = [1000, 3000]; // backoff delays in ms

export const DEFAULT_SOUL_PROMPT = `# 知了 (Zhiliao)

你是知了，一个 Git 仓库知识助手。你帮助用户理解代码库，回答关于代码、架构和近期变更的问题。

## 性格

- **严谨**: 回答基于代码事实，不猜测。引用具体文件路径和行号。
- **简洁直接**: 先给结论，再展开细节。不说废话。
- **友好专业**: 语气像一个靠谱的同事，不是冷冰冰的机器。

## 特色

- 确认用户的好发现时会说「棒！」或「Great!」
- 发现代码中有趣的设计时会主动点评`;

export class AgentInvoker {
  private anthropicClient: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;
  private config: AgentConfig;
  private db: ZhiliaoDB | null = null;
  private compressorConfig: CompressorConfig | null = null;
  private tools: ToolRegistry | null = null;
  private sessionLocks = new Map<string, Promise<void>>();

  private get isOpenAI(): boolean {
    return this.config.provider === "openai_compatible";
  }

  constructor(config: AgentConfig) {
    this.config = config;
    if (config.provider === "openai_compatible") {
      this.openaiClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: LLM_TIMEOUT_MS,
      });
    } else {
      this.anthropicClient = new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseURL && { baseURL: config.baseURL }),
        timeout: LLM_TIMEOUT_MS,
      });
    }
  }

  setDB(db: ZhiliaoDB): void {
    this.db = db;
  }

  setCompressorConfig(config: CompressorConfig): void {
    this.compressorConfig = config;
  }

  setTools(tools: ToolRegistry): void {
    this.tools = tools;
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    this.sessionLocks.set(sessionId, next);

    try {
      await prev;
      return await fn();
    } finally {
      resolve!();
      // Clean up if this is the last waiter
      if (this.sessionLocks.get(sessionId) === next) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  async ask(question: string, sessionId: string, onProgress?: ProgressCallback): Promise<AgentResponse> {
    return this.withSessionLock(sessionId, () => this.doAsk(question, sessionId, onProgress));
  }

  private async doAsk(question: string, sessionId: string, onProgress?: ProgressCallback): Promise<AgentResponse> {
    let sessionExpired = false;

    const entry = this.loadOrCreateSession(sessionId);

    // Check if session is expired
    if (Date.now() - entry.lastAccessedAt > SESSION_TTL_MS) {
      sessionExpired = true;
      entry.history = [];
      entry.totalInputTokens = 0;
      entry.totalOutputTokens = 0;
      entry.createdAt = Date.now();
    }

    entry.lastAccessedAt = Date.now();
    this.pushUserMessage(entry, question);

    // Trim history
    this.trimHistory(entry);

    const toolDefs = this.tools?.getToolDefinitions() ?? [];

    const addendum = this.tools?.getSystemPromptAddendum() ?? "";
    const tz = this.config.timezone;
    const now = new Date();
    const dateStr = tz
      ? now.toLocaleDateString("sv-SE", { timeZone: tz })           // YYYY-MM-DD
      : now.toISOString().split("T")[0];
    const timeStr = tz
      ? now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
      : now.toTimeString().split(" ")[0].slice(0, 5);
    const dateLine = `\n\nCurrent date and time: ${dateStr} ${timeStr}${tz ? ` (${tz})` : ""}`;
    const effectivePrompt = this.config.systemPrompt + dateLine + (addendum ? `\n\n${addendum}` : "");

    let finalText = "";
    let expensiveIterations = 0;
    let totalIterations = 0;

    for (;;) {
      totalIterations++;

      const response = await this.callLLMWithRetry(entry.history, toolDefs, effectivePrompt);
      entry.totalInputTokens += response.inputTokens;
      entry.totalOutputTokens += response.outputTokens;

      // Extract text and tool call blocks
      const textParts = response.content
        .filter((b): b is LLMTextBlock => b.type === "text")
        .map((b) => b.text);

      const toolCalls = response.content.filter(
        (b): b is LLMToolCallBlock => b.type === "tool_use"
      );

      console.log(`[${sessionId}] llm iter=${totalIterations} tokens=${response.inputTokens}+${response.outputTokens} tools=${toolCalls.map(c => c.name).join(",") || "none"} stop=${response.stopReason}`);

      if (toolCalls.length === 0 || response.stopReason !== "tool_use") {
        // No tool calls — done
        finalText = textParts.join("\n").trim();
        entry.history.push(response.rawAssistantContent);
        break;
      }

      // Only count iterations with expensive (non-local) tools
      const hasExpensiveTool = toolCalls.some((c) => !this.tools?.isCheapTool(c.name));
      if (hasExpensiveTool) expensiveIterations++;

      entry.history.push(response.rawAssistantContent);

      // Execute tools and add results to history
      const toolResultPairs: Array<{ id: string; name: string; input: Record<string, any>; result: string }> = [];
      for (const call of toolCalls) {
        const inputSummary = this.tools?.summarizeToolInput(call.name, call.input) ?? "";
        if (onProgress) {
          onProgress(`tool: ${call.name}(${inputSummary})`);
        }

        const result = this.tools
          ? await this.tools.executeTool(call.name, call.input)
          : `Tool not available: ${call.name}`;
        toolResultPairs.push({ id: call.id, name: call.name, input: call.input, result });
      }

      this.pushToolResults(entry, toolResultPairs);

      // If hit either limit, make one final call WITHOUT tools to force a summary
      if (expensiveIterations >= MAX_TOOL_ITERATIONS || totalIterations >= MAX_TOTAL_ITERATIONS) {
        const finalResponse = await this.callLLMWithRetry(entry.history, [], effectivePrompt);
        entry.totalInputTokens += finalResponse.inputTokens;
        entry.totalOutputTokens += finalResponse.outputTokens;
        const finalParts = finalResponse.content
          .filter((b): b is LLMTextBlock => b.type === "text")
          .map((b) => b.text);
        finalText = finalParts.join("\n") || "(无法生成回复，请重试)";
        entry.history.push(finalResponse.rawAssistantContent);
        break;
      }
    }

    // Compress if approaching token limit
    if (entry.totalInputTokens > TOKEN_SOFT_LIMIT && this.compressorConfig) {
      await this.compressOldMessages(entry);
    }

    this.saveSession(sessionId, entry);

    const text = sessionExpired
      ? `（之前的会话已过期，已重新开始为您服务）\n\n${finalText || "(空回复，请重试)"}`
      : finalText || "(空回复，请重试)";

    return { text, sessionId, sessionExpired };
  }

  // ---- Provider-specific LLM call and message formatting ----

  private async callLLM(history: any[], toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>, systemPrompt: string): Promise<LLMResponse> {
    if (this.isOpenAI) {
      return this.callOpenAI(history, toolDefs, systemPrompt);
    }
    return this.callAnthropic(history, toolDefs, systemPrompt);
  }

  private async callAnthropic(history: any[], toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>, systemPrompt: string): Promise<LLMResponse> {
    const tools = toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    const createParams: Anthropic.MessageCreateParams = {
      model: this.config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: history,
    };
    if (tools.length > 0) {
      createParams.tools = tools;
    }

    const response = await this.anthropicClient!.messages.create(createParams, {
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    const content: LLMContentBlock[] = response.content.map((b) => {
      if (b.type === "text") return { type: "text" as const, text: b.text };
      if (b.type === "tool_use") return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input as Record<string, any> };
      return { type: "text" as const, text: "" };
    });

    return {
      content,
      stopReason: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      rawAssistantContent: { role: "assistant", content: response.content },
    };
  }

  private async callOpenAI(history: any[], toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>, systemPrompt: string): Promise<LLMResponse> {
    // Convert tool definitions to OpenAI format
    const tools: OpenAI.ChatCompletionTool[] = toolDefs.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    // Build messages: system prompt + history
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...history,
    ];

    const params: OpenAI.ChatCompletionCreateParams = {
      model: this.config.model,
      max_tokens: 4096,
      messages,
    };
    if (tools.length > 0) {
      params.tools = tools;
    }

    const response = await this.openaiClient!.chat.completions.create(params, {
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const choice = response.choices[0];
    const msg = choice.message;

    const content: LLMContentBlock[] = [];
    if (msg.content) {
      content.push({ type: "text", text: msg.content });
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        const fn = (tc as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall).function;
        let args: Record<string, any> = {};
        try { args = JSON.parse(fn.arguments); } catch { /* empty */ }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: fn.name,
          input: args,
        });
      }
    }

    const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

    return {
      content,
      stopReason,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      // Store raw OpenAI assistant message for history
      rawAssistantContent: { role: "assistant" as const, content: msg.content ?? null, tool_calls: msg.tool_calls ?? undefined },
    };
  }

  private static isTransientError(err: any): boolean {
    // AbortSignal.timeout() throws a DOMException with name "TimeoutError"
    if (err.name === "TimeoutError") return true;
    const code = err.code ?? "";
    if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) {
      return true;
    }
    const status = err.status ?? err.statusCode ?? 0;
    return status >= 500 || status === 408 || status === 429;
  }

  private async callLLMWithRetry(
    history: any[],
    toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    systemPrompt: string,
  ): Promise<LLMResponse> {
    let lastError: any;
    for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
      try {
        return await this.callLLM(history, toolDefs, systemPrompt);
      } catch (err: any) {
        lastError = err;
        if (attempt < LLM_MAX_RETRIES && AgentInvoker.isTransientError(err)) {
          const delay = LLM_RETRY_DELAYS[attempt] ?? 3000;
          console.warn(`LLM call failed (attempt ${attempt + 1}/${LLM_MAX_RETRIES + 1}): ${err.message}, retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError; // unreachable, but satisfies TypeScript
  }

  /** Push a user text message in the correct provider format */
  private pushUserMessage(entry: SessionEntry, text: string): void {
    entry.history.push({ role: "user", content: text });
  }

  /** Push tool results in the correct provider format */
  private pushToolResults(entry: SessionEntry, results: Array<{ id: string; name: string; input: Record<string, any>; result: string }>): void {
    if (this.isOpenAI) {
      // OpenAI: each tool result is a separate message with role "tool"
      for (const r of results) {
        entry.history.push({
          role: "tool" as const,
          tool_call_id: r.id,
          content: r.result,
        });
      }
    } else {
      // Anthropic: tool results are bundled in a single user message
      const toolResults = results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.result,
      }));
      entry.history.push({ role: "user", content: toolResults });
    }
  }

  private loadOrCreateSession(sessionId: string): SessionEntry {
    if (this.db) {
      const row = this.db.loadSession(sessionId);
      if (row) {
        return {
          history: JSON.parse(row.history),
          lastAccessedAt: row.lastAccessedAt,
          createdAt: row.createdAt,
          totalInputTokens: row.totalInputTokens,
          totalOutputTokens: row.totalOutputTokens,
        };
      }
    }
    return {
      history: [],
      lastAccessedAt: Date.now(),
      createdAt: Date.now(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }

  private saveSession(sessionId: string, entry: SessionEntry): void {
    if (this.db) {
      this.db.saveSession(
        sessionId,
        JSON.stringify(entry.history),
        entry.totalInputTokens,
        entry.totalOutputTokens,
        entry.createdAt,
        entry.lastAccessedAt
      );
    }
  }

  /** Trim history to MAX_HISTORY_MESSAGES, keeping it starting with a user message */
  private trimHistory(entry: SessionEntry): void {
    if (entry.history.length <= MAX_HISTORY_MESSAGES) return;

    // Keep last N messages, but ensure assistant text messages in the trimmed portion are preserved
    const recent = entry.history.slice(-MAX_HISTORY_MESSAGES);

    // Ensure starts with user message
    while (recent.length > 0 && recent[0].role !== "user") {
      recent.shift();
    }

    // Truncate old tool results for messages outside the recent window
    this.truncateOldToolResults(entry, recent.length);

    entry.history = recent;
  }

  /** Truncate tool_result content for messages older than TRUNCATE_RECENT_WINDOW */
  private truncateOldToolResults(entry: SessionEntry, recentKept: number): void {
    const cutoff = entry.history.length - recentKept - TRUNCATE_RECENT_WINDOW;
    for (let i = 0; i < Math.max(0, cutoff); i++) {
      const msg = entry.history[i];
      // Anthropic format: user message with tool_result array
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j];
          if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > TOOL_RESULT_TRUNCATE_CHARS) {
            msg.content[j] = { ...block, content: block.content.slice(0, TOOL_RESULT_TRUNCATE_CHARS) + "...[truncated]" };
          }
        }
      }
      // OpenAI format: tool message with string content
      if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_RESULT_TRUNCATE_CHARS) {
        msg.content = msg.content.slice(0, TOOL_RESULT_TRUNCATE_CHARS) + "...[truncated]";
      }
    }
  }

  /** Compress older half of history into a summary message */
  private async compressOldMessages(entry: SessionEntry): Promise<void> {
    if (entry.history.length < 6) return; // Not enough to compress

    const mid = Math.floor(entry.history.length / 2);
    const oldPart = entry.history.slice(0, mid);
    const recentPart = entry.history.slice(mid);

    try {
      const summary = await compressHistory(this.compressorConfig!, oldPart);
      const summaryMsg = {
        role: "user" as const,
        content: `[系统] 以下是之前对话的摘要:\n${summary}`,
      };

      entry.history = [summaryMsg, ...recentPart];
    } catch (e: any) {
      console.error(`Session compression failed: ${e.message}`);
    }
  }

  clearSession(sessionId: string): void {
    if (this.db) {
      this.db.deleteSession(sessionId);
    }
  }

  getSessionStats(sessionId: string): SessionStats {
    if (this.db) {
      const row = this.db.loadSession(sessionId);
      if (row) {
        const history = JSON.parse(row.history) as Array<any>;
        return {
          exists: true,
          messageCount: history.length,
          totalInputTokens: row.totalInputTokens,
          totalOutputTokens: row.totalOutputTokens,
          createdAt: row.createdAt,
          lastAccessedAt: row.lastAccessedAt,
        };
      }
    }
    return { exists: false, messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0, createdAt: 0, lastAccessedAt: 0 };
  }

  cleanExpiredSessions(): number {
    if (this.db) {
      return this.db.cleanExpiredSessions(SESSION_TTL_MS);
    }
    return 0;
  }

  static loadSystemPrompt(agentDir: string): string {
    try {
      return readFileSync(join(agentDir, "CLAUDE.md"), "utf-8");
    } catch {
      return "You are Zhiliao (知了), a Git repository knowledge assistant.";
    }
  }

  static loadSoulPrompt(configDir: string): string {
    const soulPath = join(configDir, "SOUL.md");
    try {
      return readFileSync(soulPath, "utf-8");
    } catch {
      return DEFAULT_SOUL_PROMPT;
    }
  }
}
