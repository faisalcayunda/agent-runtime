// worker-boot.sh tests (PLAN 2.8): run under /bin/bash (3.2 on macOS) with a scrubbed env (`env -i`), a throwaway
// HOME, stub runner and poller under a throwaway asset root, and fake `multica` and `git` on PATH. Nothing touches
// the real ~/.claude, the network or a Multica server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, fakeBin, sandbox, sleep, waitFor } from "../testlib/helpers.mjs";

const BOOT = join(ROOT, "bin", "worker-boot.sh");
const NODE_DIR = dirname(process.execPath);

function setup() {
  const S = sandbox();
  const agent = join(S.dir, "agent"), assets = join(S.dir, "assets"), out = join(S.dir, "out");
  for (const d of [join(agent, "src"), join(agent, "config"), join(assets, "skills", "good"), join(assets, "agents"), out]) mkdirSync(d, { recursive: true });
  copyFileSync(join(ROOT, "src", "reset.mjs"), join(agent, "src", "reset.mjs")); // the real reset code, boot calls it
  writeFileSync(join(agent, "config", "CLAUDE.md"), "wa rules\n");
  writeFileSync(join(assets, "skills", "good", "SKILL.md"), "good");
  writeFileSync(join(assets, "agents", "code-reviewer.md"), "agent");
  // stubs: the runner and poller dump their environment, nothing else
  const dump = (who) => `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(out, who + ".env"))}, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));\n${who === "poller" ? "setInterval(() => {}, 1000);" : ""}`;
  writeFileSync(join(agent, "src", "runner.mjs"), dump("runner"));
  writeFileSync(join(agent, "src", "poller.mjs"), dump("poller"));
  fakeBin(S.bin, "multica", `echo "multica $*" >> ${out}/net.log`);
  fakeBin(S.bin, "git", `echo "git $*" >> ${out}/net.log`);
  fakeBin(S.bin, "curl", `echo "curl $*" >> ${out}/net.log`);
  const base = { WA_MAIN_MODEL: "role-exec", MULTICA_TOKEN: "mtok-SECRET", GH_TOKEN: "ghp_test", GIT_USER_NAME: "Gremio", GIT_USER_EMAIL: "g@example.invalid", WA_ROUTER_KEY: "rk-test" };
  const run = (extra = {}, args = []) => spawnSync("/bin/bash", [BOOT, ...args], {
    env: Object.fromEntries(Object.entries({ HOME: S.home, PATH: `${S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: agent, WA_ASSETS_DIR: assets, ...base, ...extra }).filter(([, v]) => v !== undefined)),
    encoding: "utf8", timeout: 20000,
  });
  const net = () => (existsSync(join(out, "net.log")) ? readFileSync(join(out, "net.log"), "utf8") : "");
  const dumped = (who) => JSON.parse(readFileSync(join(out, who + ".env"), "utf8"));
  return { S, agent, assets, out, base, run, net, dumped };
}
const dropKey = (o, k) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));

test("worker-boot.sh parses under bash -n", () => {
  const r = spawnSync("/bin/bash", ["-n", BOOT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("worker-boot.sh aborts on an empty or fable model before any network call", () => {
  const B = setup();
  for (const model of ["", "fable", "claude-Fable-5", "FABLE"]) {
    const r = B.run({ WA_MAIN_MODEL: model });
    assert.notEqual(r.status, 0, `model ${JSON.stringify(model)} should abort`);
    assert.match(r.stderr, /WA_MAIN_MODEL/);
  }
  const r = B.run({ WA_MAIN_MODEL: undefined });
  assert.notEqual(r.status, 0);
  assert.equal(B.net(), ""); // no multica, git or curl call happened: validation comes first
  assert.ok(!existsSync(join(B.S.home, ".claude", "settings.json"))); // and no local file was written either
});

test("worker-boot.sh validates every variable and the other model pins before any network call", () => {
  const B = setup();
  for (const k of ["MULTICA_TOKEN", "GH_TOKEN", "GIT_USER_NAME", "GIT_USER_EMAIL", "WA_ROUTER_KEY"]) {
    const env = { ...B.base }; delete env[k];
    const r = spawnSync("/bin/bash", [BOOT], { env: { HOME: B.S.home, PATH: `${B.S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: B.agent, WA_ASSETS_DIR: B.assets, ...env }, encoding: "utf8" });
    assert.notEqual(r.status, 0, `${k} missing should abort`);
    assert.match(r.stderr, new RegExp(k));
  }
  assert.notEqual(B.run({ WA_OPUS_MODEL: "claude-fable-5" }).status, 0);
  assert.notEqual(B.run({ WA_D1_ROUTE: "bogus" }).status, 0);
  assert.notEqual(B.run({ WA_D1_ROUTE: "direct" }).status, 0); // direct needs ANTHROPIC_API_KEY
  assert.equal(B.net(), "");
});

test("worker-boot.sh unsets MULTICA_TOKEN after login and exports the 9router route (no OpenAI or DeepSeek exports)", async () => {
  const B = setup();
  mkdirSync(join(B.S.home, ".claude", "skills", "evil"), { recursive: true });
  writeFileSync(join(B.S.home, ".claude", "skills", "evil", "SKILL.md"), "planted");
  // detached so the poller restart loop (a background child of the shell) can be killed with the whole group
  const child = spawn("/bin/bash", [BOOT], { detached: true, stdio: "ignore", env: { HOME: B.S.home, PATH: `${B.S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: B.agent, WA_ASSETS_DIR: B.assets, ...B.base, ANTHROPIC_API_KEY: "sk-leftover" } });
  try {
    const ready = (who) => { try { B.dumped(who); return true; } catch { return false; } }; // the stub may still be mid-write
    await waitFor(() => ready("runner") && ready("poller"), 15000);
    await sleep(100);
    assert.match(B.net(), /multica login --token mtok-SECRET/);
    assert.match(B.net(), /clone --depth 1 https:\/\/github.com\/faisalcayunda\/claude-wiki.git /);
    assert.ok(!/mtok-SECRET|ghp_test/.test(B.net().replace("multica login --token mtok-SECRET", ""))); // the token appears only in the login call
    for (const who of ["runner", "poller"]) {
      const { env } = B.dumped(who);
      assert.equal(env.MULTICA_TOKEN, undefined, `${who} inherited MULTICA_TOKEN`);
      assert.equal(env.ANTHROPIC_BASE_URL, "http://ninerouter.ai.svc.cluster.local");
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, "rk-test");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.deepEqual([env.ANTHROPIC_MODEL, env.WA_MAIN_MODEL], ["role-exec", "role-exec"]);
      assert.deepEqual([env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ["role-exec", "role-architect", "role-exec"]);
      assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    }
    const { env } = B.dumped("runner");
    assert.equal(env.GH_TOKEN, "ghp_test");
    // local files written by the boot
    assert.equal(readFileSync(join(B.S.home, ".claude", "settings.json"), "utf8").trim(), "{}");
    assert.equal(readFileSync(join(B.S.home, ".claude", "CLAUDE.md"), "utf8"), "wa rules\n");
    assert.deepEqual(readdirSync(join(B.S.home, ".claude", "skills")), ["good"]); // the planted skill is gone
    assert.deepEqual(readdirSync(join(B.S.home, ".claude", "agents")), ["code-reviewer.md"]);
    assert.deepEqual([readdirSync(join(B.S.home, ".claude", "commands")), readdirSync(join(B.S.home, ".claude", "rules"))], [[], []]);
    assert.ok(existsSync(join(B.S.home, ".claude", "agent-memory")));
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
});

test("worker-boot.sh direct route exports only ANTHROPIC_API_KEY", async () => {
  const B = setup();
  const child = spawn("/bin/bash", [BOOT], { detached: true, stdio: "ignore", env: { HOME: B.S.home, PATH: `${B.S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: B.agent, WA_ASSETS_DIR: B.assets, ...dropKey(B.base, "WA_ROUTER_KEY"), WA_D1_ROUTE: "direct", ANTHROPIC_API_KEY: "sk-direct", ANTHROPIC_AUTH_TOKEN: "stale", ANTHROPIC_BASE_URL: "http://stale", WA_MAIN_MODEL: "claude-sonnet-4-5" } });
  try {
    const ready = () => { try { B.dumped("runner"); return true; } catch { return false; } };
    await waitFor(ready, 15000);
    const { env } = B.dumped("runner");
    assert.deepEqual([env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_BASE_URL], ["sk-direct", undefined, undefined]);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-sonnet-4-5");
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
});

test("WA_SELFTEST=1 skips the Multica login, the wiki clone and the poller, and execs the given command", () => {
  const B = setup();
  const noToken = { ...B.base }; delete noToken.MULTICA_TOKEN; // not required under selftest
  const r = spawnSync("/bin/bash", [BOOT, "/usr/bin/printenv", "ANTHROPIC_MODEL"], { env: { HOME: B.S.home, PATH: `${B.S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: B.agent, WA_ASSETS_DIR: B.assets, ...noToken, WA_SELFTEST: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "role-exec");
  assert.ok(!/login|clone/.test(B.net()), B.net());
  assert.ok(!existsSync(join(B.out, "runner.env")) && !existsSync(join(B.out, "poller.env")));
  assert.equal(readFileSync(join(B.S.home, ".claude", "settings.json"), "utf8").trim(), "{}"); // the local contract still ran
  // but a fable model still aborts under selftest
  assert.notEqual(spawnSync("/bin/bash", [BOOT], { env: { HOME: B.S.home, PATH: `${B.S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: B.agent, WA_ASSETS_DIR: B.assets, ...noToken, WA_SELFTEST: "1", WA_MAIN_MODEL: "fable" }, encoding: "utf8" }).status, 0);
});

test("worker-boot.sh writes the antislop mode file so the skill does not ask in a headless turn", () => {
  const B = setup();
  const file = join(B.S.home, ".config", "antislop", "settings.json");
  mkdirSync(join(B.S.home, ".config", "antislop"), { recursive: true });
  writeFileSync(file, '{"mode":"ask"}\n'); // a stale or planted value is replaced
  const noToken = { ...B.base }; delete noToken.MULTICA_TOKEN;
  const r = spawnSync("/bin/bash", [BOOT, "/usr/bin/true"], { env: { HOME: B.S.home, PATH: `${B.S.bin}:/usr/bin:/bin:${NODE_DIR}`, WA_AGENT_DIR: B.agent, WA_ASSETS_DIR: B.assets, ...noToken, WA_SELFTEST: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mode: "during" }); // same value entrypoint.sh writes for the Multica pods
  assert.ok(!readdirSync(join(B.S.home, ".config", "antislop")).some((f) => f.endsWith(".tmp")));
});
