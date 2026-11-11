// Security review fixes (B1-B5 and minors 1, 2, 4, 5, 6, 7, 9, 10, 13). Every test here was run against the code as it
// was before the fix and failed there; the matching probe scripts reproduced the same defects.
// Fields assumed: see runner.test.mjs and src/stream.mjs headers (synthetic fixtures); guard hook input fields as in
// guard.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore } from "../src/bridge.mjs";
import { openState } from "../src/state.mjs";
import * as guard from "../hooks/guard.mjs";

const { evaluate } = guard;
const claimGrants = (...a) => guard.claimGrants(...a); // namespace access: a missing export fails the test, not the whole file
import { ROOT, sandbox, sleep, waitFor } from "../testlib/helpers.mjs";
import { connect, raw, startRunner, toolCall } from "../testlib/harness.mjs";

// ---------- bridge core helpers ----------
function fakeWa() {
  const w = { texts: [], polls: [], delay: 0 };
  w.sendText = async (text, o = {}) => { if (w.delay) await sleep(w.delay); w.texts.push({ text, ...o }); };
  w.sendPoll = async (name, values, o = {}) => { if (w.delay) await sleep(w.delay); w.polls.push({ name, values, ...o }); return { id: o.id, raw: "{}" }; };
  w.composing = () => {};
  w.isOpen = () => true;
  return w;
}
function mk(S, start = 1_800_000_000_000) {
  const wa = fakeWa(), sent = [], clock = { t: start };
  const state = openState(join(S.dir, "bridge", "state.json"));
  const core = createCore({ state, xchg: S.xchg, wa, toRunner: (m) => sent.push(m), now: () => clock.t });
  return { core, wa, sent, state, clock, turns: () => sent.filter((m) => m.op === "turn") };
}
const T0 = 1_800_000_000;
const up = async (b) => { await b.core.onOpen(); await b.core.onRunnerEvent({ ev: "hello", busy: [] }); };
const ASK = (id, lane, q = "Pilih?") => ({ ev: "result", lane, sessionId: `s-${lane}`, stopReason: "tool_deferred", deferred: { id, name: "AskUserQuestion", input: { questions: [{ question: q, options: [{ label: "A" }, { label: "B" }] }] } } });
const startTask = (b, id) => b.core.onRunnerEvent({ ev: "task-started", task: id, origin: null, prompt: `[task] ${id}` });
const grantsOf = (S) => readdirSync(join(S.xchg, "grants")).map((f) => JSON.parse(readFileSync(join(S.xchg, "grants", f), "utf8")));

// ======================= B1: ids from the runner =======================
test("B1: a runner-supplied question id with a path in it never becomes a file name outside answers/", async () => {
  const S = sandbox();
  const b = mk(S);
  mkdirSync(join(S.dir, "bridge", "auth"), { recursive: true });
  writeFileSync(join(S.dir, "bridge", "auth", "creds.json"), '{"me":"secret"}');
  await up(b);
  for (const id of ["../../bridge/auth/creds", "a/b", "..", "__proto__", "constructor", "prototype", "x".repeat(65), "", "a b", "toolu_1.json"]) {
    await b.core.onRunnerEvent(ASK(id, "chat"));
  }
  assert.equal(b.state.d.queue.length, 0, "no question with a bad id is queued");
  await b.core.onMessage({ id: "m1", ts: T0 + 1, text: "1" });
  assert.equal(readFileSync(join(S.dir, "bridge", "auth", "creds.json"), "utf8"), '{"me":"secret"}');
  assert.deepEqual(readdirSync(join(S.xchg, "answers")), []);
  await b.core.onRunnerEvent(ASK("toolu_ok1", "chat")); // a normal id still works
  assert.equal(b.state.d.queue.length, 1);
});

