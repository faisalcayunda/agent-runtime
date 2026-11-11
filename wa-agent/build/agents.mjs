#!/usr/bin/env node
// Build-time handling of the subagents carried from faisalcayunda/claude-config (PLAN 2.9). No dependencies.
//   node agents.mjs strip <agentsDir> <skillsDir>   drop 7 files, edit 2, strip pointers to skills/rules that do not exist here
//   node agents.mjs check <agentsDir> <skillsDir>   exit 1 if a kept agent names a skill outside <skillsDir>, a /Users/ path,
//                                                   or an mcp__ server other than owner and context7
// Every edit asserts that it matched, so an upstream rename or rewrite fails the image build instead of passing silently.
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DROP = [
  "context-manager.md", "gan-evaluator.md", "e2e-runner.md", "chief-of-staff.md",
  "swift-build-resolver.md", "swift-reviewer.md", "harmonyos-app-resolver.md",
];
export const MCP_ALLOWED = new Set(["owner", "context7"]);
// ui-ux-designer has no `model:` and would inherit the main model. A design reviewer is opus work (owner routing rule);
// the worker maps the opus alias to a Claude combo (worker-boot.sh, ANTHROPIC_DEFAULT_OPUS_MODEL).
export const UI_UX_MODEL = "opus";

const NAME = /^[a-z][a-z0-9-]*$/;

