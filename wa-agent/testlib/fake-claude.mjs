#!/usr/bin/env node
// Fake `claude` for tests (lives outside test/ so `node --test` does not run it as a test file): replays a fixture instead of calling a model (no network, no credentials).
// argv[2] = control dir. It holds `script.json` (fixture names, consumed in order, last one repeats) and
// receives `calls.jsonl` ({argv, env, cwd, stdin_is_tty}) per invocation. Fixture `hang` waits for SIGTERM.
// The placeholder __SID__ becomes the --resume id, or a new `sess-N`.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv: args, env: process.env, cwd: process.cwd() }) + "\n");
const counter = join(dir, "counter");
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
const script = JSON.parse(readFileSync(join(dir, "script.json"), "utf8"));
const name = script[Math.min(n, script.length - 1)];
const fixDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const r = args.indexOf("--resume");
const sid = r >= 0 ? args[r + 1] : `sess-${n + 1}`;
// guard-lines.jsonl simulates what the PreToolUse guard hook appends to $HOME/.claude/guard.log during a turn
if (existsSync(join(dir, "guard-lines.jsonl")) && process.env.HOME) appendFileSync(join(process.env.HOME, ".claude", "guard.log"), readFileSync(join(dir, "guard-lines.jsonl"), "utf8"));
const text = readFileSync(join(fixDir, `${name}.jsonl`), "utf8").replaceAll("__SID__", sid);
process.stdout.write(text);
if (name === "hang") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
}