test("B1: reserved and unknown lane ids are dropped; __proto__ cannot poison lanes or the chat session", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "session", lane: "chat", sessionId: "keep" });
  for (const lane of ["__proto__", "constructor", "prototype", "ghost", "../x"]) {
    await b.core.onRunnerEvent({ ev: "notify", lane, kind: "done", text: "x", nid: "n" + lane.length });
    await b.core.onRunnerEvent({ ev: "result", lane, sessionId: "evil", stopReason: "end_turn" });
    await b.core.onRunnerEvent({ ev: "session", lane, sessionId: "evil" });
    await b.core.onRunnerEvent({ ev: "text", lane, key: "k", text: "leak" });
  }
  assert.equal(({}).done, undefined);
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "keep" });
  assert.equal(b.state.d.sessions.chat, "keep");
  assert.deepEqual(Object.keys(b.state.d.lanes), ["chat"]);
  assert.equal(b.wa.texts.length, 0);
  // task-started only accepts a valid, non-reserved id
  for (const t of ["chat", "__proto__", "constructor", "prototype", "../../x", "a/b", ""]) await startTask(b, t);
  assert.deepEqual(Object.keys(b.state.d.lanes), ["chat"]);
  await startTask(b, "ISS-9");
  assert.deepEqual(Object.keys(b.state.d.lanes).sort(), ["ISS-9", "chat"]);
});

test("B1: critical codes, ask ids, Dunan file names and grant ids from the runner are validated", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await startTask(b, "i1");
  await b.core.onRunnerEvent({ ev: "notify", lane: "i1", kind: "critical", code: "../../x", nid: "n1", text: "x" });
  await b.core.onRunnerEvent({ ev: "notify", lane: "i1", kind: "critical", code: "k7q-4821", nid: "../n", text: "x" });
  assert.deepEqual(Object.keys(b.state.d.codes), []);
  await b.core.onRunnerEvent({ ev: "ask", rid: "../../etc/x", lane: "i1", text: "q" });
  assert.equal(b.state.d.queue.length, 0);
  b.sent.length = 0;
  await b.core.onRunnerEvent({ ev: "dunan", file: "../../etc/passwd", task: "i1", prompt: "[dunan] x" });
  await b.core.onRunnerEvent({ ev: "dunan", file: "ok-1.json", task: "ghost", prompt: "[dunan] x" });
  assert.deepEqual(b.sent.filter((m) => m.op === "ack").map((m) => m.file), ["ok-1.json"]); // stale lane: ack so the runner drops it
  assert.equal(b.turns().filter((t) => t.prompt.startsWith("[dunan]")).length, 0);
});

// ======================= B2: who may talk to the runner =======================
test("B2: a second client claiming role bridge is refused and sees no events; an unauthenticated one never becomes the bridge", async () => {
  const S = sandbox();
  const R = await startRunner(S, { script: ["plain"] });
  const real = await connect(R.sock, { role: "bridge" });
  const evil = await raw(R.sock);
  evil.send({ op: "hello", role: "bridge" });
  const lateEvil = await raw(R.sock);
  lateEvil.send({ op: "hello", role: "bridge" });
  lateEvil.send({ op: "auth", nonce: "guess" });
  lateEvil.send({ op: "turn", lane: "chat", prompt: "owned", session: null });
  real.send({ op: "turn", lane: "chat", prompt: "halo", session: null });
  await real.wait((e) => e.ev === "result");
  await sleep(100);
  assert.ok(real.of("text").length === 1);
  for (const c of [evil, lateEvil]) assert.deepEqual(c.events.filter((e) => ["text", "result", "session", "notify", "ask", "task-started", "dunan"].includes(e.ev)), []);
  assert.equal(R.calls().length, 1); // the forged turn never ran
  assert.ok(evil.events.some((e) => e.ev === "error" || e.ev === "challenge")); // refused or challenged, never trusted
});

test("B2: the bridge proves itself with a file only the bridge-owned answers/ dir can hold; a wrong or missing proof fails", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const c = await raw(R.sock);
  c.send({ op: "hello", role: "bridge" });
  const ch = await c.wait((e) => e.ev === "challenge");
  assert.match(ch.nonce, /^[0-9a-f]{32}$/);
  c.send({ op: "auth", nonce: ch.nonce }); // no proof file written
  await c.wait((e) => e.ev === "error");
  assert.equal(c.of("hello").length, 0);
  const c2 = await raw(R.sock);
  c2.send({ op: "hello", role: "bridge" });
  const ch2 = await c2.wait((e) => e.ev === "challenge");
  writeFileSync(join(S.xchg, "answers", `.hello-${ch.nonce}`), ""); // the proof for the OTHER nonce
  c2.send({ op: "auth", nonce: ch2.nonce });
  await c2.wait((e) => e.ev === "error");
  // a second bridge is refused while the first is live
  const first = await connect(R.sock, { role: "bridge" });
  const second = await raw(R.sock);
  second.send({ op: "hello", role: "bridge" });
  const chs = await second.wait((e) => e.ev === "challenge" || e.ev === "error");
  if (chs.ev === "challenge") { writeFileSync(join(S.xchg, "answers", `.hello-${chs.nonce}`), ""); second.send({ op: "auth", nonce: chs.nonce }); }
  await second.wait((e) => e.ev === "error");
  assert.equal(second.of("hello").length, 0);
  first.send({ op: "ping" });
  await first.wait((e) => e.ev === "pong"); // the first one is still the bridge
});

