import express from "express";
import type { AgentInvoker } from "./agent/invoker.js";
import type { ToolRegistry } from "./agent/tool-registry.js";
import { parseCommand } from "./commands/router.js";
import { handleNew, handleContext, handleHelp } from "./commands/session-commands.js";
import { filterSecrets } from "./channels/feishu/secret-filter.js";

export interface ApiServerDeps {
  agent: AgentInvoker;
  toolRegistry: ToolRegistry;
  secretPatterns?: RegExp[];
}

export function createApiServer(deps: ApiServerDeps): express.Application {
  const app = express();
  app.use(express.json());

  app.post("/api/chat", async (req, res) => {
    const { text, user_id = "api_user", session_key = "api:default" } = req.body;
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const parsed = parseCommand(text);

    try {
      if (parsed.type === "command") {
        const { command, subcommand, args } = parsed;

        // Builtin session commands
        if (command === "new") {
          res.json({ type: "command", response: handleNew(deps.agent, session_key) });
          return;
        }
        if (command === "context") {
          res.json({ type: "command", response: handleContext(deps.agent, session_key) });
          return;
        }
        if (command === "help") {
          res.json({ type: "command", response: handleHelp(true) });
          return;
        }

        // Plugin commands
        const callCtx = { userId: user_id, chatType: "p2p" as const, chatId: "api", logId: "api" };
        const result = await deps.toolRegistry.handleCommand(command, subcommand ?? "", args, callCtx);
        if (result !== null) {
          res.json({ type: "command", response: result });
          return;
        }

        res.json({ type: "command", response: `未知命令: /${command}` });
        return;
      }

      const response = await deps.agent.ask(parsed.text, session_key);
      const secretFiltered = filterSecrets(response.text, deps.secretPatterns);
      const filtered = deps.toolRegistry.filterOutput(secretFiltered);
      res.json({ type: "question", response: filtered, session_expired: response.sessionExpired });
    } catch (e: any) {
      console.error("API error:", e);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
