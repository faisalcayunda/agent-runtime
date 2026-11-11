// Phase 6 (PLAN 2.10, D14, D15): wiki-sync.sh, the pod pre-commit, the runner seam and the wiki-retrieve hook, against two
// local bare repos in a temp dir (the claude-wiki stand-in and, for conflicts, a second writer). The clone is shallow over
// file:// like the boot clone. flock(1) is absent on macOS: testlib/flock stands in there and is not used where flock exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawn as realSpawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../hooks/guard.mjs";
import { ROOT, sandbox, sleep, waitFor } from "../testlib/helpers.mjs";
import { connect, startRunner, toolCall } from "../testlib/harness.mjs";

const HAVE_FLOCK = !spawnSync("flock", ["--version"]).error;
const PATH = HAVE_FLOCK ? process.env.PATH : `${join(ROOT, "testlib")}:${process.env.PATH}`;
const MAC_SCANNER = join(process.env.HOME ?? "/", ".claude", "scripts", "secret_scan.py");
const STUB = join(ROOT, "test", "fixtures", "wiki-scan-stub.py");
const FAKE = "FAKESECRET_" + "AB12CD34"; // split: this file carries no marker literal
const PAGE = (title, extra = "") => `---\ntitle: ${title}\ntype: concept\naliases: [catatan]\nstatus: draft\norg: dunan\n---\n${extra}text\n`;

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-C", cwd, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: join(cwd, "..", "nohome") } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// The pod layout (agent dir with bin/ and hooks/) copied out of the repo, the origin, and the shallow clone at ~/.claude/wiki.
function world({ scanner = STUB } = {}) {
  const S = sandbox();
  const agent = join(S.dir, "agent");
  mkdirSync(join(agent, "bin"), { recursive: true });
  cpSync(join(ROOT, "bin", "wiki-sync.sh"), join(agent, "bin", "wiki-sync.sh"));
  cpSync(join(ROOT, "hooks", "wiki-git"), join(agent, "hooks", "wiki-git"), { recursive: true });
  if (scanner) cpSync(scanner, join(agent, "hooks", "secret_scan.py"));
  const remote = join(S.dir, "claude-wiki.git");
  git(S.dir, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(S.dir, "seed");
  git(S.dir, "init", "-q", "-b", "main", seed);
  mkdirSync(join(seed, "concepts"));
  writeFileSync(join(seed, "concepts", "seed.md"), PAGE("Seed page", "line one\n"));
  git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "seed"); git(seed, "push", "-q", remote, "main");
  const clone = (dir) => { git(S.dir, "clone", "-q", "--depth", "1", `file://${remote}`, dir); git(dir, "config", "user.name", "Gremio"); git(dir, "config", "user.email", "g@example.com"); };
  const wiki = join(S.home, ".claude", "wiki");
  rmSync(wiki, { recursive: true });
  clone(wiki);
  const env = { HOME: S.home, PATH, WA_WIKI_RETRY_SLEEP: "0" };
  const sync = () => spawnSync(join(agent, "bin", "wiki-sync.sh"), [], { env, encoding: "utf8" });
  const status = (r) => /^WIKI_SYNC (.*)$/m.exec(r.stdout)?.[1];
  const onMain = (path) => git(remote, "show", `main:${path}`);
  const mainCount = () => Number(git(remote, "rev-list", "--count", "main"));
  const page = (rel, text) => { mkdirSync(join(wiki, rel, ".."), { recursive: true }); writeFileSync(join(wiki, rel), text); };
  return { S, agent, remote, wiki, clone, env, sync, status, onMain, mainCount, page };
}

test("a capture commit lands on main of the claude-wiki stand-in, as a draft of org dunan", () => {
  const w = world();
  w.page("concepts/Gremio note.md", PAGE("Gremio note"));
  const r = w.sync();
  assert.equal(r.status, 0, r.stderr);
  assert.match(w.status(r), /^status=pushed commit=[0-9a-f]+$/);
  const page = w.onMain("concepts/Gremio note.md");
  assert.match(page, /^status: draft$/m);
  assert.match(page, /^org: dunan$/m);
  assert.match(git(w.remote, "log", "-1", "--format=%s", "main"), /^docs: auto-commit wiki changes \(/);
  assert.equal(git(w.wiki, "rev-parse", "HEAD"), git(w.remote, "rev-parse", "main"));
});

test("an empty capture writes no commit, and still pulls what others pushed", () => {
  const w = world();
  const before = w.mainCount();
  let r = w.sync();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.status(r), "status=nothing");
  assert.equal(w.mainCount(), before);
  assert.equal(git(w.wiki, "log", "--oneline").split("\n").length, 1); // still the one shallow commit, no new local commit
  const other = join(w.S.dir, "other");
  w.clone(other);
  writeFileSync(join(other, "concepts", "from-mac.md"), PAGE("From Mac"));
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", "mac"); git(other, "push", "-q", "origin", "main");
  r = w.sync();
  assert.equal(w.status(r), "status=nothing");
  assert.ok(existsSync(join(w.wiki, "concepts", "from-mac.md")));
  assert.equal(w.mainCount(), before + 1);
});

