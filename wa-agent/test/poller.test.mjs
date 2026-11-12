// Poller tests (PLAN 2.11 step 4): against a FAKE `multica` binary, never the real CLI or server.
// Assumed `multica ... --output json` fields (UNVERIFIED until phase 7): issue get {status};
// issue comment list [ {id, author_type ("agent" | "member"), content, created_at} ] or {comments:[...]}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollOnce } from "../src/poller.mjs";
import { ROOT, fakeBin, sandbox } from "../testlib/helpers.mjs";

function setup() {
  const S = sandbox();
  const ctl = join(S.dir, "mctl");
  mkdirSync(ctl);
  // `multica issue get <id>` and `multica issue comment list <id>` read canned JSON; every call is logged
  const bin = fakeBin(S.bin, "multica", `echo "$@" >> ${ctl}/calls.log
case "$1 $2" in
  "issue get") f=${ctl}/issue-$3.json;;
  "issue comment") f=${ctl}/comments-$4.json;;
esac
[ -f "$f" ] && cat "$f" || { echo "not found" >&2; exit 1; }`);
  const regPath = join(S.home, ".wa-runner", "registry.json");
  mkdirSync(join(S.home, ".wa-runner"), { recursive: true });
  const reg = (lanes) => writeFileSync(regPath, JSON.stringify({ lanes, waiting: [] }));
  const put = (name, v) => writeFileSync(join(ctl, name), JSON.stringify(v));
  const cfg = { bin, regPath, seenPath: join(S.home, ".wa-runner", "poller-seen.json"), eventsDir: join(S.xchg, "events"), log: (m) => cfg.logs.push(m), logs: [] };
  const events = () => readdirSync(cfg.eventsDir).sort();
  const calls = () => readFileSync(join(ctl, "calls.log"), "utf8").trim().split("\n");
  return { S, ctl, reg, put, cfg, events, calls, bin };
}
const SINCE = "2026-11-11T10:00:00.000Z";

test("the poller dedups by comment id and ignores member comments", async () => {
  const P = setup();
  P.reg({ t1: { issue: "t1", since: SINCE, done: false, tracked: [{ id: "c1", role: "child", since: SINCE }] } });
  P.put("comments-t1.json", [{ id: "m1", author_type: "member", content: "[gremio] aku mulai", created_at: "2026-11-11T10:01:00Z" }]);
  P.put("issue-c1.json", { status: "todo" });
  P.put("comments-c1.json", { comments: [
    { id: "a1", author_type: "agent", content: "Rancangan: tabel A", created_at: "2026-11-11T10:05:00Z" },
    { id: "m2", author_type: "member", content: "[gremio] ok", created_at: "2026-11-11T10:06:00Z" },
    { id: "a0", author_type: "agent", content: "sebelum didaftarkan", created_at: "2026-11-11T09:00:00Z" },
  ] });
  assert.deepEqual(await pollOnce(P.cfg), ["c1-a1.json"]);
  const ev = JSON.parse(readFileSync(join(P.cfg.eventsDir, "c1-a1.json"), "utf8"));
  assert.deepEqual([ev.task, ev.issue, ev.kind, ev.comment_id, ev.text], ["t1", "c1", "comment", "a1", "Rancangan: tabel A"]);
  // second pass and a restart (new call, same seen file) write nothing new
  assert.deepEqual(await pollOnce(P.cfg), []);
  assert.deepEqual(await pollOnce(P.cfg), []);
  // a new agent comment after that is picked up
  P.put("comments-c1.json", [{ id: "a1", author_type: "agent", content: "dup", created_at: "2026-11-11T10:05:00Z" }, { id: "a2", author_type: "agent", content: "revisi", created_at: "2026-11-11T10:20:00Z" }]);
  assert.deepEqual(await pollOnce(P.cfg), ["c1-a2.json"]);
  assert.deepEqual(P.events(), ["c1-a1.json", "c1-a2.json"]);
  // read-only CLI use, JSON output, and --since advanced to the newest comment seen (member comments too)
  const calls = P.calls();
  assert.ok(calls.every((c) => /^issue (get|comment list) /.test(c)), calls.join("\n"));
  assert.ok(calls.some((c) => c === "issue comment list c1 --output json --since 2026-11-11T10:06:00.000Z"));
  assert.ok(calls.every((c) => !/(add|update|delete|create|status|assign)/.test(c.split(" ").slice(0, 3).join(" "))));
});

