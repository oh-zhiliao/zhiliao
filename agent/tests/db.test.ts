import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ZhiliaoDB } from "../src/db.js";
import { rmSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";

const TEST_DB = join(import.meta.dirname, ".tmp-test.sqlite");

function createSchemaV2Database(path: string): void {
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      last_poll_at INTEGER,
      last_scan_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS repo_admins (
      repo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      PRIMARY KEY (repo_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS repo_notify_targets (
      repo_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      notify_enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (repo_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      history TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );
  `);
  raw
    .prepare(
      `INSERT INTO _meta (key, value) VALUES ('schema_version', '2')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run();
  raw.close();
}

describe("ZhiliaoDB", () => {
  let db: ZhiliaoDB;

  beforeEach(() => {
    db = new ZhiliaoDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DB, { force: true });
  });

  describe("sessions", () => {
    it("saveSession + loadSession round-trip", () => {
      const now = Date.now();
      db.saveSession("sess-1", '{"messages":[]}', 100, 200, now, now);

      const loaded = db.loadSession("sess-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.history).toBe('{"messages":[]}');
      expect(loaded!.totalInputTokens).toBe(100);
      expect(loaded!.totalOutputTokens).toBe(200);
      expect(loaded!.createdAt).toBe(now);
      expect(loaded!.lastAccessedAt).toBe(now);
    });

    it("saveSession upserts (updates existing session)", () => {
      const now = Date.now();
      db.saveSession("sess-1", '{"v":1}', 10, 20, now, now);
      db.saveSession("sess-1", '{"v":2}', 30, 40, now, now + 1000);

      const loaded = db.loadSession("sess-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.history).toBe('{"v":2}');
      expect(loaded!.totalInputTokens).toBe(30);
      expect(loaded!.totalOutputTokens).toBe(40);
      expect(loaded!.lastAccessedAt).toBe(now + 1000);
      // createdAt should remain the original value (not updated by upsert)
      expect(loaded!.createdAt).toBe(now);
    });

    it("loadSession returns null for non-existent key", () => {
      const result = db.loadSession("nonexistent-key");
      expect(result).toBeFalsy();
    });

    it("deleteSession removes the session", () => {
      const now = Date.now();
      db.saveSession("sess-del", '{"data":true}', 5, 10, now, now);
      expect(db.loadSession("sess-del")).not.toBeNull();

      db.deleteSession("sess-del");
      expect(db.loadSession("sess-del")).toBeFalsy();
    });

    it("cleanExpiredSessions removes old sessions and keeps recent ones", () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;

      // Recent session (1 hour ago)
      db.saveSession("sess-recent", '{}', 0, 0, oneHourAgo, oneHourAgo);
      // Old session (3 days ago)
      db.saveSession("sess-old", '{}', 0, 0, threeDaysAgo, threeDaysAgo);

      // Clean with 1-day TTL
      const ttlMs = 24 * 60 * 60 * 1000;
      const removed = db.cleanExpiredSessions(ttlMs);

      expect(removed).toBe(1);
      expect(db.loadSession("sess-recent")).not.toBeNull();
      expect(db.loadSession("sess-old")).toBeFalsy();
    });
  });

  describe("roles", () => {
    it("assigns, lists, and revokes chat roles", () => {
      db.assignChatRole("oc_chat_1", "prod_readonly", "ou_admin");

      expect(db.getChatRole("oc_chat_1")).toBe("prod_readonly");
      expect(db.listChatRoles()).toEqual([
        { chatId: "oc_chat_1", role: "prod_readonly" },
      ]);

      db.revokeChatRole("oc_chat_1");
      expect(db.getChatRole("oc_chat_1")).toBeNull();
    });

    it("stores fallback roles and resolves explicit chat role before fallback", () => {
      db.setChatTypeDefaultRole("group", "default", "ou_admin");

      expect(db.getChatTypeDefaultRole("group")).toBe("default");
      expect(db.resolveFeishuRole("oc_group_1", "group")).toEqual({
        role: "default",
        source: "chat_type_default",
      });

      db.assignChatRole("oc_group_1", "prod_admin", "ou_admin");
      expect(db.resolveFeishuRole("oc_group_1", "group")).toEqual({
        role: "prod_admin",
        source: "chat",
      });
    });

    it("rejects invalid role values", () => {
      expect(() => db.assignChatRole("oc_chat_1", "", "ou_admin")).toThrow("Invalid role");
      expect(() => db.setChatTypeDefaultRole("group", "bad role", "ou_admin")).toThrow("Invalid role");
    });

    it("seeds rollout defaults only when upgrading an existing database", () => {
      db.close();
      rmSync(TEST_DB, { force: true });
      createSchemaV2Database(TEST_DB);

      const upgraded = new ZhiliaoDB(TEST_DB);
      try {
        expect(upgraded.getChatTypeDefaultRole("group")).toBe("default");
        expect(upgraded.getChatTypeDefaultRole("p2p")).toBe("default");
      } finally {
        upgraded.close();
      }
    });

    it("does not seed defaults for fresh databases", () => {
      expect(db.getChatTypeDefaultRole("group")).toBeNull();
      expect(db.getChatTypeDefaultRole("p2p")).toBeNull();
    });
  });

});