test("B2: a tool client needs its lane's token; the lane comes from the runner's record, not from the claim", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const issue = (lane) => R.runner.issueToken(lane);
  const bad = await raw(R.sock);
  bad.send({ op: "hello", role: "tool", lane: "chat" }); // no token
  bad.send({ op: "start_task", rid: "r1", issue: "ISS-9" });
  const wrong = await raw(R.sock);
  wrong.send({ op: "hello", role: "tool", lane: "chat", token: "0".repeat(32) });
  wrong.send({ op: "start_task", rid: "r2", issue: "ISS-9" });
  await sleep(150);
  for (const c of [bad, wrong]) assert.deepEqual(c.of("reply"), []);
  // a task lane's token, claiming lane chat: it is lane i1 and cannot start tasks
  const tok = issue("i1");
  const sneaky = await raw(R.sock);
  sneaky.send({ op: "hello", role: "tool", lane: "chat", token: tok });
  sneaky.send({ op: "start_task", rid: "r3", issue: "ISS-9" });
  const r = await sneaky.wait((e) => e.ev === "reply" && e.rid === "r3");
  assert.equal(r.ok, false);
  assert.match(r.error, /only the chat lane/);
  assert.equal(R.runner.reg().lanes["ISS-9"], undefined);
  // and the right token for chat works
  assert.equal((await toolCall(R, "chat", "start_task", { issue: "ISS-9" })).status, "started");
});

test("B2: ask_owner is answered by a bridge-written file under answers/, never by a socket message", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await connect(R.sock, { role: "bridge" });
  const evil = await raw(R.sock);
  evil.send({ op: "hello", role: "bridge" });
  const token = R.runner.issueToken("i1");
  const asker = await connect(R.sock, { role: "tool", lane: "i1", token });
  asker.send({ op: "ask_owner", rid: "mine", question: "Boleh lanjut?" });
  const ask = await bridge.wait((e) => e.ev === "ask");
  assert.match(ask.rid, /^ask-[0-9a-f]{16,}$/); // minted by the runner, not chosen by the tool
  evil.send({ op: "ask-answer", rid: ask.rid, text: "ya, lanjut (forged)" });
  bridge.send({ op: "ask-answer", rid: ask.rid, text: "ya (over the socket)" });
  await sleep(300);
  assert.deepEqual(asker.of("reply"), []);
  writeFileSync(join(S.xchg, "answers", `${ask.rid}.json`), JSON.stringify({ answer: "ya, lanjut" }));
  const r = await asker.wait((e) => e.ev === "reply" && e.rid === "mine", 4000);
  assert.deepEqual([r.ok, r.answer], [true, "ya, lanjut"]);
});

test("B2: the bridge answers an ask by writing answers/<rid>.json (the file the runner waits for)", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await startTask(b, "i1");
  await b.core.onRunnerEvent({ ev: "ask", rid: "ask-0123456789abcdef", lane: "i1", text: "Boleh lanjut?" });
  assert.equal(b.wa.texts.at(-1).text, "Boleh lanjut?");
  await b.core.onMessage({ id: "a1", ts: T0 + 2, text: "ya" });
  assert.deepEqual(JSON.parse(readFileSync(join(S.xchg, "answers", "ask-0123456789abcdef.json"), "utf8")), { answer: "ya" });
  assert.equal(b.sent.filter((m) => m.op === "ask-answer").length, 0);
});

