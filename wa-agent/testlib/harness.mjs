// Test harness: a real runner on a temp unix socket driving test/fake-claude.mjs, plus socket clients.
import net from "node:net";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { createRunner } from "../src/runner.mjs";
import { attach, send } from "../src/ipc.mjs";
import { ROOT, waitFor } from "./helpers.mjs";

// Everything a test opens is closed after the file, so a failed assertion cannot leave a server holding the process.
const open = [];
after(async () => { for (const c of open.splice(0)) await c(); });

export async function startRunner(S, { script = ["plain"], env = {}, ...opts } = {}) {
  const ctl = join(S.dir, "ctl");
  mkdirSync(ctl, { recursive: true });
  writeFileSync(join(ctl, "script.json"), JSON.stringify(script));
  const agentDir = join(S.dir, "agent"), assetsDir = join(S.dir, "assets");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  const logs = [];
  const runner = createRunner({
    home: S.home, xchg: S.xchg, agentDir, assetsDir, eventPollMs: 30, log: (m) => logs.push(m),
    claudeBin: process.execPath, claudeArgsPrefix: [join(ROOT, "testlib", "fake-claude.mjs"), ctl],
    model: "role-exec", projectId: "proj-1",
    env: { HOME: S.home, PATH: process.env.PATH, ANTHROPIC_MODEL: "role-exec", ...env },
    ...opts,
  });
  const sock = await runner.listen();
  open.push(() => runner.close());
  const calls = () => (existsSync(join(ctl, "calls.jsonl")) ? readFileSync(join(ctl, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { runner, ctl, sock, calls, logs, agentDir, assetsDir };
}

// Raw client: no handshake, nothing answered. Used for attackers and for the handshake itself.
export function raw(sockPath) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sockPath);
    open.push(() => s.destroy());
    const events = [];
    attach(s, (m) => events.push(m));
    s.on("error", reject);
    s.on("connect", () => resolve({
      events, socket: s,
      send: (m) => send(s, m),
      wait: (pred, ms = 5000) => waitFor(() => events.find(pred), ms),
      of: (ev) => events.filter((e) => e.ev === ev),
      close: () => s.destroy(),
    }));
  });
}

// Bridge: answers the runner's challenge by writing the nonce file only a bridge-owned dir can hold (PLAN B2).
// Tool: pass {role: "tool", lane, token}. Also works against a runner that sends no challenge.
export async function connect(sockPath, hello, { xchg } = {}) {
  const c = await raw(sockPath);
  c.send({ op: "hello", ...hello });
  if (hello.role === "bridge" && xchg !== null) {
    const ch = await c.wait((e) => e.ev === "challenge" || e.ev === "hello" || e.ev === "error");
    if (ch.ev === "challenge") {
      const dir = xchg ?? join(sockPath, "..", "..");
      writeFileSync(join(dir, "answers", `.hello-${ch.nonce}`), "");
      c.send({ op: "auth", nonce: ch.nonce });
    }
  }
  await c.wait((e) => e.ev === "hello" || e.ev === "error");
  return c;
}

// One tool-style call with the lane's own token (minted by the runner, as a running turn would receive it).
export async function toolCall(R, lane, op, payload = {}) {
  const token = R.runner.issueToken(lane);
  const c = await connect(R.sock, { role: "tool", lane, token });
  const rid = Math.random().toString(36).slice(2);
  c.send({ op, rid, ...payload });
  const r = await c.wait((e) => e.ev === "reply" && e.rid === rid);
  c.close();
  return r;
}
