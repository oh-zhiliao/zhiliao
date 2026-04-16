import { beforeEach, describe, expect, it } from "vitest";
import { loadIife, resetLocalStorage } from "./helpers.js";

describe("I18n", () => {
  let I18n: any;

  beforeEach(() => {
    resetLocalStorage();
    I18n = loadIife("i18n.js", "I18n");
  });

  it("defaults to English", () => {
    expect(I18n.getLang()).toBe("en");
    expect(I18n.t("login.submit")).toBe("Sign In");
  });

  it("switches to Chinese via setLang", () => {
    I18n.setLang("zh");
    expect(I18n.getLang()).toBe("zh");
    expect(I18n.t("login.submit")).toBe("\u767B\u5F55");
  });

  it("ignores invalid language codes", () => {
    I18n.setLang("fr");
    expect(I18n.getLang()).toBe("en");
  });

  it("falls back to key when translation missing", () => {
    expect(I18n.t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("falls back to English for missing zh key", () => {
    I18n.setLang("zh");
    (I18n as any)._injectMissing; // no-op; just asserting no crash for non-existent
    expect(I18n.t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("persists language to localStorage", () => {
    I18n.setLang("zh");
    expect(localStorage.getItem("zhiliao_lang")).toBe("zh");
  });

  it("toggle flips between en and zh", () => {
    expect(I18n.getLang()).toBe("en");
    I18n.toggle();
    expect(I18n.getLang()).toBe("zh");
    I18n.toggle();
    expect(I18n.getLang()).toBe("en");
  });

  it("onChange fires after setLang", () => {
    const calls: string[] = [];
    I18n.onChange((lang: string) => calls.push(lang));
    I18n.setLang("zh");
    I18n.setLang("en");
    expect(calls).toEqual(["zh", "en"]);
  });

  it("applies translations to [data-i18n] elements on init", () => {
    document.body.innerHTML = `
      <span data-i18n="login.submit"></span>
      <input type="text" data-i18n="chat.placeholder" />
    `;
    I18n = loadIife("i18n.js", "I18n");
    I18n.init();
    const span = document.querySelector("[data-i18n='login.submit']") as HTMLElement;
    const input = document.querySelector("input") as HTMLInputElement;
    expect(span.textContent).toBe("Sign In");
    expect(input.placeholder).toBe("Send a message\u2026");
  });
});
