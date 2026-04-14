import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ZhiliaoDB } from "../src/db.js";
import { rmSync } from "fs";
import { join } from "path";

const TEST_DB = join(import.meta.dirname, ".tmp-test.sqlite");

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

});
