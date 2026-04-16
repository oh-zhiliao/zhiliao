import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIife, resetLocalStorage } from "./helpers.js";

describe("Store", () => {
  let Store: any;

  beforeEach(() => {
    resetLocalStorage();
    // Stub Auth + fetch used by deleteSession / purgeAll
    (globalThis as any).Auth = { getToken: () => null };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true });
    Store = loadIife("store.js", "Store");
  });

  describe("sessions", () => {
    it("getSessions returns empty list initially", () => {
      expect(Store.getSessions()).toEqual([]);
    });

    it("createSession adds a session at the front", () => {
      const s1 = Store.createSession("First");
      const s2 = Store.createSession("Second");
      const sessions = Store.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe(s2.id);
      expect(sessions[1].id).toBe(s1.id);
    });

    it("createSession uses default title when none given", () => {
      const s = Store.createSession();
      expect(s.title).toBe("New Chat");
    });

    it("getSession returns matching session", () => {
      const s = Store.createSession("X");
      expect(Store.getSession(s.id)).toMatchObject({ id: s.id, title: "X" });
      expect(Store.getSession("missing")).toBeNull();
    });

    it("updateSession merges updates and bumps updatedAt", () => {
      const s = Store.createSession("X");
      const originalUpdated = s.updatedAt;
      // Ensure the clock advances
      vi.useFakeTimers();
      vi.setSystemTime(originalUpdated + 1000);
      const updated = Store.updateSession(s.id, { title: "Y" });
      expect(updated.title).toBe("Y");
      expect(updated.updatedAt).toBeGreaterThan(originalUpdated);
      vi.useRealTimers();
    });

    it("updateSession returns null for missing id", () => {
      expect(Store.updateSession("missing", { title: "X" })).toBeNull();
    });

    it("deleteSession removes the session and its messages", () => {
      const s = Store.createSession("X");
      Store.addMessage(s.id, { role: "user", content: "hi" });
      expect(Store.getMessages(s.id).length).toBe(1);
      Store.deleteSession(s.id);
      expect(Store.getSession(s.id)).toBeNull();
      expect(Store.getMessages(s.id)).toEqual([]);
    });

    it("purgeAll clears all sessions and messages", () => {
      const s1 = Store.createSession("A");
      const s2 = Store.createSession("B");
      Store.addMessage(s1.id, { role: "user", content: "x" });
      Store.addMessage(s2.id, { role: "user", content: "y" });
      Store.purgeAll();
      expect(Store.getSessions()).toEqual([]);
      expect(Store.getMessages(s1.id)).toEqual([]);
      expect(Store.getMessages(s2.id)).toEqual([]);
    });
  });

  describe("messages", () => {
    it("addMessage assigns id + timestamp when missing", () => {
      const s = Store.createSession("X");
      const msg = Store.addMessage(s.id, { role: "user", content: "hi" });
      expect(msg.id).toBeTruthy();
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it("getMessages preserves insertion order", () => {
      const s = Store.createSession("X");
      Store.addMessage(s.id, { role: "user", content: "1" });
      Store.addMessage(s.id, { role: "bot", content: "2" });
      const msgs = Store.getMessages(s.id);
      expect(msgs.map((m: any) => m.content)).toEqual(["1", "2"]);
    });

    it("updateMessage merges updates by id", () => {
      const s = Store.createSession("X");
      const msg = Store.addMessage(s.id, { role: "bot", content: "orig" });
      Store.updateMessage(s.id, msg.id, { content: "updated" });
      const got = Store.getMessages(s.id)[0];
      expect(got.content).toBe("updated");
    });

    it("getLastMessage returns the newest message", () => {
      const s = Store.createSession("X");
      expect(Store.getLastMessage(s.id)).toBeNull();
      Store.addMessage(s.id, { role: "user", content: "1" });
      Store.addMessage(s.id, { role: "bot", content: "2" });
      expect(Store.getLastMessage(s.id).content).toBe("2");
    });

    it("trims to MAX_MESSAGES when exceeded", () => {
      const s = Store.createSession("X");
      for (let i = 0; i < 210; i++) {
        Store.addMessage(s.id, { role: "user", content: String(i) });
      }
      const msgs = Store.getMessages(s.id);
      expect(msgs.length).toBe(200);
      expect(msgs[0].content).toBe("10");
      expect(msgs[msgs.length - 1].content).toBe("209");
    });
  });
});