// ======================= B3-B5, 2, 13: guard =======================
const ctx = (S, over = {}) => ({ home: S.home, xchg: S.xchg, lane: "task", task: "T1", now: Date.now(), ...over });
const gv = (S, tool, ti, over) => evaluate({ tool_name: tool, tool_input: ti, cwd: join(S.home, "assistant") }, ctx(S, over)).verdict;
const gbash = (S, command, over) => gv(S, "Bash", { command }, over);
const wg = (S, g) => writeFileSync(join(S.xchg, "grants", `${g.id}.json`), JSON.stringify({ created_at: Date.now(), ...g }));

test("B3: an approval grant carries the verb and the comment must use that verb", () => {
  const S = sandbox();
  wg(S, { id: "g1", kind: "approval", code: "abc-123", verb: "deny" });
  const cmd = (verb) => `multica issue comment add I1 --content "[gremio] ${verb} abc-123"`;
  assert.equal(gbash(S, cmd("done")).rule, "approval-no-grant"); // he said deny; "done" is a forgery
  assert.deepEqual(gbash(S, cmd("deny")).grants, ["g1"]);
  wg(S, { id: "g2", kind: "approval", code: "xyz-999", verb: "done" });
  assert.equal(gbash(S, `multica issue comment add I1 --content "[gremio] deny xyz-999"`).rule, "approval-no-grant");
  assert.deepEqual(gbash(S, `multica issue comment add I1 --content "[gremio] done xyz-999"`).grants, ["g2"]);
  wg(S, { id: "g3", kind: "approval", code: "old-111" }); // a grant without a verb matches nothing
  assert.equal(gbash(S, `multica issue comment add I1 --content "[gremio] done old-111"`).rule, "approval-no-grant");
});

test("B4: SQL rules apply to DB clients only; MCP owner and context7 tools and commit messages are not scanned", () => {
  const S = sandbox();
  const pass = (v) => assert.ok(!v?.deny, JSON.stringify(v));
  pass(gv(S, "mcp__owner__notify_owner", { kind: "critical", text: "Tolong jalankan: psql -c 'DROP DATABASE foo'", code: "abc-123" }));
  pass(gv(S, "mcp__context7__query-docs", { query: "how to truncate a table in postgres" }));
  pass(gbash(S, 'git commit -m "fix: truncate long messages before send"'));
  pass(gbash(S, 'git commit -m "remove stale entries: delete from cache on reset"'));
  pass(gbash(S, 'git commit -m "docs: mkfs notes and drop table examples"'));
  pass(gbash(S, "grep -rn 'DROP TABLE' migrations/"));
  for (const c of ["psql -c 'DROP TABLE x'", "mysql -e 'truncate table x'", "sqlite3 a.db 'delete from t'", "echo 'drop schema s' | psql", "trino --execute 'DROP TABLE a.b'", "duckdb -c 'DROP TABLE t'", "clickhouse-client -q 'TRUNCATE t'", "usql pg:// -c 'drop database x'", "pgcli -c 'drop table x'", "mariadb -e 'drop table t'"]) {
    assert.equal(gbash(S, c).deny, true, c);
  }
  assert.equal(gv(S, "mcp__db__query", { sql: "DROP TABLE x" }).rule, "sql-drop"); // a database MCP is still scanned
  const msg = gbash(S, "psql -c 'DROP TABLE x'");
  assert.match(guard.denyMessage(msg), /Lord Faisal.*notify_owner/);
  assert.doesNotMatch(guard.denyMessage(msg), /Do not retry/);
  assert.doesNotMatch(guard.denyMessage(gbash(S, 'multica issue comment add 1 --content "hi"')), /Lord Faisal/); // a fixable denial says how to fix it
});

test("B5: every grant a command uses is returned, logged as grant_ids, and reported by the runner", async () => {
  const S = sandbox();
  wg(S, { id: "g2", kind: "merge", url: "https://github.com/o/r/pull/5" });
  wg(S, { id: "g3", kind: "push-main", task_id: "T1", branch: "main" });
  const v = gbash(S, "gh pr merge https://github.com/o/r/pull/5 --squash && git push origin fix:main");
  assert.deepEqual([...v.grants].sort(), ["g2", "g3"]);
  // the CLI logs grant_ids (HOME is a sandbox; /xchg does not exist here, so use the log record shape through the runner)
  const R = await startRunner(S, { script: ["granted-merge"] });
  writeFileSync(join(R.ctl, "guard-lines.jsonl"), JSON.stringify({ decision: "pass-grant", rule: "grant", grant_ids: ["g2", "g3"], tool_use_id: "toolu_merge", lane: "chat" }) + "\n");
  const b = await connect(R.sock, { role: "bridge" });
  b.send({ op: "turn", lane: "chat", prompt: "x", session: null });
  await b.wait((e) => e.ev === "result");
  assert.deepEqual(b.of("grant-used").map((u) => u.grant).sort(), ["g2", "g3"]);
});

