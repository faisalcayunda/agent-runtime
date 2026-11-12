// Guard, ask-defer hook and secret-guard tests (PLAN 2.7, 2.12, 5.2; S6, S11, S12).
// Fields assumed from the Claude Code PreToolUse hook input (hooks.md): tool_name, tool_input.command,
// tool_input.file_path / content / new_string / edits[].new_string, tool_input.questions, tool_use_id, cwd,
// session_id. Output: hookSpecificOutput.permissionDecision (deny | allow | defer), updatedInput.
// The 28 spike cases were not found on disk (only guard.mjs was), so the first block RECONSTRUCTS them from the
// spike guard's rules (T5 list in PLAN phase 1 plus each rule in spike/guard.mjs). It is not a port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../hooks/guard.mjs";
import { decide } from "../hooks/ask-defer.mjs";
import { evaluate as secretEval, defaultScan } from "../hooks/secret-guard.mjs";
import { ROOT, sandbox } from "../testlib/helpers.mjs";

const S = sandbox();
const ctx = (over = {}) => ({ home: S.home, xchg: S.xchg, lane: "chat", task: "task-1", now: Date.now(), ...over });
const bash = (command, over = {}, extra = {}) => evaluate({ tool_name: "Bash", tool_input: { command }, ...extra }, ctx(over)).verdict;
const file = (tool_name, file_path, over = {}) => evaluate({ tool_name, tool_input: { file_path, content: "x" } }, ctx(over)).verdict;
const denies = (v, rule) => { assert.ok(v?.deny, `expected deny, got ${JSON.stringify(v)}`); if (rule) assert.equal(v.rule, rule); };
const passes = (v) => assert.ok(!v?.deny, `expected pass, got ${JSON.stringify(v)}`);
const grantFile = (g) => writeFileSync(join(S.xchg, "grants", `${g.id}.json`), JSON.stringify(g));
const FORK_BOMB = ":(" + "){ :|:& };:"; // built from pieces so no tool hook trips on this source file

// ---- reconstructed spike cases (23 deny rows + 7 behaviour tests below = 30, so 2 more than the 28 reported) ----
const SPIKE_DENY = [
  ["gh repo delete x", "gh repo delete x/y", "gh-repo-delete"],
  ["gh secret set", "gh secret set TOKEN --body x", "gh-secret"],
  ["gh api PATCH refs", "gh api -X PATCH repos/x/y/git/refs/heads/main -f sha=abc", "gh-api-refs"],
  ["gh api --method=DELETE refs", "gh api --method=DELETE repos/x/y/git/refs/heads/main", "gh-api-refs"],
  ["kubectl delete", "kubectl delete pod foo", "no-cluster-tools"],
  ["sudo kubectl via wrapper", "sudo -n env A=1 kubectl get pods", "no-cluster-tools"],
  ["sops", "sops -d secret.yaml", "no-cluster-tools"],
  ["restic forget", "restic forget --keep-last 1", "restic-forget"],
  ["DROP TABLE", "psql -c 'DROP TABLE users'", "sql-drop"],
  ["TRUNCATE", "psql -c 'TRUNCATE users'", "sql-truncate"],
  ["DELETE FROM no where", "psql -c 'delete from users'", "sql-delete-no-where"],
  ["push HEAD:refs/heads/main", "git push origin HEAD:refs/heads/main", "git-push-protected"],
  ["push to main", "git push origin main", "git-push-protected"],
  ["push to dev (src:dst)", "git push origin feature:dev", "git-push-protected"],
  ["push --force", "git push --force origin feature", "git-push-force"],
  ["push -f", "git push -f origin feature", "git-push-force"],
  ["push +refspec", "git push origin +feature", "git-push-force"],
  ["push bare", "git push", "git-push-no-refspec"],
  ["push bare HEAD", "git push origin HEAD", "git-push-no-refspec"],
  ["push delete main", "git push origin :main", "git-push-delete-protected"],
  ["nested bash -c", "bash -c 'git push origin main'", "git-push-protected"],
  ["command substitution", "echo $(git push origin main)", "git-push-protected"],
  ["gh pr merge without grant", "gh pr merge https://github.com/o/r/pull/1", "merge-no-grant"],
];
for (const [name, cmd, rule] of SPIKE_DENY) test(`guard (spike T5): denies ${name}`, () => denies(bash(cmd), rule));

