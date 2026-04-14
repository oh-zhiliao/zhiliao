import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { parse } from "yaml";
import type { ToolPlugin } from "./tool-plugin.js";

function substituteEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (match, name) => {
    const value = process.env[name];
    if (value === undefined) return match;
    return value;
  });
}

export async function loadPlugins(pluginsDir: string): Promise<ToolPlugin[]> {
  if (!existsSync(pluginsDir)) {
    return [];
  }

  const entries = readdirSync(pluginsDir);
  const plugins: ToolPlugin[] = [];

  for (const entry of entries) {
    const pluginPath = join(pluginsDir, entry);
    if (!statSync(pluginPath).isDirectory()) continue;

    try {
      const plugin = await loadOnePlugin(pluginPath, entry);
      if (plugin) {
        plugins.push(plugin);
      }
    } catch (err: any) {
      console.error(`Failed to load plugin "${entry}": ${err.message}`);
    }
  }

  return plugins;
}

async function loadOnePlugin(pluginPath: string, folderName: string): Promise<ToolPlugin | null> {
  const configPath = join(pluginPath, "config.yaml");
  if (!existsSync(configPath)) {
    return null;
  }

  const rawConfig = readFileSync(configPath, "utf-8");
  const config = parse(substituteEnvVars(rawConfig)) ?? {};

  if (config.enabled === false) {
    console.log(`Plugin "${folderName}" disabled, skipping`);
    return null;
  }

  const pkgPath = join(pluginPath, "package.json");
  if (existsSync(pkgPath) && !existsSync(join(pluginPath, "node_modules"))) {
    console.warn(`Plugin "${folderName}" has package.json but no node_modules — run npm install in ${pluginPath}`);
  }

  let entryFile: string | null = null;
  // Prefer compiled output (dist/) over source (src/) for Node.js compatibility
  for (const dir of [join(pluginPath, "dist"), join(pluginPath, "src")]) {
    for (const ext of ["index.js", "index.ts"]) {
      const candidate = join(dir, ext);
      if (existsSync(candidate)) {
        entryFile = candidate;
        break;
      }
    }
    if (entryFile) break;
  }
  if (!entryFile) {
    throw new Error(`No {dist,src}/index.{js,ts} found`);
  }

  const modulePath = resolve(entryFile);
  const mod = await import(modulePath);
  const PluginClass = mod.default;
  if (!PluginClass || typeof PluginClass !== "function") {
    throw new Error(`Module does not default-export a class`);
  }

  const plugin: ToolPlugin = new PluginClass();
  plugin.name = folderName;
  await plugin.init(config);

  const toolCount = plugin.getToolDefinitions().length;
  console.log(`Plugin loaded: ${folderName} (${toolCount} tools)`);

  return plugin;
}
