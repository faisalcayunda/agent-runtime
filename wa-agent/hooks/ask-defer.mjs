#!/usr/bin/env node
// PreToolUse hook for AskUserQuestion (PLAN 2.3 rank 1, hooks.md:2064).
// /xchg/answers/<tool_use_id>.json present: allow with updatedInput = the questions Claude emitted + the
// bridge's `answers` (question text -> chosen label, multi-select labels joined with commas).
// Otherwise: defer. Never throws into the turn: any problem means "defer".
// Changed from spike/defer-hook.mjs: no WA_XCHG_DIR override (a settings `env` key could point it at a
// forged answers dir); `decide` takes the directory as a parameter for tests.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function readAnswers(xchg, id) {
  // The id becomes a file name: allow only what a tool_use id can contain.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  try {
    const a = JSON.parse(readFileSync(join(xchg, "answers", `${id}.json`), "utf8")).answers;
    return a && typeof a === "object" && !Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

// Returns null (no opinion) or the hookSpecificOutput object.
export function decide(input, xchg = "/xchg") {
  if (input.tool_name && input.tool_name !== "AskUserQuestion") return null;
  const id = String(input.tool_use_id ?? "");
  const answers = readAnswers(xchg, id);
  if (answers && input.tool_input && typeof input.tool_input === "object") {
    return { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "answered by owner", updatedInput: { ...input.tool_input, answers } };
  }
  return { hookEventName: "PreToolUse", permissionDecision: "defer", permissionDecisionReason: "no answer yet" };
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* defer */ }
  const out = decide(input);
  if (!out) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + "\n");
  try {
    const home = process.env.HOME;
    mkdirSync(join(home, ".claude"), { recursive: true });
    appendFileSync(join(home, ".claude", "defer-hook.log"), JSON.stringify({ ts: new Date().toISOString(), tool_use_id: input.tool_use_id, session_id: input.session_id, decision: out.permissionDecision }) + "\n");
  } catch { /* logging is best effort */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