test("a seeded fake secret is rejected by the pre-commit: nothing committed, nothing pushed, no value echoed", () => {
  const w = world();
  const head = git(w.wiki, "rev-parse", "HEAD"), before = w.mainCount();
  w.page("concepts/leak.md", PAGE("Leak", `key ${FAKE}\n`));
  const r = w.sync();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /concepts\/leak\.md:\d+: FAKE_SECRET/);
  assert.ok(!r.stderr.includes(FAKE) && !r.stdout.includes(FAKE));
  assert.equal(git(w.wiki, "rev-parse", "HEAD"), head);
  assert.equal(git(w.wiki, "diff", "--cached", "--name-only"), ""); // index clean, the page stays in the tree
  assert.ok(existsSync(join(w.wiki, "concepts", "leak.md")));
  assert.equal(w.mainCount(), before);
});

test("the pre-commit cannot be sidestepped from inside the clone, and fails closed without its scanner", () => {
  const w = world();
  // The model can write under ~/.claude/wiki, .git included: a planted hook and a core.hooksPath in .git/config change nothing.
  writeFileSync(join(w.wiki, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n"); chmodSync(join(w.wiki, ".git", "hooks", "pre-commit"), 0o755);
  mkdirSync(join(w.S.dir, "evil"));
  writeFileSync(join(w.S.dir, "evil", "pre-commit"), "#!/bin/sh\nexit 0\n"); chmodSync(join(w.S.dir, "evil", "pre-commit"), 0o755);
  git(w.wiki, "config", "core.hooksPath", join(w.S.dir, "evil"));
  w.page("concepts/leak.md", PAGE("Leak", `key ${FAKE}\n`));
  assert.equal(w.sync().status, 3);
  rmSync(join(w.agent, "hooks", "secret_scan.py")); // scanner gone: even a clean page is refused
  rmSync(join(w.wiki, "concepts", "leak.md"));
  w.page("concepts/clean.md", PAGE("Clean"));
  const r = w.sync();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /secret_scan\.py is missing/);
  assert.equal(w.mainCount(), 1);
});

test("a pre-commit that lost its exec bit refuses the commit instead of letting git skip it", () => {
  const w = world();
  chmodSync(join(w.agent, "hooks", "wiki-git", "pre-commit"), 0o644);
  w.page("concepts/leak.md", PAGE("Leak", `key ${FAKE}\n`));
  const r = w.sync();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not executable/);
  assert.equal(w.mainCount(), 1);
  assert.equal(git(w.wiki, "rev-list", "--count", "HEAD"), "1");
});

test("the real secret_scan.py gates the commit too", { skip: !existsSync(MAC_SCANNER) && "secret_scan.py not on this machine" }, () => {
  const w = world({ scanner: MAC_SCANNER });
  const fake = "MDM_DB_PAS" + "SWORD=" + "BGf" + "iZjBAu213"; // split so this file carries no secret-looking literal
  w.page("concepts/Leak page.md", PAGE("Leak", `${fake}\n`)); // wiki file names carry spaces
  const r = w.sync();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /concepts\/Leak page\.md:\d+: SECRET_ASSIGNMENT/);
  assert.ok(!r.stderr.includes("BGfiZj"));
  // The scanner skips files that carry its allow-file pragma in the first 5 lines: a model-written page must not get that.
  w.page("concepts/Leak page.md", `<!-- secret-scan: allow-file -->\n${PAGE("Leak", `${fake}\n`)}`);
  const p = w.sync();
  assert.equal(p.status, 3, `pragma bypass: ${p.stdout}${p.stderr}`);
  rmSync(join(w.wiki, "concepts", "Leak page.md"));
  w.page("concepts/Fine page.md", PAGE("Fine page"));
  assert.match(w.status(w.sync()), /^status=pushed/);
});