test("a terminal status of a child or vehicle issue wakes the lane once; the task issue's own status does not", async () => {
  const P = setup();
  P.reg({ t1: { issue: "t1", since: SINCE, done: false, tracked: [{ id: "c1", role: "child", since: SINCE }, { id: "v1", role: "vehicle", since: SINCE }] } });
  P.put("comments-t1.json", []); P.put("comments-c1.json", []); P.put("comments-v1.json", []);
  P.put("issue-t1.json", { status: "done" }); // the lane's own doing
  P.put("issue-c1.json", { status: "done" });
  P.put("issue-v1.json", { status: "in_progress" });
  assert.deepEqual(await pollOnce(P.cfg), ["c1-status-done.json"]);
  assert.deepEqual(await pollOnce(P.cfg), []); // once
  P.put("issue-v1.json", { status: "cancelled" });
  assert.deepEqual(await pollOnce(P.cfg), ["v1-status-cancelled.json"]);
  assert.equal(JSON.parse(readFileSync(join(P.cfg.eventsDir, "c1-status-done.json"), "utf8")).kind, "status");
});

test("a finished lane is not polled, a failing issue does not block the others, odd ids are skipped", async () => {
  const P = setup();
  P.reg({
    t1: { issue: "t1", since: SINCE, done: true, tracked: [] },
    t2: { issue: "t2", since: SINCE, done: false, tracked: [{ id: "broken", role: "child", since: SINCE }, { id: "../x", role: "child", since: SINCE }, { id: "c2", role: "child", since: SINCE }] },
  });
  P.put("comments-t2.json", []);
  P.put("comments-c2.json", [{ id: "a9", author_type: "agent", content: "hai", created_at: "2026-11-11T11:00:00Z" }]);
  P.put("issue-c2.json", { status: "todo" });
  assert.deepEqual(await pollOnce(P.cfg), ["c2-a9.json"]);
  assert.ok(P.cfg.logs.some((l) => /broken/.test(l)));
  assert.ok(P.calls().every((c) => !/ t1 | \.\.\/x/.test(` ${c} `)));
});

test("--once CLI mode reads the registry from HOME and writes events under WA_XCHG_DIR", () => {
  const P = setup();
  P.reg({ t1: { issue: "t1", since: SINCE, done: false, tracked: [] } });
  P.put("comments-t1.json", [{ id: "d1", author_type: "agent", content: "Riou: saran", created_at: "2026-11-11T12:00:00Z" }]);
  const r = spawnSync(process.execPath, [join(ROOT, "src", "poller.mjs"), "--once"], { env: { HOME: P.S.home, PATH: process.env.PATH, WA_XCHG_DIR: P.S.xchg, WA_MULTICA_BIN: P.bin }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(P.events(), ["t1-d1.json"]);
});

test("a group lane's tracked issues are polled and their events name the group lane", async () => {
  const P = setup();
  writeFileSync(P.cfg.regPath, JSON.stringify({ lanes: {}, groups: { grp_120363: { since: SINCE, tracked: [{ id: "c7", role: "child", since: SINCE }] } }, waiting: [] }));
  P.put("comments-c7.json", [{ id: "a1", author_type: "agent", content: "Saran dari Riou", created_at: "2026-11-11T10:05:00Z" }]);
  P.put("issue-c7.json", { status: "done" });
  assert.deepEqual(await pollOnce(P.cfg), ["c7-a1.json", "c7-status-done.json"]);
  const ev = JSON.parse(readFileSync(join(P.cfg.eventsDir, "c7-a1.json"), "utf8"));
  assert.deepEqual([ev.task, ev.issue, ev.text], ["grp_120363", "c7", "Saran dari Riou"]);
  assert.ok(P.calls().every((c) => !c.includes("grp_120363"))); // the lane id is not an issue
  assert.deepEqual(await pollOnce(P.cfg), []);
});
