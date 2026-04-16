import { loadConfig } from "./config.js";
import { ZhiliaoDB } from "./db.js";
import { AgentInvoker } from "./agent/invoker.js";
import { ToolRegistry } from "./agent/tool-registry.js";
import { loadPlugins } from "./agent/tool-loader.js";
import { MemoToolsPlugin } from "./builtin/memo-tools.js";
import { FeishuClient } from "./channels/feishu/client.js";
import { FeishuAdapter } from "./channels/feishu/adapter.js";
import { ChannelRouter } from "./channels/channel-router.js";
import { existsSync, mkdirSync } from "fs";
import { createWebChatServer } from "./channels/webchat/server.js";
import { hashSync } from "bcryptjs";
import { randomBytes } from "crypto";
import { join, dirname, resolve } from "path";
import type { PluginContext } from "./agent/tool-plugin.js";

async function main() {
  // Bootstrap global HTTP proxy agent for environments behind a proxy.
  // Maps standard http_proxy/https_proxy to GLOBAL_AGENT_ vars, then removes the
  // originals so axios doesn't ALSO try to proxy (which causes URL concatenation bugs).
  if (process.env.http_proxy || process.env.https_proxy) {
    process.env.GLOBAL_AGENT_HTTP_PROXY = process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.http_proxy || "";
    process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.GLOBAL_AGENT_HTTPS_PROXY || process.env.https_proxy || "";
    process.env.GLOBAL_AGENT_NO_PROXY = process.env.GLOBAL_AGENT_NO_PROXY || process.env.no_proxy || "";
    // Remove lowercase/uppercase vars so axios doesn't double-proxy
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    // @ts-ignore -- no type declarations for global-agent
    const globalAgent = await import("global-agent");
    globalAgent.bootstrap();
  }

  const configPath = process.argv[2] || "config.yaml";

  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error("Copy config.example.yaml to config.yaml and edit it.");
    process.exit(1);
  }

  console.log(`Loading config from ${configPath}...`);
  const config = loadConfig(configPath);
  console.log(`Project: ${config.project.name}`);

  // Ensure data directories exist (relative to config file location)
  const dataDir = resolve(dirname(configPath), "data");
  for (const sub of ["repos", "memo", "memo/memory", "memo/dialog"]) {
    mkdirSync(join(dataDir, sub), { recursive: true });
  }

  // Initialize core components
  const db = new ZhiliaoDB(join(dataDir, "db.sqlite"));
  console.log(`Database initialized`);

  // Memo URL — single source of truth for agent compressor + builtin memo-tools
  const memoUrl = config.memo?.url || process.env.MEMO_URL || "http://localhost:8090";

  // Initialize agent with tools
  const soulPrompt = AgentInvoker.loadSoulPrompt(dirname(configPath));
  const systemPrompt = soulPrompt + "\n\n---\n\n" + AgentInvoker.loadSystemPrompt("prompt");
  const agent = new AgentInvoker({
    apiKey: config.llm.agent.api_key || "",
    baseURL: config.llm.agent.base_url,
    model: config.llm.agent.model,
    provider: config.llm.agent.provider,
    systemPrompt,
    memoUrl,
    timezone: config.project.timezone,
  });

  // Load tools from plugins
  const toolRegistry = new ToolRegistry();
  const pluginsDir = join(dirname(configPath), "plugins");
  const plugins = await loadPlugins(pluginsDir);
  for (const plugin of plugins) {
    toolRegistry.register(plugin);
  }

  // Register builtin memo-tools (unless explicitly disabled)
  if (config.memo?.enabled !== false) {
    const memoDataDir = config.memo?.data_dir || join(dataDir, "memo");
    const memoPlugin = new MemoToolsPlugin(memoUrl, memoDataDir);
    toolRegistry.register(memoPlugin);
  }

  agent.setTools(toolRegistry);
  const pluginSecretPatterns = toolRegistry.getSecretPatterns();
  const channelRouter = new ChannelRouter(agent, toolRegistry, pluginSecretPatterns);
  agent.setDB(db);
  // Configure session compressor with memo LLM (cheaper model for summarization)
  if (config.llm.memo?.api_key && config.llm.memo?.base_url) {
    agent.setCompressorConfig({
      apiKey: config.llm.memo.api_key,
      baseURL: config.llm.memo.base_url,
      model: config.llm.memo.model,
    });
  }
  console.log(`Agent model: ${config.llm.agent.model} | Tools: ${toolRegistry.getToolDefinitions().length} | Plugins: ${plugins.length}`);

  // Initialize Feishu
  const feishuClient = new FeishuClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
  });

  const maxMessageAgeMs = config.feishu.max_message_age_seconds
    ? config.feishu.max_message_age_seconds * 1000
    : undefined;

  const adapter = new FeishuAdapter({
    client: feishuClient,
    agent,
    toolRegistry,
    secretPatterns: pluginSecretPatterns,
    maxMessageAgeMs,
    admins: config.admins,
  });

  feishuClient.onMessage((data) => {
    adapter.handleMessage(data).catch((err) => {
      console.error("Error handling message:", err);
    });
  });

  // Start plugin background services
  const pluginContext: PluginContext = {
    sendFeishuMessage: (chatId, msgType, content) =>
      feishuClient.sendToChat(chatId, msgType, content),
    callLLM: (options) => agent.simpleLLMCall(options),
  };
  await toolRegistry.startAll(pluginContext);

  // Clean expired sessions every hour
  const sessionCleanupTimer = setInterval(() => {
    const removed = agent.cleanExpiredSessions();
    if (removed > 0) console.log(`Cleaned ${removed} expired sessions`);
  }, 60 * 60 * 1000);

  // Connect to Feishu
  console.log("Connecting to Feishu...");
  await feishuClient.connect();
  console.log("Zhiliao is running. Listening for messages...");

  // Optional WebChat server
  let webchatServer: { start: () => void; stop: () => void } | null = null;
  if (config.webchat?.enabled) {
    const rawPassword = config.webchat.password ?? "changeme";
    const passwordHash = rawPassword.startsWith("$2") ? rawPassword : hashSync(rawPassword, 10);
    const jwtSecret = (!config.webchat.jwt_secret || config.webchat.jwt_secret === "auto")
      ? randomBytes(32).toString("hex")
      : config.webchat.jwt_secret;
    const port = config.webchat.port ?? 8080;

    webchatServer = createWebChatServer(
      { port, passwordHash, jwtSecret },
      channelRouter,
      agent,
      toolRegistry,
      pluginSecretPatterns,
    );
    webchatServer.start();
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    clearInterval(sessionCleanupTimer);
    webchatServer?.stop();
    await toolRegistry.stopAll();
    await toolRegistry.destroyAll();
    feishuClient.disconnect();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
