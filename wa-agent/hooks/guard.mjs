#!/usr/bin/env node
// PreToolUse guard for Gremio (PLAN 5.2 deny list, 2.12 grants). Deterministic, no model.
// Extends spike/guard.mjs (kept untouched). Decisions kept from the spike:
//   - Deny: JSON `permissionDecision: "deny"` on stdout, exit 0 (Claude reads the reason).
//   - Not denied: NO output, exit 0. The guard never returns "allow" (hooks.md:1997): it would skip
//     the permission flow and make the guard the whole permission system.
//   - Bad stdin or an internal error: exit 2 (fail closed). The hook entry also sets onFailure: "block".
//   - Every decision is one JSON line in $HOME/.claude/guard.log (the runner reads pass-grant lines).
// Changes from the spike: `evaluate(input, ctx)` is importable (the owner MCP `permission` tool calls it),
// and there is no WA_XCHG_DIR override: a user-settings `env` key could otherwise point the guard at a
// forged grants directory. Tests pass `ctx.xchg` instead.
//
// Speed bump, not a boundary: the owner tokens can do all of this (PLAN 5.2). Since 2026-11-12 (owner decision: Gremio has full Multica
// access under its own account) the guard has no multica rule: no deny list, no comment prefix, no approval relay.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// Format of the code in a critical notify_owner (the owner MCP and its tests use it); no guard rule reads codes any more.
export const CODE_RE = /^[a-z0-9]{3,8}-[0-9]{3,6}$/i;
const GRANT_TTL_MS = 24 * 3600 * 1000;
const PROTECTED_BRANCH = /^(main|master|dev)$/;
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec", "nice", "timeout", "setsid", "stdbuf", "ionice"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = /^(python3?|node|perl|ruby|php|awk|gawk)$/;
const DB_CLIENT = /\b(psql|mysql|mariadb|sqlite3|trino|clickhouse-client|duckdb|pgcli|usql)\b/i;
const NO_SQL_SCAN = /^mcp__(owner|context7)__/;

const deny = (rule, reason) => ({ deny: true, rule, reason });

// ---------- shell lexing: argv lists, one per simple command ----------
function lex(s) {
  const segs = [];
  let cur = [], tok = "", has = false, q = null;
  const push = () => { if (has) cur.push(tok); tok = ""; has = false; };
  const end = () => { push(); if (cur.length) segs.push(cur); cur = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else tok += c; continue; }
    if (q === '"') {
      if (c === "\\" && i + 1 < s.length) { tok += s[++i]; continue; }
      if (c === '"') q = null; else tok += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\") { if (i + 1 < s.length) { tok += s[++i]; has = true; } continue; }
    if (c === " " || c === "\t") { push(); continue; }
    if (";&|\n()`".includes(c)) { end(); continue; }
    tok += c; has = true;
  }
  end();
  return segs;
}

