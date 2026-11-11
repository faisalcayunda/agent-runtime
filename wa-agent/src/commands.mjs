// Owner slash commands (PLAN phase 2 table): /baru, /status, /stop, /memori. They are handled before routing, so a
// command is never consumed as the answer to a pending question. Anything else starting with "/" is a normal message.
const COMMANDS = new Set(["baru", "status", "stop", "memori"]);

export function parseCommand(text) {
  const m = /^\s*\/([a-z]+)\s*$/i.exec(text);
  const c = m?.[1].toLowerCase();
  return c && COMMANDS.has(c) ? c : null;
}