test("a rebase conflict ends on gremio-wiki-<ts> with main untouched and the clone usable again", () => {
  const w = world();
  const other = join(w.S.dir, "other");
  w.clone(other);
  writeFileSync(join(other, "concepts", "seed.md"), PAGE("Seed page", "line from the Mac\n"));
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", "mac edit"); git(other, "push", "-q", "origin", "main");
  const macHead = git(w.remote, "rev-parse", "main");
  w.page("concepts/seed.md", PAGE("Seed page", "line from Gremio\n"));
  const r = w.sync();
  assert.equal(r.status, 0, r.stderr);
  const m = /^status=conflict branch=(gremio-wiki-\d{8}T\d{6}Z)$/.exec(w.status(r));
  assert.ok(m, r.stdout);
  assert.equal(git(w.remote, "rev-parse", "main"), macHead); // main is exactly what the other writer pushed
  assert.match(git(w.remote, "show", `${m[1]}:concepts/seed.md`), /line from Gremio/);
  assert.equal(git(w.wiki, "status", "--porcelain"), "");
  assert.ok(!existsSync(join(w.wiki, ".git", "rebase-merge")) && !existsSync(join(w.wiki, ".git", "rebase-apply")));
  assert.equal(git(w.wiki, "rev-parse", "HEAD"), macHead);
  // The next sync is clean: no second conflict branch, the new page lands on main.
  w.page("concepts/next.md", PAGE("Next"));
  const r2 = w.sync();
  assert.match(w.status(r2), /^status=pushed/);
  assert.match(w.onMain("concepts/next.md"), /status: draft/);
  assert.equal(git(w.remote, "branch", "--list", "gremio-wiki-*").split("\n").length, 1);
});

test("a failing push is retried 3 times, keeps the commit, and lands on the next run", () => {
  const w = world();
  w.page("concepts/offline.md", PAGE("Offline"));
  git(w.wiki, "remote", "set-url", "origin", `file://${join(w.S.dir, "gone.git")}`);
  const r = w.sync();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gave up after 3 attempts/);
  assert.equal(w.mainCount(), 1);
  assert.equal(git(w.wiki, "rev-list", "--count", "HEAD"), "2"); // the shallow commit plus ours
  git(w.wiki, "remote", "set-url", "origin", `file://${w.remote}`);
  assert.match(w.status(w.sync()), /^status=pushed/);
  assert.match(w.onMain("concepts/offline.md"), /status: draft/);
});

test("the guard still denies a model git push from the wiki clone", () => {
  const w = world();
  const ctx = { home: w.S.home, xchg: w.S.xchg, lane: "chat", task: "t1", now: Date.now() };
  for (const [command, cwd] of [["git push origin main", w.wiki], [`git -C ${w.wiki} push origin HEAD:main`, w.S.home], [`cd ${w.wiki} && git push origin gremio-wiki-1`, w.S.home]]) {
    const v = evaluate({ tool_name: "Bash", tool_input: { command }, cwd }, ctx).verdict;
    assert.equal(v?.rule, "wiki-push", command);
  }
});

// ---- the runner seam: flock, the notice, the reply ----
const holder = (lock) => new Promise((res) => {
  const p = spawn("python3", ["-c", "import fcntl,sys;f=open(sys.argv[1],'a');fcntl.flock(f,2);print('held',flush=True);sys.stdin.read()", lock], { stdio: ["pipe", "pipe", "inherit"] });
  p.stdout.once("data", () => res({ release: () => p.stdin.end() }));
});

test("syncs serialize under flock: a held lock keeps the push back until it is released", async () => {
  const w = world();
  const R = await startRunner(w.S, { env: { PATH }, wikiEnv: { WA_WIKI_RETRY_SLEEP: "0" } });
  assert.equal(R.agentDir, w.agent); // the runner finds bin/wiki-sync.sh in the pod layout built by world()
  const lock = join(w.S.home, ".claude", "wiki-sync.lock");
  const h = await holder(lock);
  w.page("concepts/locked.md", PAGE("Locked"));
  let done = false;
  const call = toolCall(R, "chat", "wiki_capture").then((r) => { done = true; return r; });
  await sleep(600);
  assert.equal(done, false);
  assert.equal(w.mainCount(), 1); // nothing reached the remote while the lock was held
  h.release();
  const r = await call;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, "pushed");
  assert.match(w.onMain("concepts/locked.md"), /org: dunan/);
  await R.runner.close();
});