// Strip env assignments and wrappers, return the real argv (or null).
function realArgv(argv) {
  const a = argv.slice();
  for (;;) {
    while (a.length && /^[A-Za-z_]\w*=/.test(a[0])) a.shift();
    if (!a.length) return null;
    if (!WRAPPERS.has(basename(a[0]))) return a;
    const w = basename(a.shift());
    while (a.length && (a[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(a[0]) || (w === "timeout" && /^\d/.test(a[0])))) a.shift();
  }
}

// ---------- paths ----------
const expandHome = (t, home) => t.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
const absPath = (t, ctx) => resolve(ctx.cwd || ctx.home, expandHome(t, ctx.home));
const inside = (p, dir) => p === dir || p.startsWith(dir + sep);
const strictlyInside = (p, dir) => p.startsWith(dir + sep);

function real(p) {
  try { return realpathSync(p); } catch { /* not there yet: resolve the parent */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
}
const homesOf = (ctx) => [...new Set([ctx.home, real(ctx.home)])];

// Claude Code loads CLAUDE.md, CLAUDE.local.md and .claude/ from the cwd and its parents, and the chat lane's cwd is ~/assistant.
// A task or group lane may write them only inside its own cwd (derived from its lane identity, not from the hook's cwd, which `cd` moves).
const INSTRUCTION_NAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", ".claude"]);
function instructionWrite(cand, ctx) {
  for (const h of homesOf(ctx)) {
    const a = join(h, "assistant");
    if (!strictlyInside(cand, a)) continue;
    const t = String(ctx.task ?? "");
    const own = ctx.lane === "group" && /^grp_[\d-]+$/.test(t) ? join(a, "groups", t.slice(4)) : ctx.lane === "task" && /^[\w-]{1,64}$/.test(t) ? join(a, "tasks", t) : null;
    if (own && inside(cand, own)) continue;
    if (cand.slice(a.length + 1).split(sep).some((x) => INSTRUCTION_NAMES.has(x))) return "instruction-file-write";
  }
  return null;
}

// Writes the model may never make (PLAN 2.7, 5.2): returns a rule name or null.
function protectedWrite(p, ctx) {
  for (const cand of new Set([p, real(p)])) {
    for (const h of homesOf(ctx)) {
      if (cand === join(h, ".claude.json")) return "policy-path-write";
      const claude = join(h, ".claude");
      if (!inside(cand, claude)) continue;
      const first = cand.slice(claude.length + 1).split(sep)[0];
      if (first === "wiki") continue;
      if (first === "agent-memory") { if (ctx.lane === "chat") continue; return "memory-write-not-chat-lane"; }
      return "policy-path-write";
    }
    if (ctx.lane !== "chat") { const r = instructionWrite(cand, ctx); if (r) return r; } // unknown lane fails closed
    if (inside(cand, "/opt") || inside(cand, "/etc")) return "policy-path-write";
    for (const d of ["answers", "grants", "events", "sock"]) if (inside(cand, join(ctx.xchg, d))) return "policy-path-write";
  }
  return null;
}
const WRITE_DENY_REASON = {
  "policy-path-write": "writes to ~/.claude (except wiki/), ~/.claude.json, /opt, /etc and /xchg/{answers,grants,events,sock} are never run by the agent",
  "instruction-file-write": "task and group lanes may write CLAUDE.md, CLAUDE.local.md and .claude/ only inside their own working directory, never under ~/assistant elsewhere",
  "memory-write-not-chat-lane": "only the chat lane writes ~/.claude/agent-memory; ask the chat lane (remember it in the task report)",
};
const writeDenied = (rule) => deny(rule, WRITE_DENY_REASON[rule]);

// ---------- grants (PLAN 2.12; format in spike/README.md plus kind approval) ----------
// /xchg/grants/<id>.json: {id, kind: merge|push-main (the bridge also still writes `approval` for done|deny codes; no rule reads it), url | task_id + branch, created_at, expires_at?}
// created_at / expires_at: epoch ms or ISO string. Effective expiry = min(expires_at, created_at + 24h).
// The guard only reads this dir. The bridge writes it and deletes it on the runner's grant-used report.
const GRANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const usedDir = (ctx) => join(ctx.home, ".claude", "grants-used");

// Single use (PLAN 2.12): the CLI claims each grant it let through by creating <home>/.claude/grants-used/<id> with
// O_EXCL, which is atomic, so two parallel tool calls cannot both use one grant. Returns false if any is already claimed.
// The permission tool never calls this: it only reads, through findGrant.
export function claimGrants(home, ids) {
  const dir = join(home, ".claude", "grants-used");
  mkdirSync(dir, { recursive: true });
  const taken = [];
  for (const id of ids) {
    try { closeSync(openSync(join(dir, id), "wx")); taken.push(id); } catch { return false; }
  }
  return true;
}
function findGrant(kind, match, ctx) {
  if (ctx.lane === "group") return null; // a group lane never uses a grant: they are the owner's, written from his own chat (PLAN 2.13)
  let files;
  try { files = readdirSync(join(ctx.xchg, "grants")).filter((f) => f.endsWith(".json")).sort(); } catch { return null; }
  const ms = (v) => (typeof v === "number" ? v : Date.parse(v));
  for (const f of files) {
    try {
      const id = f.replace(/\.json$/, "");
      if (!GRANT_ID_RE.test(id) || existsSync(join(usedDir(ctx), id))) continue; // already claimed by an earlier tool call
      const g = JSON.parse(readFileSync(join(ctx.xchg, "grants", f), "utf8"));
      if (g.kind !== kind) continue;
      const created = ms(g.created_at), expires = g.expires_at == null ? NaN : ms(g.expires_at);
      if (Number.isNaN(created) && Number.isNaN(expires)) continue;
      const exp = Math.min(Number.isNaN(expires) ? Infinity : expires, Number.isNaN(created) ? Infinity : created + GRANT_TTL_MS);
      if (!(exp > ctx.now)) continue;
      if (match(g)) return { id };
    } catch { /* unreadable grant: ignore */ }
  }
  return null;
}
const normUrl = (u) => String(u).replace(/[#?].*$/, "").replace(/\/+$/, "");

// ---------- command rules ----------
function ghRules(a, ctx) {
  const [sub, verb] = a.filter((t) => !t.startsWith("-"));
  if (sub === "repo" && verb === "delete") return deny("gh-repo-delete", "gh repo delete is never run by the agent");
  if (sub === "secret") return deny("gh-secret", "gh secret is never run by the agent");
  if (sub === "api") {
    let method = "";
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-X" || a[i] === "--method") method = a[i + 1] ?? "";
      else if (a[i].startsWith("--method=")) method = a[i].slice(9);
      else if (a[i].startsWith("-X") && a[i].length > 2) method = a[i].slice(2);
    }
    if (/^(DELETE|PATCH|PUT)$/i.test(method) && a.some((t) => /git\/refs/.test(t))) {
      return deny("gh-api-refs", `gh api -X ${method.toUpperCase()} on git/refs is never run by the agent`);
    }
    // Merging through the REST or GraphQL API needs the same merge grant as gh pr merge.
    if (a.some((t) => /mergePullRequest|enablePullRequestAutoMerge/i.test(t))) return deny("merge-no-grant", "merging through the GraphQL API is never run by the agent; use gh pr merge with the PR URL after the merge question");
    const m = a.map((t) => /(?:^|\/)repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)\/merge\b/.exec(t)).find(Boolean);
    if (m) {
      const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
      const g = findGrant("merge", (x) => x.url && normUrl(x.url) === url, ctx);
      return g ? { grants: [g.id], rule: "merge-grant" } : deny("merge-no-grant", `no merge grant for ${url}; ask the owner the merge question first`);
    }
  }
  if (sub === "pr" && verb === "merge") {
    const url = a.find((t) => /^https?:\/\//.test(t));
    if (!url) return deny("merge-needs-url", "gh pr merge needs the full PR URL so a merge grant can match it");
    const g = findGrant("merge", (x) => x.url && normUrl(x.url) === normUrl(url), ctx);
    return g ? { grants: [g.id], rule: "merge-grant" } : deny("merge-no-grant", `no merge grant for ${normUrl(url)}; ask the owner the merge question first`);
  }
  return null;
}

const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function pushRules(a, ctx, wiki) {
  if (wiki) return deny("wiki-push", "pushes to ~/.claude/wiki come only from wiki-sync.sh run by the runner, never from the model");
  let force = false, del = false, all = false, repoFlag = false;
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--") { pos.push(...a.slice(i + 1)); break; }
    if (t.startsWith("--")) {
      const name = t.split("=")[0];
      if (/^--force(-with-lease|-if-includes)?$/.test(name)) force = true;
      else if (name === "--delete") del = true;
      else if (name === "--mirror" || name === "--all" || name === "--prune") all = true;
      if (name === "--repo") repoFlag = true;
      if (PUSH_VALUE_FLAGS.has(name) && !t.includes("=")) i++;
    } else if (t.length > 1 && t[0] === "-") {
      if (t.slice(1).includes("f")) force = true;
      if (t.slice(1).includes("d")) del = true;
      if (t === "-o") i++;
    } else pos.push(t);
  }
  if (force) return deny("git-push-force", "force push is never run by the agent");
  if (all) return deny("git-push-all", "git push --all/--mirror/--prune is never run by the agent");
  const refspecs = repoFlag ? pos : pos.slice(1);
  if (!refspecs.length) return deny("git-push-no-refspec", "name the branch: git push <remote> <branch> (a bare push cannot be checked)");
  const grants = [];
  for (const r of refspecs) {
    if (r.startsWith("+")) return deny("git-push-force", "force push (+refspec) is never run by the agent");
    const parts = r.split(":");
    const isDelete = del || r.startsWith(":");
    const src = parts[0], dst = parts.length > 1 ? parts[1] : parts[0];
    if (parts.length === 1 && (src === "HEAD" || src === "@")) return deny("git-push-no-refspec", "name the branch: HEAD cannot be checked, use <src>:<branch>");
    const branch = dst.replace(/^refs\/heads\//, "");
    if (branch.includes("*") || branch === "") return deny("git-push-glob", `refspec ${r} cannot be checked`);
    if (!PROTECTED_BRANCH.test(branch)) continue;
    if (isDelete) return deny("git-push-delete-protected", `deleting ${branch} on the remote is never run by the agent`);
    const g = findGrant("push-main", (x) => ctx.task && x.task_id === ctx.task && (x.branch == null || x.branch === branch), ctx);
    if (!g) return deny("git-push-protected", `push to ${branch} needs a push-main grant for this task; open a PR instead`);
    if (!grants.includes(g.id)) grants.push(g.id);
  }
  return grants.length ? { grants, rule: "push-main-grant" } : null;
}

function gitRules(a, ctx) {
  let i = 0, wiki = ctx.wikiHint;
  const wikiDir = (h) => join(h, ".claude", "wiki");
  while (i < a.length && a[i].startsWith("-")) {
    if (a[i] === "-C" || a[i] === "--git-dir" || a[i] === "--work-tree") {
      const p = absPath(a[i + 1] ?? "", ctx);
      if (homesOf(ctx).some((h) => inside(p, wikiDir(h)) || inside(real(p), wikiDir(h)))) wiki = true;
    }
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(a[i]) ? 2 : 1;
  }
  const sub = a[i];
  if (sub === "push") return pushRules(a.slice(i + 1), ctx, wiki);
  const rest = a.slice(i + 1);
  if (sub === "reset" && rest.includes("--hard")) return deny("git-reset-hard", "git reset --hard is never run by the agent");
  if (sub === "clean" && rest.some((t) => /^-[a-z]*f/.test(t))) return deny("git-clean-force", "git clean -f is never run by the agent");
  if (sub === "branch" && rest.includes("-D")) return deny("git-branch-force-delete", "git branch -D is never run by the agent");
  return null;
}

// wa_send_media (PLAN 2.14): the runner and the bridge check the path again; this is the first of three checks, so a group lane never even
// asks to send ~/assistant outside its own folder. Chat and task lanes: ~/assistant or /xchg/inbox. A group lane: its own folder
// ~/assistant/groups/<id> (the bridge checks that an inbox file arrived in that group). Every spelling of the path, links resolved, must pass.
function mediaPath(ti, ctx) {
  const raw = String(ti.path ?? "");
  if (!raw) return null; // the tool says what is missing
  const task = String(ctx.task ?? "");
  const p = absPath(raw, ctx);
  for (const cand of new Set([p, real(p)])) {
    const inbox = strictlyInside(cand, join(ctx.xchg, "inbox"));
    const ok = ctx.lane === "group"
      ? inbox || (/^grp_[\d-]+$/.test(task) && homesOf(ctx).some((h) => strictlyInside(cand, join(h, "assistant", "groups", task.slice(4)))))
      : inbox || homesOf(ctx).some((h) => strictlyInside(cand, join(h, "assistant")));
    if (!ok) return deny("media-path", ctx.lane === "group" ? "a group chat can send files only from its own folder ~/assistant/groups/<id> or ones that arrived in that group" : "wa_send_media sends only files under ~/assistant or /xchg/inbox");
  }
  return null;
}

const SQL_DROP = /\bdrop\s+(table|database|schema)\b/i;
// Also matches the shell `truncate <file>`; `truncate -s N file` is not matched. Accepted false positive.
const SQL_TRUNCATE = /\btruncate\b(\s+table)?\s+(?!-)[\w."`]+/i;
// Rules whose denial the model can fix by changing the command; every other denial means "the owner runs it".
const FIXABLE = new Set(["merge-needs-url", "git-push-no-refspec", "git-push-glob", "memory-write-not-chat-lane", "merge-no-grant", "git-push-protected", "rm-rf-outside-assistant", "grant-already-used", "media-path"]);
export function denyMessage(v) {
  const tail = FIXABLE.has(v.rule)
    ? "Change the command as the reason says, or do not do this step."
    : "Do not run it. Write the exact command and why, and send it to Lord Faisal with notify_owner (kind critical, with a code) so he can run it himself.";
  return `Blocked by guard (${v.rule}): ${v.reason}. ${tail}`;
}
function sqlRules(text) {
  if (SQL_DROP.test(text)) return deny("sql-drop", "DROP TABLE/DATABASE/SCHEMA is never run by the agent");
  if (SQL_TRUNCATE.test(text)) return deny("sql-truncate", "TRUNCATE is never run by the agent");
  for (const stmt of text.split(/[;\n|&]/)) {
    const m = /\bdelete\s+from\b([\s\S]*)/i.exec(stmt);
    if (m && !/\bwhere\b/i.test(m[1])) return deny("sql-delete-no-where", "DELETE FROM without WHERE is never run by the agent");
  }
  return null;
}

// Ported from the Mac guard-dangerous.py DENY tier (Keychain and mcp_secret entries dropped: Mac-only).
// Its ASK tier maps to deny except `git push`, `git commit` and `git rebase`, which PLAN 2.11 (branch + PR)
// and 5.2 (refined push rules, wiki-sync.sh does the rebase) supersede. The rest of the ASK tier is above.
const PORTED_DENY = [
  [/:\s*\(\s*\)\s*\{/, "fork bomb"],
  [/\bmkfs\b/i, "filesystem format (mkfs)"],
  [/\bdd\b[^\n]*\bof=\/dev\//i, "dd to a raw device"],
  [/>\s*\/dev\/(sd|nvme|disk)/i, "overwrite a raw disk"],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/i, "recursive 777 on /"],
  [/(^|[;&|(]\s*)(env|printenv|set)\s*($|[;&|)])/i, "bare env/printenv/set dumps environment secrets"],
  [/(^|[;&|(]\s*)(export\s+-p|declare\s+-[a-z]*x[a-z]*)\s*($|[;&|)])/i, "export -p / declare -x dumps environment secrets"],
  [/\bterraform\s+destroy\b/i, "terraform destroy"],
  [/\bdocker\s+system\s+prune\b/i, "docker system prune"],
];

// rm -r outside ~/assistant. Any recursive flag counts, with or without -f (choice, reported).
// Fails closed on a target it cannot resolve: leftover $ or backtick, or a glob whose literal prefix is not inside.
function rmRules(rest, ctx) {
  let recursive = false, dashdash = false;
  const targets = [];
  for (const t of rest) {
    if (!dashdash && t === "--") { dashdash = true; continue; }
    if (!dashdash && t.startsWith("--")) { if (t === "--recursive") recursive = true; continue; }
    if (!dashdash && /^-[A-Za-z]+$/.test(t)) { if (/[rR]/.test(t)) recursive = true; continue; }
    targets.push(t);
  }
  if (!recursive) return null;
  if (!targets.length) return deny("rm-rf-outside-assistant", "rm -r with no target that can be checked");
  for (const t of targets) {
    const x = expandHome(t, ctx.home);
    if (/[$`]/.test(x)) return deny("rm-rf-outside-assistant", `rm -r target ${t} contains a variable or substitution that cannot be checked`);
    const g = x.search(/[*?[]/);
    const literal = g < 0 ? x : x.slice(0, Math.max(0, x.lastIndexOf("/", g)) + 1) || "./";
    if (g >= 0 && /(^|\/)\.\.(\/|$)/.test(x.slice(literal.length))) return deny("rm-rf-outside-assistant", `rm -r target ${t} cannot be checked`);
    const p = resolve(ctx.cwd || ctx.home, literal);
    const ok = homesOf(ctx).some((h) => {
      const dir = join(h, "assistant");
      return g < 0 ? strictlyInside(p, dir) : inside(p, dir);
    });
    if (!ok) return deny("rm-rf-outside-assistant", `rm -r outside ~/assistant is never run by the agent (${t})`);
  }
  return null;
}

function argvRules(argv, ctx, depth) {
  const a = realArgv(argv);
  if (!a || depth > 4) return null;
  const cmd = basename(a[0]), rest = a.slice(1);
  if (cmd === "kubectl" || cmd === "sops" || (cmd === "k3s" && rest[0] === "kubectl")) return deny("no-cluster-tools", `${cmd} is never run by the agent`);
  if (cmd === "restic" && rest.some((t) => t === "forget" || t === "prune")) return deny("restic-forget", "restic forget/prune is never run by the agent");
  if (cmd === "gh") return ghRules(rest, ctx);
  if (cmd === "git") return gitRules(rest, ctx);
  if (cmd === "rm") return rmRules(rest, ctx);
  // multica is not guarded (owner decision 2026-11-12: Gremio has full Multica access under its own account, and Multica's own
  // permissions bound it): no verb, noun or comment rule applies, and a comment needs no prefix or approval grant.
  if (SHELLS.has(cmd)) {
    const k = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
    if (k >= 0 && rest[k + 1]) return bashRules(rest[k + 1], ctx, depth + 1);
  }
  if (cmd === "eval") return bashRules(rest.join(" "), ctx, depth + 1);
  if (cmd === "xargs") {
    let k = 0; // skip xargs' own flags (and their values) up to the command it runs
    while (k < rest.length && rest[k].startsWith("-")) k += /^-[INPdELsa]$/.test(rest[k]) ? 2 : 1;
    return argvRules(rest.slice(k), ctx, depth + 1);
  }
  return null;
}

// Targets a simple command writes to (best effort; interpreters are handled by mentionsProtected).
const WRITE_ALL_ARGS = new Set(["tee", "mv", "rm", "rmdir", "unlink", "touch", "mkdir", "chmod", "chown", "chgrp", "truncate", "shred"]);
const WRITE_LAST_ARG = new Set(["cp", "install", "ln", "rsync"]);
function writeTargets(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^(\d*|&)>>?(.*)$/.exec(argv[i]);
    if (m && !m[2].startsWith("&")) { const t = m[2] || argv[i + 1]; if (t) out.push(t); }
  }
  const a = realArgv(argv);
  if (!a) return out;
  const cmd = basename(a[0]), args = a.slice(1);
  const pos = args.filter((t) => !t.startsWith("-") && !/^\d*>/.test(t));
  if (WRITE_ALL_ARGS.has(cmd)) out.push(...pos);
  else if (WRITE_LAST_ARG.has(cmd) && pos.length) out.push(pos[pos.length - 1]);
  else if (cmd === "dd") out.push(...args.filter((t) => t.startsWith("of=")).map((t) => t.slice(3)));
  else if ((cmd === "sed" || cmd === "perl") && args.some((t) => /^-[a-zA-Z]*i/.test(t))) out.push(...pos);
  else if (cmd === "curl") args.forEach((t, k) => { if (t === "-o" || t === "--output") out.push(args[k + 1] ?? ""); });
  else if (cmd === "wget") args.forEach((t, k) => { if (t === "-O" || t === "--output-document") out.push(args[k + 1] ?? ""); });
  return out;
}

// An interpreter that is handed a protected path as text may write it from inside its script.
function mentionsProtected(tokens, ctx) {
  const h = ctx.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const home = `(?:~|\\$HOME|\\$\\{HOME\\}|${h})`;
  const memory = ctx.lane === "chat" ? "(?!wiki\\b|agent-memory\\b)" : "(?!wiki\\b)";
  const instr = ctx.lane === "chat" ? "" : `|${home}/assistant/(?:CLAUDE\\.md|CLAUDE\\.local\\.md|\\.claude)\\b`;
  const re = new RegExp(`${home}/\\.claude\\.json|${home}/\\.claude/${memory}\\S|(?<![\\w.~/-])/(opt|etc)/|${ctx.xchg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(answers|grants|events|sock)\\b${instr}`);
  return tokens.some((t) => re.test(t));
}

export function bashRules(cmd, ctx, depth = 0) {
  // SQL rules only where a database client is in the command: a commit message or a grep that mentions DROP TABLE is not SQL.
  if (DB_CLIENT.test(cmd)) { const sql = sqlRules(cmd); if (sql) return sql; }
  // Quoted strings are data here (a commit message about a format tool); `bash -c '...'` bodies are re-checked by recursion.
  const unquoted = cmd.replace(/'[^']*'|"[^"]*"/g, '""');
  for (const [re, why] of PORTED_DENY) if (re.test(unquoted)) return deny("ported-guard-dangerous", `${why} is never run by the agent`);
  if (depth === 0) {
    // `cd ~/.claude/wiki && git push` lexes into separate commands: remember that the command touches the wiki.
    ctx = { ...ctx, wikiHint: ctx.wikiHint || homesOf(ctx).some((h) => inside(real(ctx.cwd || ctx.home), join(h, ".claude", "wiki"))) || /\.claude\/wiki\b/.test(cmd.replaceAll("$HOME", "~")) };
  }
  const grants = [];
  const take = (r) => { for (const g of r?.grants ?? []) if (!grants.includes(g)) grants.push(g); };
  for (const argv of lex(cmd)) {
    for (const t of argv) {
      for (const m of t.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        const r = bashRules(m[1] ?? m[2], ctx, depth + 1);
        if (r?.deny) return r;
        take(r);
      }
    }
    for (const t of writeTargets(argv)) {
      const rule = protectedWrite(absPath(t, ctx), ctx);
      if (rule) return writeDenied(rule);
    }
    const real_ = realArgv(argv);
    if (real_ && INTERPRETERS.test(basename(real_[0])) && mentionsProtected(real_.slice(1), ctx)) return writeDenied("policy-path-write");
    const r = argvRules(argv, ctx, depth);
    if (r?.deny) return r;
    take(r);
  }
  return grants.length ? { grants, rule: "grant" } : null;
}

function* strings(v) {
  if (typeof v === "string") yield v;
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

// input: {tool_name, tool_input, cwd?, ...}; ctx: {home, xchg, lane, task, now}
export function evaluate(input, ctx0 = {}) {
  const ctx = {
    home: ctx0.home ?? process.env.HOME ?? homedir(),
    xchg: ctx0.xchg ?? "/xchg",
    lane: ctx0.lane,
    task: ctx0.task,
    now: ctx0.now ?? Date.now(),
    cwd: typeof input.cwd === "string" ? input.cwd : ctx0.cwd,
  };
  const tool = String(input.tool_name ?? "");
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  let subject = "";
  let verdict = null;
  if (tool === "Bash") {
    subject = String(ti.command ?? "");
    verdict = bashRules(subject, ctx);
  } else if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    subject = String(ti.file_path ?? ti.notebook_path ?? "");
    const rule = subject ? protectedWrite(absPath(subject, ctx), ctx) : null;
    if (rule) verdict = writeDenied(rule);
  } else if (tool.startsWith("mcp__")) {
    subject = tool;
    if (tool === "mcp__owner__wa_send_media") verdict = mediaPath(ti, ctx);
    if (!verdict && !NO_SQL_SCAN.test(tool)) for (const s of strings(ti)) { verdict = sqlRules(s); if (verdict) break; } // owner and context7 carry prose, not SQL
  }
  return { tool, subject, verdict };
}

// ---------- CLI ----------
function writeLog(home, rec) {
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    appendFileSync(join(home, ".claude", "guard.log"), JSON.stringify(rec) + "\n");
  } catch (e) {
    process.stderr.write(`guard: log failed: ${e.message}\n`);
  }
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const home = process.env.HOME || homedir();
    const ev = evaluate(input, { home, lane: process.env.WA_LANE, task: process.env.WA_TASK_ID });
    const { tool, subject } = ev;
    let verdict = ev.verdict;
    // Claim every grant the command uses before letting it through; a lost race means the grant was used a moment ago.
    if (verdict?.grants?.length && !claimGrants(home, verdict.grants)) verdict = deny("grant-already-used", "that grant was just used by another tool call; ask the owner again");
    writeLog(home, {
      ts: new Date().toISOString(),
      decision: verdict?.deny ? "deny" : verdict?.grants?.length ? "pass-grant" : "pass",
      rule: verdict?.rule ?? null,
      grant_ids: verdict?.grants ?? [],
      tool,
      subject: subject.slice(0, 160), // never the Write/Edit content
      session_id: input.session_id ?? null,
      tool_use_id: input.tool_use_id ?? null,
      lane: process.env.WA_LANE ?? null,
      task: process.env.WA_TASK_ID ?? null,
    });
    if (verdict?.deny) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denyMessage(verdict),
        },
      }) + "\n");
    }
  } catch (e) {
    process.stderr.write(`guard: ${e.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
