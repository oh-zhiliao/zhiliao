export interface CommandResult {
  type: "command";
  command: string;
  subcommand: string | undefined;
  args: string[];
}

export interface QuestionResult {
  type: "question";
  text: string;
}

export type ParsedCommand = CommandResult | QuestionResult;

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) {
    return { type: "question", text: trimmed };
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1); // remove leading /
  const subcommand = parts[1];
  const args = parts.slice(2);

  if (!subcommand || subcommand.startsWith("/")) {
    return { type: "command", command, subcommand: undefined, args: [] };
  }

  return { type: "command", command, subcommand, args };
}