test("two concurrent syncs do not collide: one pushes, the other finds nothing left", async () => {
  const w = world();
  const R = await startRunner(w.S, { env: { PATH }, wikiEnv: { WA_WIKI_RETRY_SLEEP: "0" } });
  w.page("concepts/race.md", PAGE("Race"));
  const rs = await Promise.all([toolCall(R, "chat", "wiki_capture"), toolCall(R, "t1", "wiki_capture")]);
  assert.deepEqual(rs.map((r) => r.ok), [true, true], JSON.stringify(rs));
  assert.deepEqual(rs.map((r) => r.status).sort(), ["nothing", "pushed"]);
  assert.equal(w.mainCount(), 2);
  await R.runner.close();
});

test("a conflict and a rejected scan are both reported to the owner as a notice; the tool reply carries the branch", async () => {
  const w = world();
  const R = await startRunner(w.S, { env: { PATH }, wikiEnv: { WA_WIKI_RETRY_SLEEP: "0" } });
  const b = await connect(R.sock, { role: "bridge" });
  w.page("concepts/leak.md", PAGE("Leak", `key ${FAKE}\n`));
  const rej = await toolCall(R, "chat", "wiki_capture");
  assert.equal(rej.ok, false);
  assert.match(rej.error, /concepts\/leak\.md:\d+: FAKE_SECRET/);
  assert.match((await b.wait((e) => e.ev === "notice")).text, /ditolak scan rahasia[\s\S]*leak\.md/);
  rmSync(join(w.wiki, "concepts", "leak.md"));
  const other = join(w.S.dir, "other");
  w.clone(other);
  writeFileSync(join(other, "concepts", "seed.md"), PAGE("Seed page", "mac\n"));
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", "mac"); git(other, "push", "-q", "origin", "main");
  w.page("concepts/seed.md", PAGE("Seed page", "gremio\n"));
  const r = await toolCall(R, "chat", "wiki_capture");
  assert.equal(r.status, "conflict");
  assert.match(r.branch, /^gremio-wiki-/);
  const n = await b.wait((e) => e.ev === "notice" && e.text.includes(r.branch));
  assert.match(n.text, /bentrok/);
  await R.runner.close();
});

