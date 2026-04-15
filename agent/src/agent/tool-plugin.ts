export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolPlugin {
  /** Set by the loader from folder name. Builtin plugin uses "builtin". */
  name: string;

  /** Called once at startup with parsed config.yaml content. */
  init(config: Record<string, any>): Promise<void>;

  /** Optional cleanup on shutdown. */
  destroy?(): Promise<void>;

  /** Tool definitions with names WITHOUT prefix (loader adds "{folder}." prefix). */
  getToolDefinitions(): ToolDefinition[];

  /** Execute a tool by its unprefixed name. Returns result string or error string. */
  executeTool(name: string, input: Record<string, any>): Promise<string>;

  /** Tool names (unprefixed) that are cheap/local and don't count against expensive limit. */
  getCheapTools?(): string[];

  /** Human-readable summary of tool input for progress reporting. */
  summarizeInput?(name: string, input: Record<string, any>): string;

  /** Extra text appended to the agent system prompt describing this plugin's tools. */
  getSystemPromptAddendum?(): string;

  /** Additional regex patterns for secret filtering in tool output. */
  getSecretPatterns?(): RegExp[];

  /** Optional custom output filter. Called on agent's final response text before sending to user.
   *  Use for structured filtering that regex patterns can't handle (e.g. replacing hostnames with aliases). */
  filterOutput?(text: string): string;

  /** Called after ALL plugins are loaded and registered. Start background services here. */
  start?(context: PluginContext): Promise<void>;

  /** Called on app shutdown, before destroy(). Stop background services here. */
  stop?(): Promise<void>;

  /** Return command handler for /{plugin-name} subcommands. */
  getCommandHandlers?(): PluginCommandHandler;
}

/** Core capabilities exposed to plugins that need them (e.g., sending Feishu messages). */
export interface PluginContext {
  sendFeishuMessage(chatId: string, msgType: string, content: string): Promise<void>;
  /** Simple text-in, text-out LLM call for plugin background tasks. No tool use or streaming. */
  callLLM?(options: {
    system: string;
    prompt: string;
    maxTokens?: number;
    model?: string;
    timeoutMs?: number;
  }): Promise<string>;
}

/** Context passed to command handlers when a user invokes /{plugin-name} {subcommand}. */
export interface CommandCallContext {
  userId: string;
  chatType: "p2p" | "group";
  chatId: string;
  logId: string;
}

/** Command handler returned by plugins. Subcommands keyed by name. */
export interface PluginCommandHandler {
  subcommands: Record<
    string,
    {
      description: string;
      handle(args: string[], context: CommandCallContext): Promise<string>;
    }
  >;
}
