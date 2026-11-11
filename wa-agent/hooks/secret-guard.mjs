#!/usr/bin/env node
// PreToolUse guard (PLAN 2.7, 2.10): deny Write/Edit that would put credentials or personal IDs into the wiki
// or the agent memory dir. Port of the Mac hooks/secret_guard.py: same scope idea, same fail-closed rule (an
// in-scope path whose scanner cannot run is denied), values are never echoed. The scanner is secret_scan.py
// from the pinned claude-config (phase 3 copies it next to this file), run as `python3 secret_scan.py --stdin`.
// Scope roots become $HOME/.claude/wiki and $HOME/.claude/agent-memory (Mac: its own wiki root and any /memory/ dir).
// No env override for the scanner path: a settings `env` key could otherwise swap in a scanner that finds nothing.
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRAGMA = /allow-file/i;
const SCANNER = join(dirname(fileURLToPath(import.meta.url)), "secret_scan.py");

function real(p) {
  try { return realpathSync(p); } catch { /* new file: resolve the parent */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
}

export function inScope(path, home) {
  if (!path) return false;
  const p = resolve(path);
  const roots = [...new Set([home, real(home)])].flatMap((h) => [join(h, ".claude", "wiki"), join(h, ".claude", "agent-memory")]);
  return [p, real(p)].some((c) => roots.some((r) => c === r || c.startsWith(r + sep)));
}

export function textsFrom(ti) {
  const out = [];
  for (const k of ["content", "new_string"]) if (typeof ti[k] === "string") out.push(ti[k]);
  for (const e of Array.isArray(ti.edits) ? ti.edits : []) if (e && typeof e.new_string === "string") out.push(e.new_string);
  return out;
}

// scan(text) -> array of kind strings; throws when the scanner cannot run. Default: the python scanner.
export function defaultScan(text, scanner = SCANNER) {
  const r = spawnSync("python3", ["-I", scanner, "--stdin"], { input: text, encoding: "utf8", timeout: 8000 });
  if (r.error || r.status === null || r.status === 2) throw new Error(r.error?.message ?? r.stderr ?? "scanner failed");
  return r.status === 0 ? [] : [...new Set(r.stdout.split("\n").map((l) => l.split(": ")[1]).filter(Boolean))];
}

// Returns a denial reason or null.
export function evaluate(input, { home = process.env.HOME || homedir(), scan = defaultScan } = {}) {
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const path = typeof ti.file_path === "string" ? ti.file_path : "";
  if (!inScope(path, home)) return null;
  // secret_scan.py skips any file with its `allow-file` pragma in the first 5 lines, so such a write would carry a secret
  // past it. Checked before the scanner, on every text, and on the bare token because an Edit can assemble the pragma
  // piece by piece. (hooks/wiki-git/pre-commit and wiki-sync.sh check commits for the same pragma.)
  if (textsFrom(ti).some((t) => PRAGMA.test(t))) return `Secret guard: content for ${path} carries the scanner's allow-file marker, which would hide secrets from the scan. Remove it and retry.`;
  let kinds;
  try { kinds = scan(textsFrom(ti).join("\n")); } catch { return `Secret guard could not run its scanner; refusing to write to ${path}.`; }
  if (!kinds.length) return null;
  return `Secret guard: finding(s) of ${kinds.sort().join(", ")} in content for ${path}. Remove credentials or personal data (write a placeholder such as \${VAR} or describe where the secret lives) and retry.`;
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch (e) { process.stderr.write(`secret-guard: ${e.message}\n`); process.exit(2); }
  const reason = evaluate(input);
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