// ---- wiki-retrieve ----
const retrieve = (home, prompt) => {
  const r = spawnSync("python3", [join(ROOT, "hooks", "wiki-retrieve.py")], { input: JSON.stringify({ prompt, session_id: "s", cwd: "/x" }), env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};

test("wiki-retrieve returns the matching page for a prompt, labels a draft, and stays quiet otherwise", () => {
  const S = sandbox();
  const wiki = join(S.home, ".claude", "wiki");
  mkdirSync(join(wiki, "concepts"), { recursive: true });
  writeFileSync(join(wiki, "concepts", "Gremio wiki sync flock.md"), `---\ntitle: Gremio wiki sync flock\ntype: concept\naliases: [sinkron wiki Gremio]\ntags: [gremio]\nstatus: draft\norg: dunan\ndescription: How the runner serializes wiki pushes.\n---\nbody\n`);
  writeFileSync(join(wiki, "concepts", "Postgres vacuum notes.md"), `---\ntitle: Postgres vacuum notes\ntype: concept\nstatus: reviewed\norg: BGN\n---\nbody\n`);
  const out = retrieve(S.home, "jelaskan Gremio wiki sync flock itu apa");
  assert.equal(out.hookEventName, "UserPromptSubmit");
  assert.match(out.additionalContext, /Gremio wiki sync flock \[concept, dunan, draft\]: .*concepts\/Gremio wiki sync flock\.md/);
  assert.match(out.additionalContext, /How the runner serializes wiki pushes\./);
  assert.ok(!out.additionalContext.includes("Postgres vacuum"));
  assert.equal(retrieve(S.home, "ya"), null); // a bare acknowledgement never retrieves
  assert.equal(retrieve(S.home, "berapa harga tomat hari ini"), null);
  assert.equal(retrieve(join(S.dir, "no-wiki-here"), "jelaskan Gremio wiki sync flock itu apa"), null); // missing root: silent exit 0
});

test("the managed settings run wiki-retrieve on UserPromptSubmit, without onFailure block", () => {
  const h = JSON.parse(readFileSync(join(ROOT, "config", "managed-settings.json"), "utf8")).hooks.UserPromptSubmit;
  assert.equal(h.length, 1);
  assert.equal(h[0].hooks[0].command, "python3 /opt/wa-agent/hooks/wiki-retrieve.py");
  assert.equal(h[0].hooks[0].onFailure, undefined);
});

// ---- follow-ups: deletions, commits that skipped the hook, the read-path refresh ----
test("a model deletion of an owner page is never pushed: only additions and modifications are staged", () => {
  const w = world();
  rmSync(join(w.wiki, "concepts", "seed.md")); // the model deletes an owner page...
  git(w.wiki, "rm", "-q", "--cached", "concepts/seed.md"); // ...and even stages the deletion itself
  w.page("concepts/new.md", PAGE("New page"));
  const r = w.sync();
  assert.equal(r.status, 0, r.stderr);
  assert.match(w.status(r), /^status=pushed/);
  assert.match(w.onMain("concepts/new.md"), /title: New page/);
  assert.match(w.onMain("concepts/seed.md"), /title: Seed page/); // still on main
  assert.ok(existsSync(join(w.wiki, "concepts", "seed.md")), "the pod copy is restored so it cannot diverge");
  assert.equal(w.mainCount(), 2);
  // only deletions: nothing to commit, nothing pushed, no conflict
  rmSync(join(w.wiki, "concepts", "new.md"));
  const r2 = w.sync();
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(w.status(r2), "status=nothing");
  assert.equal(w.mainCount(), 2);
});

test("a commit made with --no-verify inside the clone is rescanned before the push, and nothing is pushed", () => {
  const w = world();
  const before = w.mainCount();
  w.page("concepts/leak.md", PAGE("Leak", `key ${FAKE}\n`));
  w.page("concepts/fine.md", PAGE("Fine"));
  git(w.wiki, "add", "-A");
  git(w.wiki, "commit", "-q", "--no-verify", "-m", "sneaky"); // the model skips the hook
  w.page("concepts/second.md", PAGE("Second")); // a later clean commit must not carry it out either
  const r = w.sync();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /concepts\/leak\.md:\d+: FAKE_SECRET/);
  assert.ok(!r.stderr.includes(FAKE) && !r.stdout.includes(FAKE));
  assert.equal(w.mainCount(), before);
  assert.equal(git(w.remote, "branch", "--list").replace(/[* ]/g, ""), "main"); // no branch carries it either
  assert.equal(git(w.wiki, "rev-parse", "HEAD"), git(w.remote, "rev-parse", "main")); // local commits undone ...
  assert.ok(existsSync(join(w.wiki, "concepts", "leak.md"))); // ... the pages stay in the tree for the model to fix
  rmSync(join(w.wiki, "concepts", "leak.md"));
  const again = w.sync(); // once fixed, the rest goes out
  assert.equal(again.status, 0, again.stderr);
  assert.match(w.onMain("concepts/fine.md"), /title: Fine/);
});

test("a commit that carries the allow-file pragma is refused before the push too", () => {
  const w = world();
  w.page("concepts/skip.md", `# secret-scan: ` + `allow-file\n${PAGE("Skip", `key ${FAKE}\n`)}`);
  git(w.wiki, "add", "-A");
  git(w.wiki, "commit", "-q", "--no-verify", "-m", "sneaky");
  const r = w.sync();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /allow-file/);
  assert.equal(w.mainCount(), 1);
});

test("the rescan fails closed when the scanner is gone", () => {
  const w = world();
  w.page("concepts/p.md", PAGE("P"));
  git(w.wiki, "add", "-A");
  git(w.wiki, "commit", "-q", "--no-verify", "-m", "sneaky");
  rmSync(join(w.agent, "hooks", "secret_scan.py"));
  assert.equal(w.sync().status, 3);
  assert.equal(w.mainCount(), 1);
});