test("guard (spike): denies Write to ~/.claude/settings.json", () => denies(file("Write", join(S.home, ".claude", "settings.json")), "policy-path-write"));
test("guard (spike): denies Bash redirect into ~/.claude/settings.json", () => denies(bash(`echo '{}' > ~/.claude/settings.json`), "policy-path-write"));
test("guard (spike): denies a symlink that points at settings.json", () => {
  mkdirSync(join(S.home, "w"), { recursive: true });
  writeFileSync(join(S.home, ".claude", "settings.json"), "{}");
  spawnSync("ln", ["-sf", join(S.home, ".claude", "settings.json"), join(S.home, "w", "link.json")]);
  denies(file("Edit", join(S.home, "w", "link.json")), "policy-path-write");
});
test("guard (spike): passes ordinary commands silently", () => {
  for (const c of ["ls -la", "git status", "git push origin feature/x", "gh pr create --fill", "cat ~/.claude/settings.json", "git log --oneline | head"]) passes(bash(c));
});
test("guard (spike): never returns allow, silent when not denying, exit 0", () => {
  const r = spawnSync("node", [join(ROOT, "hooks", "guard.mjs")], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), env: { HOME: S.home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
test("guard (spike): fail closed with exit 2 on bad stdin", () => {
  const r = spawnSync("node", [join(ROOT, "hooks", "guard.mjs")], { input: "not json", env: { HOME: S.home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 2);
});
test("guard (spike): CLI deny is JSON on stdout and one log line, with lane and task", () => {
  const r = spawnSync("node", [join(ROOT, "hooks", "guard.mjs")], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "kubectl get pods" }, tool_use_id: "toolu_1" }), env: { HOME: S.home, PATH: process.env.PATH, WA_LANE: "task", WA_TASK_ID: "t9" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  const rec = JSON.parse(readFileSync(join(S.home, ".claude", "guard.log"), "utf8").trim().split("\n").pop());
  assert.deepEqual([rec.decision, rec.rule, rec.lane, rec.task, rec.tool_use_id], ["deny", "no-cluster-tools", "task", "t9", "toolu_1"]);
});

// ---- grants (S12) ----
test("gh pr merge, git push to main and an approval comment are denied without a grant and allowed with one", () => {
  const url = "https://github.com/o/r/pull/7";
  denies(bash(`gh pr merge ${url} --squash`), "merge-no-grant");
  grantFile({ id: "g-merge", kind: "merge", url, created_at: Date.now() });
  const v = bash(`gh pr merge ${url}/ --squash`);
  passes(v); assert.deepEqual(v.grants, ["g-merge"]);
  denies(bash("gh pr merge https://github.com/o/r/pull/8"), "merge-no-grant");
  denies(bash("gh pr merge 7"), "merge-needs-url");

  denies(bash("git push origin main"), "git-push-protected");
  grantFile({ id: "g-push", kind: "push-main", task_id: "task-1", branch: "main", created_at: Date.now() });
  const p = bash("git push origin HEAD:main");
  passes(p); assert.deepEqual(p.grants, ["g-push"]);
  denies(bash("git push origin main", { task: "task-2" }), "git-push-protected");
  denies(bash("git push origin dev"), "git-push-protected"); // the grant is for main only

  const cmd = `multica issue comment add 123 --content "[gremio] done k7q-4821"`;
  denies(bash(cmd), "approval-no-grant");
  grantFile({ id: "g-appr", kind: "approval", code: "k7q-4821", verb: "done", created_at: Date.now() });
  const a = bash(cmd);
  passes(a); assert.deepEqual(a.grants, ["g-appr"]);
  denies(bash(`multica issue comment add 123 --content "[gremio] deny zzz-1234"`), "approval-no-grant");
});
test("a grant expires after 24 h and honours an earlier expires_at", () => {
  const url = "https://github.com/o/r/pull/9";
  grantFile({ id: "g-old", kind: "merge", url, created_at: Date.now() - 25 * 3600 * 1000 });
  denies(bash(`gh pr merge ${url}`), "merge-no-grant");
  grantFile({ id: "g-short", kind: "merge", url, created_at: Date.now(), expires_at: Date.now() - 1000 });
  denies(bash(`gh pr merge ${url}`), "merge-no-grant");
  grantFile({ id: "g-ok", kind: "merge", url, created_at: Date.now() - 23 * 3600 * 1000 });
  assert.ok(bash(`gh pr merge ${url}`).grants.length);
});
test("a grant of another kind does not satisfy a merge", () => {
  const url = "https://github.com/o/r/pull/10";
  grantFile({ id: "g-x", kind: "approval", code: "abc-123", url, created_at: Date.now() });
  denies(bash(`gh pr merge ${url}`), "merge-no-grant");
});

// ---- multica (S11) ----
test("the guard denies Multica structure writes and comments without [gremio]", () => {
  for (const c of [
    "multica skill create --name x", "multica skill update s1 --content y", "multica autopilot create x",
    "multica runtime delete r1", "multica squad create x", "multica squad update s1", "multica workspace create x",
    "multica --profile dev agent delete a1", "multica --workspace-id w1 project delete p1", "multica issue delete 1",
    "multica issue comment delete c1",
  ]) denies(bash(c));
  denies(bash(`multica issue comment add 1 --content "hello"`), "multica-comment-prefix");
  denies(bash(`multica issue comment add 1 --content "x [gremio]"`), "multica-comment-prefix");
  denies(bash(`multica issue comment update c1 --content "plain"`), "multica-comment-prefix");
  denies(bash(`multica issue comment add 1 --content-file body.md`), "multica-comment-body-unchecked");
  denies(bash(`echo hi | multica issue comment add 1 --content-stdin`), "multica-comment-body-unchecked");
  denies(bash(`multica issue comment add 1`), "multica-comment-body-unchecked");
  denies(bash(`bash -c 'multica agent delete a1'`));
});
test("the guard allows Multica reads, issue work and [gremio] comments", () => {
  for (const c of [
    "multica agent list", "multica project get p1 --output json", "multica workspace list", "multica --profile x issue list",
    "multica issue create --title t --project p1 --status todo", "multica issue status 1 in_progress", "multica issue update 1 --description d",
    "multica issue get 1 --output json", "multica issue comment list 1 --output json --since 2026-01-01T00:00:00Z",
    `multica issue comment add 1 --content "[gremio] done with the review"`,
    `multica issue comment add 1 --content="[gremio] kerja udah masuk PR"`,
  ]) passes(bash(c));
});

test("the guard denies Multica deletes, workspace writes, skill binding and anything off the allowed list", () => {
  for (const c of [
    "multica agent delete a1", "multica agent archive a1", "multica agent restore a1", "multica agent copy a1", "multica agent env set a1 K=V",
    "multica agent skills set a1 --skill-ids s1", "multica agent skills add a1 --skill-ids s1", "multica agent skills",
    "multica project delete p1", "multica project resource add p1", "multica workspace update w1 --name x", "multica workspace member add w1 x",
    "multica workspace invite x", "multica workspace delete w1", "multica workspace create x", "multica workspace mcp add x",
    "multica workflow update f1", "multica workflow delete f1", "multica workflow archive f1", "multica workflow remove f1",
    "multica skill delete s1", "multica skill create --name x", "multica autopilot create x", "multica runtime update r1", "multica squad create x",
    "multica agent --output json delete a1", "multica project --yes delete p1", "multica --profile dev agent skills set a1 --skill-ids s1",
    "multica --workspace-id w1 agent delete a1", `bash -c 'multica project delete p1'`,
  ]) denies(bash(c), "multica-structure-write");
});
test("the guard allows the Multica project, agent, workflow and workspace-switch writes Gremio owns (own member account, 2026-11-12)", () => {
  for (const c of [
    "multica project create --title Co-operative", "multica project update p1 --title x", "multica project update p1 --status in_progress",
    "multica agent create --name x --instructions y", "multica agent update a1 --instructions y", "multica agent skills list a1",
    "multica workflow create --steps-file f.json", "multica workflow get f1", "multica workflow list",
    "multica workspace switch w1", "multica workspace list", "multica workspace get w1", "multica --profile x workspace switch w1",
    "multica --workspace-id w1 project create --title t", "multica agent --help", "multica project -h", "multica project",
  ]) passes(bash(c));
});

// ---- rm -rf ----
test("rm -rf outside ~/assistant is denied, inside is allowed", () => {
  const A = join(S.home, "assistant");
  for (const c of [
    "rm -rf /", "rm -rf ~", "rm -rf $HOME/projects", "rm -rf ~/assistant", "rm -rf ~/assistant/../x",
    "rm -r /tmp/x", "rm -fr /tmp/x", "rm --recursive --force /tmp/x", "rm -rf $UNKNOWN/x",
    "rm -rf ~/assistant/$(echo ..)/x", "rm -rf ~/assistant/../*", "find . | xargs rm -rf", "rm -rf -- /tmp/y",
  ]) denies(bash(c), "rm-rf-outside-assistant");
  denies(bash("rm -rf relative", {}, { cwd: S.home }), "rm-rf-outside-assistant");
  passes(bash("rm -rf ~/assistant/build"));
  passes(bash(`rm -rf ${A}/work/node_modules`));
  passes(bash("rm -rf ~/assistant/work/*"));
  passes(bash("rm -rf build dist", {}, { cwd: join(A, "proj") }));
  passes(bash("rm file.txt")); // not recursive
});

// ---- policy paths and lanes ----
test("writes to ~/.claude (except wiki), /opt, /etc and /xchg/{answers,grants,events} are denied", () => {
  for (const p of [".claude/skills/x/SKILL.md", ".claude/agents/x.md", ".claude/CLAUDE.md", ".claude/guard.log", ".claude/settings.local.json", ".claude.json"]) {
    denies(file("Write", join(S.home, p)), "policy-path-write");
  }
  for (const p of ["/opt/wa-agent/hooks/guard.mjs", "/etc/claude-code/managed-settings.json", join(S.xchg, "answers", "x.json"), join(S.xchg, "grants", "g.json"), join(S.xchg, "events", "e.json")]) {
    denies(file("Edit", p), "policy-path-write");
  }
  passes(file("Write", join(S.home, ".claude", "wiki", "concepts", "x.md")));
  passes(file("Write", join(S.home, "assistant", "notes.md")));
  passes(file("Write", join(S.xchg, "inbox", "x.txt")));
});
test("Bash writes to protected paths are denied; reads are not", () => {
  denies(bash("cp /tmp/x ~/.claude/skills/evil.md"), "policy-path-write");
  denies(bash("tee ~/.claude/CLAUDE.md < /tmp/x"), "policy-path-write");
  denies(bash("mv /tmp/x /opt/wa-agent/hooks/guard.mjs"), "policy-path-write");
  denies(bash(`sed -i s/a/b/ ${S.xchg}/grants/g1.json`), "policy-path-write");
  denies(bash(`echo '{}' >> ${S.xchg}/answers/toolu_1.json`), "policy-path-write");
  denies(bash(`python3 -c "open('/etc/claude-code/managed-settings.json','w')"`), "policy-path-write");
  denies(bash("touch agents/x.md", {}, { cwd: join(S.home, ".claude") }), "policy-path-write");
  passes(bash("cp ~/.claude/skills/a/SKILL.md /tmp/copy.md"));
  passes(bash("ls ~/.claude/skills | sort > /tmp/list.txt"));
  passes(bash("echo hi > ~/.claude/wiki/concepts/x.md"));
});
test("a task-lane memory write is denied, the chat lane may write it", () => {
  const mem = join(S.home, ".claude", "agent-memory", "MEMORY.md");
  denies(file("Write", mem, { lane: "task" }), "memory-write-not-chat-lane");
  denies(file("Edit", mem, { lane: "task" }), "memory-write-not-chat-lane");
  denies(file("Write", mem, { lane: undefined }), "memory-write-not-chat-lane"); // fail closed when the lane is unknown
  denies(bash(`echo x >> ${mem}`, { lane: "task" }), "memory-write-not-chat-lane");
  passes(file("Write", mem, { lane: "chat" }));
  passes(bash(`echo x >> ${mem}`, { lane: "chat" }));
});
test("model pushes from ~/.claude/wiki are denied in every form", () => {
  const w = join(S.home, ".claude", "wiki");
  denies(bash("git push origin main", {}, { cwd: w }), "wiki-push");
  denies(bash("git push origin gremio-wiki-1", {}, { cwd: w }), "wiki-push");
  denies(bash(`git -C ${w} push origin main`), "wiki-push");
  denies(bash(`git -C ${w} push origin HEAD:main`), "wiki-push");
  denies(bash(`cd ${w} && git push origin main`), "wiki-push");
  denies(bash("cd ~/.claude/wiki; git push origin x"), "wiki-push");
  denies(bash(`bash -c 'cd ${w} && git push origin x'`), "wiki-push");
  passes(bash("git -C ~/work push origin feature/x"));
  passes(bash(`git -C ${w} log --oneline`));
});
test("ported guard-dangerous rules deny (ask mapped to deny, push and commit stay allowed)", () => {
  for (const c of [FORK_BOMB, "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "chmod -R 777 /", "env", "printenv", "export -p", "git reset --hard HEAD~1", "git clean -fd", "git branch -D x", "terraform destroy", "docker system prune -af"]) denies(bash(c));
  for (const c of ["git commit -m x", "git rebase origin/feature", "env FOO=1 node x.js", "git clean -n"]) passes(bash(c));
});
test("mcp tools are scanned for SQL, the owner MCP is not", () => {
  denies(evaluate({ tool_name: "mcp__db__query", tool_input: { sql: "DROP TABLE x" } }, ctx()).verdict, "sql-drop");
  passes(evaluate({ tool_name: "mcp__owner__notify_owner", tool_input: { text: "hi" } }, ctx()).verdict);
  passes(evaluate({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } }, ctx()).verdict);
});

// ---- ask-defer ----
test("ask-defer: defers without an answer file, allows with updatedInput = questions + answers", () => {
  const questions = [{ question: "Which framework?", header: "FW", options: [{ label: "React", description: "" }, { label: "Vue", description: "" }], multiSelect: false }];
  const input = { tool_name: "AskUserQuestion", tool_use_id: "toolu_q1", tool_input: { questions } };
  assert.equal(decide(input, S.xchg).permissionDecision, "defer");
  writeFileSync(join(S.xchg, "answers", "toolu_q1.json"), JSON.stringify({ questions: [{ question: "FORGED" }], answers: { "Which framework?": "React" } }));
  const out = decide(input, S.xchg);
  assert.equal(out.permissionDecision, "allow");
  assert.deepEqual(out.updatedInput, { questions, answers: { "Which framework?": "React" } }); // questions come from Claude, not the file
  assert.equal(decide({ ...input, tool_use_id: "../../etc/passwd" }, S.xchg).permissionDecision, "defer");
  assert.equal(decide({ ...input, tool_name: "Bash" }, S.xchg), null);
});
test("ask-defer CLI ignores a WA_XCHG_DIR override", () => {
  writeFileSync(join(S.xchg, "answers", "toolu_q2.json"), JSON.stringify({ answers: { q: "a" } }));
  const r = spawnSync("node", [join(ROOT, "hooks", "ask-defer.mjs")], { input: JSON.stringify({ tool_name: "AskUserQuestion", tool_use_id: "toolu_q2", tool_input: { questions: [] } }), env: { HOME: S.home, PATH: process.env.PATH, WA_XCHG_DIR: S.xchg }, encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "defer"); // the fixed /xchg does not exist here
});

// ---- secret-guard ----
test("secret-guard: denies a secret in wiki and memory writes, fails closed without a scanner, ignores other paths", () => {
  const scan = (t) => (/ghp_|password=/i.test(t) ? ["GITHUB_TOKEN"] : []);
  const w = (file_path, content, extra = {}) => secretEval({ tool_name: "Write", tool_input: { file_path, content, ...extra } }, { home: S.home, scan });
  assert.match(w(join(S.home, ".claude", "wiki", "a.md"), "token ghp_abc"), /GITHUB_TOKEN/);
  assert.match(w(join(S.home, ".claude", "agent-memory", "m.md"), "x", { edits: [{ new_string: "password=abc" }] }), /GITHUB_TOKEN/);
  assert.equal(w(join(S.home, ".claude", "wiki", "a.md"), "clean text"), null);
  assert.equal(w(join(S.home, "assistant", "a.md"), "ghp_abc"), null);
  const boom = () => { throw new Error("no python"); };
  assert.match(secretEval({ tool_name: "Write", tool_input: { file_path: join(S.home, ".claude", "wiki", "a.md"), content: "x" } }, { home: S.home, scan: boom }), /could not run its scanner/);
  assert.equal(secretEval({ tool_name: "Write", tool_input: { file_path: "/tmp/x", content: "x" } }, { home: S.home, scan: boom }), null);
});
test("secret-guard CLI: the real scanner is absent in this checkout, so in-scope writes are denied (fail closed)", () => {
  assert.equal(existsSync(join(ROOT, "hooks", "secret_scan.py")), false); // phase 3 copies it from the pinned claude-config
  const r = spawnSync("node", [join(ROOT, "hooks", "secret-guard.mjs")], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(S.home, ".claude", "wiki", "a.md"), content: "hello" } }), env: { HOME: S.home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

// The real scanner is the Mac's secret_scan.py (phase 3 copies the pinned claude-config copy next to the hook). This case
// runs only where that file exists, so on another machine it shows up as one skipped test, not a pass.
const MAC_SCANNER = join(process.env.HOME ?? "/", ".claude", "scripts", "secret_scan.py");
test("secret-guard drives the real secret_scan.py over stdin", { skip: !existsSync(MAC_SCANNER) && "secret_scan.py not on this machine" }, () => {
  const fake = "MDM_DB_PAS" + "SWORD=" + "BGf" + "iZjBAu213"; // split so this file itself carries no secret-looking literal
  assert.deepEqual(defaultScan(fake, MAC_SCANNER), ["SECRET_ASSIGNMENT"]);
  assert.deepEqual(defaultScan("catatan biasa tanpa rahasia", MAC_SCANNER), []);
  assert.throws(() => defaultScan("x", join(S.dir, "missing.py")));
});

// secret_scan.py skips a file whose first 5 lines carry its allow-file pragma, so a model write must never carry it.
const PRAGMA = "secret-scan: " + "allow-file"; // split so this file is not skipped by the scanner itself
test("secret-guard denies a write to a guarded path that carries the scanner's allow-file pragma, before scanning", () => {
  const scan = () => []; // a scanner that skips the file finds nothing: the pragma check must not depend on it
  const w = (file_path, extra) => secretEval({ tool_name: "Write", tool_input: { file_path, ...extra } }, { home: S.home, scan });
  const wiki = join(S.home, ".claude", "wiki", "a.md"), mem = join(S.home, ".claude", "agent-memory", "m.md");
  for (const path of [wiki, mem]) {
    assert.match(w(path, { content: `# ${PRAGMA}\npassword=Zz9yy88xx` }), /allow-file/);
    assert.match(w(path, { content: `<!-- ${PRAGMA} -->\ntext` }), /allow-file/);
    assert.match(w(path, { content: `---\ntitle: x\n---\n${PRAGMA.toUpperCase()}\n` }), /allow-file/);
    assert.match(w(path, { new_string: "allow-file" }), /allow-file/); // an Edit assembling the pragma piece by piece
    assert.match(w(path, { edits: [{ new_string: `x ${PRAGMA}` }] }), /allow-file/);
  }
  assert.equal(w(wiki, { content: "a normal page" }), null);
  assert.equal(w(join(S.home, "assistant", "a.md"), { content: PRAGMA }), null); // other paths are not this guard's scope
  // it does not even call the scanner
  let called = 0;
  secretEval({ tool_name: "Write", tool_input: { file_path: wiki, content: PRAGMA } }, { home: S.home, scan: () => { called++; return []; } });
  assert.equal(called, 0);
});

test("the real scanner skips a pragma file (why the guard must deny it) and the guard denies it anyway", { skip: !existsSync(MAC_SCANNER) && "secret_scan.py not on this machine" }, () => {
  const fake = "MDM_DB_PAS" + "SWORD=" + "BGf" + "iZjBAu213";
  assert.deepEqual(defaultScan(`# ${PRAGMA}\n${fake}`, MAC_SCANNER), []); // confirmed: the scanner is blind to it
  const reason = secretEval({ tool_name: "Write", tool_input: { file_path: join(S.home, ".claude", "wiki", "a.md"), content: `# ${PRAGMA}\n${fake}` } }, { home: S.home, scan: (t) => defaultScan(t, MAC_SCANNER) });
  assert.match(reason, /allow-file/);
});

test("a group-lane memory write is denied like a task lane's; a group lane never uses a merge grant", () => {
  const mem = join(S.home, ".claude", "agent-memory", "MEMORY.md");
  denies(file("Write", mem, { lane: "group" }), "memory-write-not-chat-lane");
  denies(file("Edit", mem, { lane: "group" }), "memory-write-not-chat-lane");
  denies(bash(`echo x >> ${mem}`, { lane: "group" }), "memory-write-not-chat-lane");
  denies(bash(`python3 -c "open('${mem}','w')"`, { lane: "group" }), "policy-path-write");
  passes(file("Write", join(S.home, "assistant", "groups", "120363", "n.md"), { lane: "group" }));
  const url = "https://github.com/o/r/pull/41";
  grantFile({ id: "g-grp-merge", kind: "merge", url, created_at: Date.now() });
  denies(bash(`gh pr merge ${url} --squash`, { lane: "group", task: "grp_120363" }), "merge-no-grant");
  assert.deepEqual(bash(`gh pr merge ${url} --squash`, { lane: "chat" }).grants, ["g-grp-merge"]); // the chat lane still can
});

test("task and group lanes cannot write instruction files under ~/assistant outside their own cwd; the chat lane's reset removes them", () => {
  const A = join(S.home, "assistant");
  const own = { task: { lane: "task", task: "t1" }, group: { lane: "group", task: "grp_120363" } };
  const mine = { task: join(A, "tasks", "t1"), group: join(A, "groups", "120363") };
  for (const kind of ["task", "group"]) {
    const o = own[kind];
    for (const p of [join(A, "CLAUDE.md"), join(A, "CLAUDE.local.md"), join(A, ".claude", "settings.json"), join(A, ".claude", "skills", "x", "SKILL.md"),
      join(A, "tasks", "other", "CLAUDE.md"), join(A, "groups", "999999", ".claude", "x.md"), join(A, "repos", "app", "CLAUDE.local.md"), join(A, "groups", "CLAUDE.md"), join(A, "tasks", "t1x", "CLAUDE.md")]) {
      for (const tool of ["Write", "Edit", "NotebookEdit"]) denies(file(tool, p, o), "instruction-file-write");
      denies(bash(`echo evil > ${p}`, o), "instruction-file-write");
      denies(bash(`tee -a ${p} <<< evil`, o), "instruction-file-write");
      denies(bash(`sed -i 's/a/b/' ${p}`, o), "instruction-file-write");
    }
    denies(bash(`python3 -c "open('${A}/CLAUDE.md','w').write('x')"`, o), "policy-path-write");
    denies(bash(`cd ${A} && echo evil > CLAUDE.md`, o, { cwd: A }), "instruction-file-write");
    denies(file("Write", join(A, "CLAUDE.md"), { lane: undefined }), "instruction-file-write"); // fail closed when the lane is unknown
    // its own cwd, and ordinary files, stay writable
    passes(file("Write", join(mine[kind], "CLAUDE.md"), o));
    passes(file("Write", join(mine[kind], ".claude", "notes.md"), o));
    passes(file("Write", join(mine[kind], "repo", "CLAUDE.md"), o));
    passes(file("Write", join(A, "tasks", "other", "notes.md"), o));
    passes(bash(`echo ok > ${join(mine[kind], "out.txt")}`, o));
  }
  passes(file("Write", join(A, "CLAUDE.md"), { lane: "chat" })); // the chat lane is not guarded here; the pre-turn reset removes the file
});
