// Newline-delimited JSON over the runner's unix socket (/xchg/sock/run.sock). Shared by the runner, the bridge
// and the owner MCP. The protocol has no "send to JID" operation: the bridge sends only to the owner (PLAN 5.1).
import { LineSplitter } from "./stream.mjs";

export function send(socket, obj) {
  if (socket && !socket.destroyed && socket.writable) socket.write(JSON.stringify(obj) + "\n");
}

// Calls onMessage(obj) for each complete JSON line; a malformed line is dropped.
export function attach(socket, onMessage) {
  const split = new LineSplitter();
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    for (const line of split.push(chunk)) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === "object" && !Array.isArray(m)) onMessage(m);
    }
  });
}
