import type { ToolPlugin, ToolDefinition, PluginContext, CommandCallContext } from "./tool-plugin.js";

const BUILTIN_PLUGIN_NAME = "builtin";

export class ToolRegistry {
  private plugins = new Map<string, ToolPlugin>();
  private cheapToolsCache = new Set<string>();
  private knownTools = new Set<string>();

  register(plugin: ToolPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }
    this.plugins.set(plugin.name, plugin);

    const prefix = plugin.name === BUILTIN_PLUGIN_NAME ? "" : `${plugin.name}.`;

    const cheapTools = plugin.getCheapTools?.() ?? [];
    for (const tool of cheapTools) {
      this.cheapToolsCache.add(`${prefix}${tool}`);
    }

    for (const def of plugin.getToolDefinitions()) {
      this.knownTools.add(`${prefix}${def.name}`);
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    const allDefs: ToolDefinition[] = [];
    for (const [name, plugin] of this.plugins) {
      const prefix = name === BUILTIN_PLUGIN_NAME ? "" : `${name}.`;
      for (const def of plugin.getToolDefinitions()) {
        allDefs.push({ ...def, name: `${prefix}${def.name}` });
      }
    }
    return allDefs;
  }

  async executeTool(fullName: string, input: Record<string, any>): Promise<string> {
    const dotIdx = fullName.indexOf(".");
    if (dotIdx === -1) {
      if (!this.knownTools.has(fullName)) return `Unknown tool: ${fullName}`;
      const builtin = this.plugins.get(BUILTIN_PLUGIN_NAME);
      if (!builtin) return `Unknown tool: ${fullName}`;
      return builtin.executeTool(fullName, input);
    }
    const pluginName = fullName.slice(0, dotIdx);
    const toolName = fullName.slice(dotIdx + 1);
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return `Unknown plugin: ${pluginName}`;
    return plugin.executeTool(toolName, input);
  }

  hasTool(fullName: string): boolean {
    return this.knownTools.has(fullName);
  }

  isCheapTool(fullName: string): boolean {
    return this.cheapToolsCache.has(fullName);
  }

  summarizeToolInput(fullName: string, input: Record<string, any>): string {
    const { plugin, toolName } = this.resolvePlugin(fullName);
    if (plugin?.summarizeInput) {
      return plugin.summarizeInput(toolName, input);
    }
    return JSON.stringify(input).slice(0, 60);
  }

  getSystemPromptAddendum(): string {
    const parts: string[] = [];
    for (const plugin of this.plugins.values()) {
      const addendum = plugin.getSystemPromptAddendum?.();
      if (addendum) parts.push(addendum);
    }
    return parts.join("\n\n");
  }

  getSecretPatterns(): RegExp[] {
    const patterns: RegExp[] = [];
    for (const plugin of this.plugins.values()) {
      const pluginPatterns = plugin.getSecretPatterns?.();
      if (pluginPatterns) patterns.push(...pluginPatterns);
    }
    return patterns;
  }

  filterOutput(text: string): string {
    let result = text;
    for (const plugin of this.plugins.values()) {
      if (plugin.filterOutput) {
        result = plugin.filterOutput(result);
      }
    }
    return result;
  }

  async handleCommand(
    pluginName: string,
    subcommand: string,
    args: string[],
    context: CommandCallContext
  ): Promise<string | null> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return null;
    const handler = plugin.getCommandHandlers?.();
    if (!handler) return null;
    const sub = handler.subcommands[subcommand];
    if (!sub) return null;
    return sub.handle(args, context);
  }

  async startAll(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.start) {
        await plugin.start(context);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.stop) {
        await plugin.stop();
      }
    }
  }

  async destroyAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.destroy?.();
    }
  }

  private resolvePlugin(fullName: string): { plugin: ToolPlugin | undefined; toolName: string } {
    const dotIdx = fullName.indexOf(".");
    if (dotIdx === -1) {
      return { plugin: this.plugins.get(BUILTIN_PLUGIN_NAME), toolName: fullName };
    }
    return { plugin: this.plugins.get(fullName.slice(0, dotIdx)), toolName: fullName.slice(dotIdx + 1) };
  }
}