// Skill names a single line points at: `skills/<x>` paths, "skill: x", and backticked names on a line that says skill(s).
export function lineRefs(line) {
  const out = new Set();
  for (const m of line.matchAll(/\bskills\/([A-Za-z0-9_-]+)/g)) out.add(m[1]);
  for (const m of line.matchAll(/\bskills?:\s*`?([a-z][a-z0-9-]*)/gi)) out.add(m[1]);
  if (/\bskills?\b/i.test(line)) for (const m of line.matchAll(/`([^`]+)`/g)) if (NAME.test(m[1])) out.add(m[1]);
  return [...out];
}

// All refs of a file as [lineNo, name]; also the leading backticked name of each bullet under a "...skills...:" line.
export function fileRefs(text) {
  const lines = text.split("\n"), out = [];
  let inList = false;
  lines.forEach((l, i) => {
    for (const n of lineRefs(l)) out.push([i + 1, n]);
    if (inList) {
      const m = /^\s*[-*]\s+`([a-z][a-z0-9-]*)`/.exec(l);
      if (m) out.push([i + 1, m[1]]);
      else if (l.trim() && !/^\s+\S/.test(l)) inList = false; // a non-indented non-bullet line ends the list
    }
    if (/\bskills\b[^\n]*:\s*$/i.test(l)) inList = true;
  });
  return out;
}

export function skillNames(skillsDir) {
  return new Set(readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md"))).map((e) => e.name));
}

export function problems(file, text, known) {
  const out = [];
  for (const [n, name] of fileRefs(text)) if (!known.has(name)) out.push(`${file}:${n}: skill not in the four assets: ${name}`);
  text.split("\n").forEach((l, i) => {
    if (/\/Users\/[A-Za-z0-9._-]/.test(l)) out.push(`${file}:${i + 1}: /Users/ path`); // "/Users/[A-Za-z]" (a regex in opensource-sanitizer) is not a path
    for (const m of l.matchAll(/mcp__([A-Za-z0-9-]+)/g)) if (!MCP_ALLOWED.has(m[1])) out.push(`${file}:${i + 1}: mcp server not allowed: ${m[1]}`);
    if (/^mcpServers\s*:/.test(l)) out.push(`${file}:${i + 1}: mcpServers in frontmatter`);
  });
  return out;
}

export function check(agentsDir, skillsDir) {
  const known = skillNames(skillsDir), out = [];
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) out.push(...problems(f, readFileSync(join(agentsDir, f), "utf8"), known));
  return out;
}

function mustReplace(file, text, re, to) {
  if (!re.test(text)) throw new Error(`${file}: expected text not found: ${re}`);
  return text.replace(re, to);
}

// File-specific edits, each asserted. Regexes use headings and phrases, not line numbers.
const EDITS = {
  "data-engineer.md": (f, t) => mustReplace(f, t, /## Mandatory Skills[\s\S]*?These are mandatory[^\n]*\n\n?/, ""),
  "ui-ux-designer.md": (f, t) => {
    if (/^model:/m.test(t)) throw new Error(`${f}: already has a model, edit no longer needed`);
    return mustReplace(f, t, /^(name: ui-ux-designer\n)/m, `$1model: ${UI_UX_MODEL}\n`);
  },
  // Blocks of "use these skills" bullets (names do not contain the word "skill" on every line, so line rules miss them).
  "homelab-architect.md": (f, t) => mustReplace(f, t, /^Use these focused skills when[^\n]*\n\n(?:[-*] [^\n]*\n(?:  [^\n]*\n)*)+\n?/m, ""),
  "network-architect.md": (f, t) => {
    t = mustReplace(f, t, /^Use these focused skills when[^\n]*\n\n(?:[-*] [^\n]*\n(?:  [^\n]*\n)*)+\n?/m, "");
    return mustReplace(f, t, /^### Handoff To Focused Skills\n(?:- `[^`]+`:[^\n]*\n)+/m, "");
  },
  "marketing-agent.md": (f, t) => mustReplace(f, t, /^(?:Use `skills\/marketing-campaign`[^\n]*|Delegate [^\n]* to `(?:brand-voice|content-engine)`\.)\n/gm, ""),
  "a11y-architect.md": (f, t) => mustReplace(f, t, /^- \*\*Apply the Accessibility Skill\*\*[^\n]*\n/m, ""),
  "agent-evaluator.md": (f, t) => mustReplace(f, t, / from the `agent-self-evaluation` skill/, ""),
};

// Drops lines that point at a skill that is not installed or at rules/ files, then headings those deletions left empty
// (a heading that was already empty upstream, like a template stub, stays).
function stripLines(text, known) {
  const kept = []; // {l, lost}: lost = a line under this heading (before the next heading) was deleted
  let head = null, dropped = false;
  for (const l of text.split("\n")) {
    if (/`rules\/[^`]+`/.test(l) || !lineRefs(l).every((n) => known.has(n))) { dropped = true; if (head) head.lost = true; continue; }
    const e = { l, lost: false };
    if (/^#{1,6} /.test(l)) head = e;
    kept.push(e);
  }
  if (!dropped) return text; // untouched agents stay byte-identical to upstream
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const h = /^(#{2,4}) /.exec(kept[i].l);
    if (h && kept[i].lost) {
      let j = i + 1;
      while (j < kept.length && kept[j].l.trim() === "") j++;
      const next = j < kept.length ? /^(#{1,6}) /.exec(kept[j].l) : null;
      // empty section: end of file, a rule, or a heading of the same or a higher level comes next (a sub-heading is content)
      if (j >= kept.length || /^---\s*$/.test(kept[j].l) || (next && next[1].length <= h[1].length)) { i = j - 1; continue; }
    }
    out.push(kept[i].l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function strip(agentsDir, skillsDir) {
  const known = skillNames(skillsDir), log = [];
  for (const f of DROP) { unlinkSync(join(agentsDir, f)); log.push(`dropped ${f}`); } // throws when missing: no -f on purpose
  for (const [f, fn] of Object.entries(EDITS)) {
    const p = join(agentsDir, f);
    writeFileSync(p, fn(f, readFileSync(p, "utf8")));
    log.push(`edited ${f}`);
  }
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
    const p = join(agentsDir, f), t = readFileSync(p, "utf8"), n = stripLines(t, known);
    if (n !== t) { writeFileSync(p, n); log.push(`stripped pointers in ${f}`); }
  }
  return log;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, agents, skills] = process.argv.slice(2);
  if (!["strip", "check"].includes(cmd) || !agents || !skills) { process.stderr.write("usage: agents.mjs strip|check <agentsDir> <skillsDir>\n"); process.exit(2); }
  if (cmd === "strip") process.stdout.write(strip(agents, skills).join("\n") + "\n");
  const bad = check(agents, skills);
  if (bad.length) { process.stderr.write(bad.join("\n") + `\nagents check FAILED: ${bad.length} problem(s)\n`); process.exit(1); }
  process.stdout.write(`agents check ok: ${readdirSync(agents).filter((x) => x.endsWith(".md")).length} agents\n`);
}
