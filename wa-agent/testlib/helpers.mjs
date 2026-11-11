// Shared test helpers: real temp dirs (realpath'd: macOS maps /var to /private/var), fake binaries, polling.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Short base path: unix socket paths are limited to about 104 bytes on macOS.
const made = [];
process.on("exit", () => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
export const tmp = (p = "wa-") => { const d = realpathSync(mkdtempSync(join("/tmp", p))); made.push(d); return d; };

// A fake machine: HOME with .claude/, an xchg tree and a fake-bin dir. Nothing here touches the real ~/.claude.
export function sandbox() {
  const dir = tmp();
  const home = join(dir, "home"), xchg = join(dir, "xchg"), bin = join(dir, "bin");
  for (const d of [join(home, ".claude", "wiki"), join(home, ".claude", "agent-memory"), join(home, "assistant"), join(xchg, "answers"), join(xchg, "grants"), join(xchg, "events"), join(xchg, "inbox"), join(xchg, "sock"), bin]) mkdirSync(d, { recursive: true });
  return { dir, home, xchg, bin };
}

export function fakeBin(bin, name, script) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 4000, step = 10) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(step);
  }
}
