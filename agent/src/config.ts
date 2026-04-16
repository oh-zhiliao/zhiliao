import { readFileSync } from "fs";
import { parse } from "yaml";

export interface ZhiliaoConfig {
  project: { name: string; timezone?: string };
  feishu: {
    app_id: string;
    app_secret: string;
    event_mode: string;
    max_message_age_seconds?: number;
  };
  llm: {
    agent: { provider: string; model: string; base_url?: string; api_key?: string };
    memo: { provider: string; base_url: string; model: string; api_key?: string };
    embedding: { provider: string; base_url: string; model: string };
  };
  git?: {
    poll_interval_minutes: number;
    deep_scan_cron: string;
    ssh_key_path: string;
  };
  knowledge?: {
    decay_after_days: number;
    qa_compress_after_days: number;
    change_log_compress_after_days: number;
  };
  memo?: {
    enabled?: boolean;       // default true
    url?: string;            // default http://localhost:8090
    data_dir?: string;       // default <dataDir>/memo
  };
  admins?: string[];
  webchat?: {
    enabled?: boolean;    // default false
    port?: number;        // default 8080
    password?: string;    // bcrypt hash or plaintext (auto-hashed on first run)
    jwt_secret?: string;  // auto-generated if "auto" or missing
    feishu_auth?: {
      redirect_uri: string;                              // OAuth callback URL
      user_id_field?: "open_id" | "email" | "user_id";  // default "open_id"
      allowed_users?: string[];                          // empty/absent = allow all
    };
  };
}

function substituteEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (match, name) => {
    const value = process.env[name];
    if (value === undefined) {
      return match; // leave as-is if env var not set (secrets may be inline)
    }
    return value;
  });
}

function validateConfig(config: unknown): asserts config is ZhiliaoConfig {
  const c = config as any;
  const required: Array<[string, string]> = [
    ["project.name", c?.project?.name],
    ["feishu.app_id", c?.feishu?.app_id],
    ["feishu.app_secret", c?.feishu?.app_secret],
    ["llm.agent.model", c?.llm?.agent?.model],
  ];
  const missing = required.filter(([, v]) => v === undefined || v === null);
  if (missing.length > 0) {
    throw new Error(
      `Invalid config: missing required fields: ${missing.map(([k]) => k).join(", ")}`
    );
  }
}

export function loadConfig(path: string): ZhiliaoConfig {
  const raw = readFileSync(path, "utf-8");
  const substituted = substituteEnvVars(raw);
  const config = parse(substituted);
  validateConfig(config);
  return config;
}