test("minor 2: a grant is claimed atomically by the guard; a second use is denied even with the file still there", () => {
  const S = sandbox();
  const url = "https://github.com/o/r/pull/5";
  wg(S, { id: "g-once", kind: "merge", url });
  const cmd = `gh pr merge ${url}`;
  const v1 = gbash(S, cmd);
  assert.deepEqual(v1.grants, ["g-once"]);
  assert.equal(claimGrants(S.home, v1.grants), true);
  assert.equal(claimGrants(S.home, v1.grants), false); // a parallel call loses the race
  assert.equal(gbash(S, cmd).rule, "merge-no-grant"); // and the grant is gone for later calls although the file remains
  assert.ok(existsSync(join(S.xchg, "grants", "g-once.json")));
  // the permission tool path only reads: it never consumes
  wg(S, { id: "g-b", kind: "merge", url: "https://github.com/o/r/pull/6" });
  gbash(S, "gh pr merge https://github.com/o/r/pull/6");
  assert.deepEqual(gbash(S, "gh pr merge https://github.com/o/r/pull/6").grants, ["g-b"]);
});

test("minor 13: gh api merge endpoints need a merge grant like gh pr merge", () => {
  const S = sandbox();
  for (const c of [
    "gh api -X PUT repos/o/r/pulls/5/merge", "gh api --method PUT repos/o/r/pulls/5/merge -f merge_method=squash",
    "gh api repos/o/r/pulls/5/merge -X PUT", "gh api --method=PUT /repos/o/r/pulls/5/merge",
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "X"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "X"}) { clientMutationId } }'`,
  ]) assert.equal(gbash(S, c).deny, true, c);
  wg(S, { id: "gm", kind: "merge", url: "https://github.com/o/r/pull/5" });
  assert.deepEqual(gbash(S, "gh api -X PUT repos/o/r/pulls/5/merge").grants, ["gm"]);
  assert.equal(gbash(S, "gh api -X PUT repos/o/r/pulls/6/merge").deny, true);
  assert.ok(!gbash(S, "gh api repos/o/r/pulls/5")?.deny); // reads are fine
});

// ======================= minors on the bridge =======================
test("minor 4: notify_owner done from the chat lane does not end the chat lane (message still delivered)", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "session", lane: "chat", sessionId: "keep-me" });
  await b.core.onRunnerEvent({ ev: "notify", lane: "chat", kind: "done", text: "selesai", nid: "n1" });
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "keep-me" });
  assert.equal(b.state.d.sessions.chat, "keep-me");
  assert.ok(b.state.d.lanes.chat);
  assert.equal(b.wa.texts.at(-1).text, "selesai");
});

test("minor 5: a lane with a queued question starts no turn; the resume goes first; the answer file outlives other turns", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await startTask(b, "T1");
  await b.core.onRunnerEvent({ ev: "result", lane: "T1", sessionId: "sT", stopReason: "end_turn" });
  b.sent.length = 0;
  await b.core.onRunnerEvent(ASK("toolu_1", "T1"));
  await b.core.onRunnerEvent({ ev: "dunan", file: "e1.json", task: "T1", prompt: "[dunan] update" });
  assert.deepEqual(b.turns(), [], "no turn while the lane's question is pending");
  await b.core.onMessage({ id: "m1", ts: T0 + 2, text: "1" });
  assert.ok(existsSync(join(S.xchg, "answers", "toolu_1.json")));
  assert.deepEqual(b.turns().map((t) => t.prompt), [""]); // the resume alone, no prompt riding on a deferred tool
  await b.core.onRunnerEvent({ ev: "result", lane: "T1", sessionId: "sT", stopReason: "end_turn" }); // the resume's result
  assert.ok(!existsSync(join(S.xchg, "answers", "toolu_1.json")), "deleted after the resumed turn's result");
  assert.deepEqual(b.turns().map((t) => t.prompt), ["", "[dunan] update"]); // then the queued prompt
});

