import { describe, it, expect } from "vitest";
import { parseCommand, type ParsedCommand } from "../../src/commands/router.js";

describe("parseCommand", () => {
  it("parses /repo add command", () => {
    const result = parseCommand("/repo add git@github.com:org/project.git");
    expect(result).toEqual({
      type: "command",
      command: "repo",
      subcommand: "add",
      args: ["git@github.com:org/project.git"],
    });
  });

  it("parses /repo list", () => {
    const result = parseCommand("/repo list");
    expect(result).toEqual({
      type: "command",
      command: "repo",
      subcommand: "list",
      args: [],
    });
  });

  it("parses /repo remove with name", () => {
    const result = parseCommand("/repo remove my-project");
    expect(result).toEqual({
      type: "command",
      command: "repo",
      subcommand: "remove",
      args: ["my-project"],
    });
  });

  it("parses /repo notify", () => {
    const result = parseCommand("/repo notify my-project oc_chat123");
    expect(result).toEqual({
      type: "command",
      command: "repo",
      subcommand: "notify",
      args: ["my-project", "oc_chat123"],
    });
  });

  it("parses /repo grant", () => {
    const result = parseCommand("/repo grant ou_user123");
    expect(result).toEqual({
      type: "command",
      command: "repo",
      subcommand: "grant",
      args: ["ou_user123"],
    });
  });

  it("parses /status command", () => {
    const result = parseCommand("/status");
    expect(result).toEqual({
      type: "command",
      command: "status",
      subcommand: undefined,
      args: [],
    });
  });

  it("returns question type for non-command text", () => {
    const result = parseCommand("What does the login function do?");
    expect(result).toEqual({ type: "question", text: "What does the login function do?" });
  });

  it("returns question type for text with @mention prefix stripped", () => {
    const result = parseCommand("How does auth work?");
    expect(result).toEqual({ type: "question", text: "How does auth work?" });
  });
});