test("wiki-sync.sh refresh fast-forwards the clone to origin/main and never discards local pages or commits", () => {
  const w = world();
  const other = join(w.S.dir, "other");
  w.clone(other);
  writeFileSync(join(other, "concepts", "mac.md"), PAGE("From the Mac"));
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", "mac"); git(other, "push", "-q", "origin", "main");
  w.page("concepts/draft-in-progress.md", PAGE("Uncommitted draft")); // written by the model, not synced yet
  const run = () => spawnSync(join(w.agent, "bin", "wiki-sync.sh"), ["refresh"], { env: w.env, encoding: "utf8" });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(w.status(r), /^status=refreshed/);
  assert.ok(existsSync(join(w.wiki, "concepts", "mac.md")));
  assert.ok(existsSync(join(w.wiki, "concepts", "draft-in-progress.md")), "an uncommitted page survives the refresh");
  assert.equal(w.mainCount(), 2); // refresh never commits or pushes
  // local commit ahead + upstream moved: no reset, no data loss, status says skipped
  git(w.wiki, "add", "-A"); git(w.wiki, "commit", "-q", "--no-verify", "-m", "local");
  writeFileSync(join(other, "concepts", "mac2.md"), PAGE("Mac two"));
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", "mac2"); git(other, "push", "-q", "origin", "main");
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(w.status(r), /^status=skipped/);
  assert.match(git(w.wiki, "log", "-1", "--format=%s"), /local/);
  // network down: fail soft with exit 0 and a skipped status
  git(w.wiki, "remote", "set-url", "origin", "file:///nonexistent.git");
  r = run();
  assert.equal(r.status, 0);
  assert.match(w.status(r), /^status=skipped/);
});

const refreshWorld = async (extra = {}) => {
  const S = sandbox();
  const calls = [];
  const spawn = (cmd, args, o) => {
    if (cmd === "flock") { calls.push({ what: "refresh", args }); const p = realSpawn(process.execPath, ["-e", extra.refreshCode ?? ""], o); return p; }
    calls.push({ what: "claude" });
    return realSpawn(cmd, args, o);
  };
  const R = await startRunner(S, { script: ["plain"], spawn, ...extra.opts });
  mkdirSync(join(R.agentDir, "bin"), { recursive: true });
  const script = join(R.agentDir, "bin", "wiki-sync.sh");
  writeFileSync(script, "#!/bin/sh\n");
  const b = await connect(R.sock, { role: "bridge" });
  return { S, R, b, calls, script };
};

test("before a turn that has a prompt the runner refreshes the wiki under flock, before claude starts", async () => {
  const { S, R, b, calls, script } = await refreshWorld();
  b.send({ op: "turn", lane: "chat", prompt: "halo", session: null });
  await b.wait((e) => e.ev === "result");
  assert.deepEqual(calls.map((c) => c.what), ["refresh", "claude"]);
  assert.deepEqual(calls[0].args, ["-w", "10", join(S.home, ".claude", "wiki-sync.lock"), script, "refresh"]);
  b.send({ op: "turn", lane: "i1", task: "i1", prompt: "[task] go", session: null }); // a task-lane turn with a prompt
  await waitFor(() => b.of("result").length === 2);
  assert.deepEqual(calls.map((c) => c.what), ["refresh", "claude", "refresh", "claude"]);
  b.send({ op: "turn", lane: "chat", prompt: "", session: "sess-1" }); // an empty-prompt resume retrieves nothing
  await waitFor(() => b.of("result").length === 3);
  assert.deepEqual(calls.map((c) => c.what), ["refresh", "claude", "refresh", "claude", "claude"]);
  await R.runner.close();
});

test("a failing or hanging refresh never blocks the turn", async () => {
  const bad = await refreshWorld({ refreshCode: "process.exit(1)" });
  bad.b.send({ op: "turn", lane: "chat", prompt: "x", session: null });
  await bad.b.wait((e) => e.ev === "result");
  assert.deepEqual(bad.calls.map((c) => c.what), ["refresh", "claude"]);
  const slow = await refreshWorld({ refreshCode: "setTimeout(() => {}, 60000)", opts: { wikiRefreshTimeoutMs: 300 } });
  const t0 = Date.now();
  slow.b.send({ op: "turn", lane: "chat", prompt: "x", session: null });
  await slow.b.wait((e) => e.ev === "result", 4000);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(slow.calls.map((c) => c.what), ["refresh", "claude"]);
  await bad.R.runner.close(); await slow.R.runner.close();
});

test("a second turn request on a lane whose refresh is still running is busy, not a second process", async () => {
  const w = await refreshWorld({ refreshCode: "setTimeout(() => {}, 400)" });
  w.b.send({ op: "turn", lane: "chat", prompt: "a", session: null });
  w.b.send({ op: "turn", lane: "chat", prompt: "b", session: null });
  await w.b.wait((e) => e.ev === "busy");
  await w.b.wait((e) => e.ev === "result", 4000);
  assert.equal(w.calls.filter((c) => c.what === "claude").length, 1);
  await w.R.runner.close();
});