test("minor 5: a result that is not the resumed turn's does not delete the answer file", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await startTask(b, "T1");
  await b.core.onRunnerEvent({ ev: "result", lane: "T1", sessionId: "sT", stopReason: "end_turn" });
  await b.core.onRunnerEvent(ASK("toolu_1", "T1"));
  await b.core.onMessage({ id: "m1", ts: T0 + 2, text: "1" }); // resume turn dispatched, in flight
  await b.core.onRunnerEvent({ ev: "result", lane: "T1", error: "claude exited 1: boom" });
  assert.ok(existsSync(join(S.xchg, "answers", "toolu_1.json")), "kept when the resumed turn failed");
});

test("minor 6: runner events are handled one at a time, so a question and its poll are sent once", async () => {
  const S = sandbox();
  const b = mk(S);
  b.wa.delay = 40;
  await up(b);
  await startTask(b, "i1");
  await Promise.all([b.core.onRunnerEvent(ASK("toolu_1", "i1")), b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s2" })]);
  assert.equal(b.wa.texts.length, 1);
  assert.equal(b.wa.polls.length, 1);
  const again = mk(S);
  again.wa.delay = 20;
  await Promise.all([again.core.onRunnerEvent({ ev: "hello", busy: [] }), again.core.onRunnerEvent({ ev: "hello", busy: [] })]);
  assert.equal(again.wa.texts.length, 0); // pending question already shown: no re-ask
});

test("minor 7: the bridge creates the task lanes the runner lists in hello", async () => {
  const S = sandbox();
  const b = mk(S);
  await b.core.onOpen();
  await b.core.onRunnerEvent({ ev: "hello", busy: [], tasks: ["T7", "bad/../id"] });
  assert.deepEqual(Object.keys(b.state.d.lanes).sort(), ["T7", "chat"]);
  await b.core.onRunnerEvent({ ev: "result", lane: "T7", sessionId: "s", stopReason: "end_turn" }); // a replayed result is accepted
  assert.equal(b.state.d.sessions.T7, "s");
});

test("minor 9: a late append older than the newest processed message but newer than pairing is accepted once", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b); // pairedAt = clock
  await b.core.onMessage({ id: "n1", ts: T0 + 100, text: "baru" });
  await b.core.onMessage({ id: "late1", ts: T0 + 50, text: "telat, sempat nyangkut" });
  await b.core.onMessage({ id: "late1", ts: T0 + 50, text: "telat, sempat nyangkut" });
  await b.core.onMessage({ id: "hist1", ts: T0 - 10, text: "history sebelum pairing" });
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s" });
  assert.deepEqual(b.turns().flatMap((t) => t.prompt.split("\n\n")), ["baru", "telat, sempat nyangkut"]);
});

test("minor 10: bridge tables have no prototype", async () => {
  const S = sandbox();
  const b = mk(S);
  for (const k of ["sessions", "lanes", "polls", "inbox", "outbox", "codes", "grants", "grantsUsed", "tasks", "usage"]) {
    assert.equal(Object.getPrototypeOf(b.state.d[k]), null, k);
  }
  b.state.save();
  const again = openState(join(S.dir, "bridge", "state.json")); // survives a reload
  assert.equal(Object.getPrototypeOf(again.d.lanes), null);
});

// ======================= minors on the runner =======================
test("minor 1: pending grant reports are persisted and resent on every bridge hello until acked", async () => {
  const S = sandbox();
  mkdirSync(join(S.home, ".wa-runner"), { recursive: true });
  writeFileSync(join(S.home, ".wa-runner", "registry.json"), JSON.stringify({ lanes: {}, waiting: [], guard: { offset: 0, pending: [{ grant: "g-p1", toolUseId: "toolu_x", lane: "i1" }] } }));
  const R = await startRunner(S, {});
  const b1 = await connect(R.sock, { role: "bridge" });
  await b1.wait((e) => e.ev === "grant-used" && e.grant === "g-p1");
  b1.close();
  await sleep(50);
  const b2 = await connect(R.sock, { role: "bridge" }); // no ack yet: sent again
  await b2.wait((e) => e.ev === "grant-used" && e.grant === "g-p1");
  b2.send({ op: "grant-ack", grant: "g-p1" });
  await sleep(100);
  assert.deepEqual(JSON.parse(readFileSync(join(S.home, ".wa-runner", "registry.json"), "utf8")).guard.pending, []);
  b2.close();
  await sleep(50);
  const b3 = await connect(R.sock, { role: "bridge" });
  await sleep(150);
  assert.deepEqual(b3.of("grant-used"), []);
});

