// No-model poller (PLAN 2.11 step 4, phase 2 table). Runs in the worker container, next to the runner. Every
// 1 to 2 minutes it reads the issues the runner tracks per task lane (registry.json: the task issue, its child
// issues, the D19 vehicle) with read-only `multica issue get` and `multica issue comment list`, and writes
// /xchg/events/<issue>-<id>.json for a new agent comment or a terminal status of a child or vehicle issue.
// Member comments (its own, posted as the owner) are ignored. The runner turns events into `[dunan]` turns.
//
// Assumed `multica ... --output json` fields (CLI 0.7.2 help only; field names UNVERIFIED until phase 7 probes):
//   issue get          {status}
//   issue comment list array of, or {comments:[...]} of, {id, author_type, content, created_at}
// Flags used come from the CLI help: `--output json`, and `--since <RFC3339>` (the help says --since is never folded).
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeWrite } from "./state.mjs";

const TERMINAL = new Set(["done", "cancelled", "canceled"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const run = (bin, args, timeout = 30000) => new Promise((res, rej) => {
  execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: process.env }, (e, out, err) => (e ? rej(new Error(`${args.slice(0, 3).join(" ")}: ${err.trim().slice(0, 200) || e.message}`)) : res(out)));
});

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } };
const asList = (j) => (Array.isArray(j) ? j : Array.isArray(j?.comments) ? j.comments : []);

// One pass. Returns the event files written. `exec(bin, args)` is injectable.
export async function pollOnce({ bin = "multica", regPath, seenPath, eventsDir, exec = run, log = () => {} }) {
  const reg = readJson(regPath, { lanes: {} });
  const seen = readJson(seenPath, {}); // issue -> {comments: [ids], cursor: iso, status: last status reported}
  const written = [];
  // Task lanes (their own issue plus tracked ones) and group lanes (tracked issues only; the event's `task` is the group lane id).
  const owners = [...Object.entries(reg.lanes ?? {}).map(([k, l]) => [k, l, true]), ...Object.entries(reg.groups ?? {}).map(([k, l]) => [k, l, false])];
  for (const [task, lane, hasIssue] of owners) {
    if (lane.done) continue;
    const issues = [...(hasIssue ? [{ id: task, role: "task", since: lane.since }] : []), ...(lane.tracked ?? [])];
    for (const it of issues) {
      if (!ID_RE.test(String(it.id))) continue;
      const st = (seen[it.id] ??= { comments: [], cursor: it.since ?? new Date(0).toISOString(), status: null });
      try {
        const comments = asList(JSON.parse(await exec(bin, ["issue", "comment", "list", it.id, "--output", "json", "--since", st.cursor])));
        for (const c of comments) {
          if (!c?.id || st.comments.includes(String(c.id))) continue;
          const created = c.created_at ? Date.parse(c.created_at) : NaN;
          if (!Number.isNaN(created) && created < Date.parse(it.since ?? 0)) continue; // older than the registration
          st.comments.push(String(c.id));
          if (!Number.isNaN(created) && created > Date.parse(st.cursor)) st.cursor = new Date(created).toISOString();
          if (c.author_type !== "agent") continue; // member comments are his own
          written.push(writeEvent(eventsDir, `${it.id}-${c.id}`, { task, issue: it.id, kind: "comment", comment_id: String(c.id), text: String(c.content ?? ""), created_at: c.created_at ?? null }));
        }
        if (it.role !== "task") {
          const status = String(JSON.parse(await exec(bin, ["issue", "get", it.id, "--output", "json"])).status ?? "").toLowerCase();
          if (TERMINAL.has(status) && st.status !== status) {
            st.status = status;
            written.push(writeEvent(eventsDir, `${it.id}-status-${status}`, { task, issue: it.id, kind: "status", status, text: `Issue ${it.id} is now ${status}.` }));
          }
        }
        st.comments = st.comments.slice(-500);
      } catch (e) { log(`${it.id}: ${e.message}`); } // one failing issue never blocks the others
    }
  }
  mkdirSync(dirname(seenPath), { recursive: true });
  const tmp = `${seenPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(seen));
  renameSync(tmp, seenPath);
  return written;
}

function writeEvent(dir, name, obj) {
  mkdirSync(dir, { recursive: true });
  const file = `${name.replace(/[^\w.-]/g, "_")}.json`;
  safeWrite(join(dir, file), JSON.stringify(obj), 0o644);
  return file;
}

async function main() {
  const home = process.env.HOME;
  const cfg = {
    bin: process.env.WA_MULTICA_BIN ?? "multica",
    regPath: process.env.WA_REGISTRY ?? join(home, ".wa-runner", "registry.json"),
    seenPath: join(home, ".wa-runner", "poller-seen.json"),
    eventsDir: join(process.env.WA_XCHG_DIR ?? "/xchg", "events"),
    log: (m) => process.stderr.write(`poller: ${m}\n`),
  };
  const every = Number(process.env.WA_POLL_MS ?? 90000);
  do {
    try { await pollOnce(cfg); } catch (e) { cfg.log(e.message); }
    if (process.argv.includes("--once")) return;
    await new Promise((r) => setTimeout(r, every));
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