test("minor 1: the guard.log read offset survives a runner restart (no re-report, no gap)", async () => {
  const S = sandbox();
  const log = join(S.home, ".claude", "guard.log");
  const line = (id) => JSON.stringify({ decision: "pass-grant", grant_ids: [id], tool_use_id: "t", lane: "chat" }) + "\n";
  const R1 = await startRunner(S, { script: ["granted-merge", "granted-merge"] });
  writeFileSync(join(R1.ctl, "guard-lines.jsonl"), line("g-a"));
  const b = await connect(R1.sock, { role: "bridge" });
  b.send({ op: "turn", lane: "chat", prompt: "x", session: null });
  await b.wait((e) => e.ev === "result");
  assert.deepEqual(b.of("grant-used").map((u) => u.grant), ["g-a"]);
  await R1.runner.close();
  writeFileSync(log, readFileSync(log, "utf8") + line("g-b")); // written while the runner was down
  rmSync(join(R1.ctl, "guard-lines.jsonl"));
  const R2 = await startRunner(S, { script: ["plain"] });
  const b2 = await connect(R2.sock, { role: "bridge" });
  b2.send({ op: "turn", lane: "chat", prompt: "y", session: null });
  await b2.wait((e) => e.ev === "result");
  assert.deepEqual(b2.of("grant-used").map((u) => u.grant).sort(), ["g-a", "g-b"]); // g-a still pending (never acked), g-b read from the saved offset
});

test("minor 7: the runner buffers events while the bridge is away and replays them after hello", async () => {
  const S = sandbox();
  const R = await startRunner(S, { script: ["plain"] });
  const b = await connect(R.sock, { role: "bridge" });
  b.send({ op: "turn", lane: "chat", prompt: "x", session: null });
  b.close(); // the bridge dies right after sending the turn
  await waitFor(() => R.calls().length === 1);
  await sleep(400); // the turn finishes while nobody listens
  const b2 = await connect(R.sock, { role: "bridge" });
  const r = await b2.wait((e) => e.ev === "result", 3000);
  assert.equal(r.lane, "chat");
  assert.equal(b2.of("text")[0].text, "Halo Lord Faisal, ini jawaban singkat.");
  assert.deepEqual(b2.of("hello")[0].buffered, ["chat"]); // tells the bridge not to resume that lane itself
});

test("minor 4: notify_owner done from the chat lane is refused by the runner and the MCP", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const b = await connect(R.sock, { role: "bridge" });
  const r = await toolCall(R, "chat", "notify", { kind: "done", text: "x", nid: "n" });
  assert.equal(r.ok, false);
  await sleep(100);
  assert.deepEqual(b.of("notify"), []);
});

test("minor 10: the runner's lane table has no prototype and takes no __proto__ lane", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  assert.equal(Object.getPrototypeOf(R.runner.reg().lanes), null);
  const r = await toolCall(R, "chat", "start_task", { issue: "__proto__" });
  assert.equal(r.ok, false);
  assert.equal(({}).issue, undefined);
});

test("the guard CLI claims grants and logs grant_ids (spawned, sandbox HOME)", () => {
  const S = sandbox();
  // /xchg is fixed in the CLI, so no grant can match there: the CLI must log the new field shape and stay silent on pass
  const r = spawnSync("node", [join(ROOT, "hooks", "guard.mjs")], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" }), env: { HOME: S.home, PATH: process.env.PATH, WA_LANE: "chat" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  const rec = JSON.parse(readFileSync(join(S.home, ".claude", "guard.log"), "utf8").trim());
  assert.deepEqual(rec.grant_ids, []);
  assert.equal(rec.decision, "pass");
});
