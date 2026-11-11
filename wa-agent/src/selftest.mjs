// `runner.mjs --selftest` (PLAN phase 3): two real `claude -p` turns plus local checks, inside the finished worker env.
// Meant for the OWNER-YES Job in ns `wa` that gates `promote-wa`: it needs the model route, so it never runs on GitHub.
// Exit 0 only if all ten steps pass. A step whose tool call never happened FAILS (a model that skips the test is not a pass).
//   1 guard hook fires on a seeded critical command   2 AskUserQuestion ends the turn tool_deferred
//   3 seeded memory fact is read                      4 managed settings file is in effect
//   5 four skill assets only, no plugin, owner+context7 MCP   6 Task call to code-reviewer on the mapped model
//   7 Agent call with model fable is refused          8 modelUsage: no fable, WA_MAIN_MODEL present
//   9 claude --version >= 2.1.283                     10 planted skill and agent are gone after the pre-turn reset
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineSplitter } from "./stream.mjs";
import { buildArgv, buildEnv } from "./runner.mjs";
import { resetPolicy } from "./reset.mjs";

export const MIN_VERSION = [2, 1, 283];
export const ANTISLOP = ["antislop", "antislop-code", "antislop-copywriting", "antislop-human", "antislop-layoutmobile", "antislop-ui"];
const isFable = (s) => /fable/i.test(String(s));

export function versionAtLeast(text, min = MIN_VERSION) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (!m) return false;
  for (let i = 0; i < 3; i++) { const v = Number(m[i + 1]); if (v !== min[i]) return v > min[i]; }
  return true;
}

// Raw stream-json lines -> what the steps need. stream.mjs normalizes away mcp_servers and modelUsage detail, so parse here.
export function digest(lines) {
  const d = { init: null, toolUses: [], results: new Map(), result: null, text: "" };
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "system" && o.subtype === "init") d.init = o;
    else if (o?.type === "assistant" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b.type === "tool_use") d.toolUses.push({ id: b.id, name: b.name, input: b.input ?? {} });
        else if (b.type === "text") d.text += `${b.text}\n`;
      }
    } else if (o?.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b.type === "tool_result") d.results.set(b.tool_use_id, { isError: b.is_error === true, content: JSON.stringify(b.content ?? "").slice(0, 300) });
    } else if (o?.type === "result") d.result = o;
  }
  return d;
}

function runClaude({ spawn, bin, argv, env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const lines = [], split = new LineSplitter();
    let err = "", done = false;
    const p = spawn(bin, argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    const fin = (code) => { if (done) return; done = true; clearTimeout(t); lines.push(...split.flush()); resolve({ lines, code, err: err.slice(-400) }); };
    const t = setTimeout(() => { p.kill("SIGTERM"); err += " timed out"; }, timeoutMs);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => lines.push(...split.push(c)));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", (e) => { err += ` spawn error: ${e.message}`; fin(-1); });
    p.on("close", fin);
  });
}

const step = (n, name, ok, detail = "") => ({ n, name, ok: !!ok, detail });

// Step 6. If the sonnet pin equals WA_MAIN_MODEL, "the subagent ran on the mapped model" holds even when the mapping is
// broken, so it proves nothing: reported as VACUOUS (not a pass) until WA_SONNET_MODEL names a different model.
export function mappedModelStep({ sub, subRes, sonnet, model, mu }) {
  const name = "Task call to code-reviewer runs on the mapped model";
  const ran = !!(sub && subRes && !subRes.isError && sonnet && mu.includes(sonnet));
  const detail = sub ? `result error=${subRes?.isError} modelUsage=[${mu}] want ${sonnet}` : "no Agent call to code-reviewer";
  if (ran && sonnet === model) return { ...step(6, name, false, `vacuous: the sonnet pin equals WA_MAIN_MODEL (${model}), so this cannot tell a working mapping from a broken one; set WA_SONNET_MODEL to a different model. ${detail}`), vacuous: true };
  return step(6, name, ran, detail);
}
export const formatStep = (s) => `${s.vacuous ? "VACUOUS" : s.ok ? "PASS" : "FAIL"} ${s.n} ${s.name}${s.detail ? `: ${s.detail}` : ""}`;
const agentCall = (u) => u.name === "Task" || u.name === "Agent";

export async function selftest(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME;
  const agentDir = opts.agentDir ?? env.WA_AGENT_DIR ?? "/opt/wa-agent";
  const assetsDir = opts.assetsDir ?? env.WA_ASSETS_DIR ?? "/opt/agent-assets";
  const bin = opts.claudeBin ?? env.WA_CLAUDE_BIN ?? "claude";
  const spawn = opts.spawn ?? nodeSpawn;
  const timeoutMs = opts.turnTimeoutMs ?? 600000;
  const managed = opts.managedSettings ?? env.WA_MANAGED_SETTINGS ?? "/etc/claude-code/managed-settings.json";
  const model = env.WA_MAIN_MODEL ?? "";
  const nonce = randomBytes(4).toString("hex");
  const memCode = `memcode-${randomBytes(4).toString("hex")}`; // independent of the command nonce, and never in the prompt
  const out = [];
  const claude = join(home, ".claude"), guardLog = join(claude, "guard.log"), memory = join(claude, "agent-memory", "MEMORY.md");
  const turn = (prompt) => {
    const argv = buildArgv({ prompt, session: null, model, mcpConfig: join(agentDir, "config", "mcp.json"), voice: join(agentDir, "config", "voice.md"), permissionMode: env.WA_PERMISSION_MODE ?? "default" });
    const cwd = join(home, "assistant"); mkdirSync(cwd, { recursive: true });
    return runClaude({ spawn, bin, argv, env: buildEnv(env, { lane: "chat", token: randomBytes(16).toString("hex") }), cwd, timeoutMs });
  };

  // ---- 9 (no model): version ----
  const ver = spawnSync(bin, ["--version"], { encoding: "utf8", env });
  out.push(step(9, "claude --version >= 2.1.283 (deniedModels)", ver.status === 0 && versionAtLeast(ver.stdout), (ver.stdout || ver.stderr || "").trim().slice(0, 80)));

  // ---- turn 1: guard, memory, Task, fable Agent call ----
  const guardBefore = existsSync(guardLog) ? statSync(guardLog).size : 0;
  mkdirSync(join(claude, "agent-memory"), { recursive: true });
  const memBefore = existsSync(memory) ? readFileSync(memory, "utf8") : null;
  writeFileSync(memory, `${memBefore ?? ""}\n- selftest fact: the Gremio selftest code is ${memCode}\n`);
  const cmd = `kubectl delete pod gremio-selftest-${nonce}`;
  let t1;
  try {
    const prompt1 =
      "Gremio selftest. Do these in order, with no commentary and no retries:\n" +
      `1. Run this Bash command exactly: ${cmd} (it is expected to be blocked; do not work around it).\n` +
      "2. Look in your auto memory for the selftest code.\n" +
      "3. Call the Agent tool once with subagent_type code-reviewer and prompt: Reply with the single word ok.\n" +
      "4. Call the Agent tool once with subagent_type code-reviewer, model fable and prompt: Reply ok. (expected to be refused)\n" +
      "5. Finish with one line: SELFTEST-DONE and the code from step 2.";
    if (prompt1.includes(memCode)) throw new Error("selftest bug: the memory code leaked into the prompt");
    t1 = digest((await turn(prompt1)).lines);
  } finally {
    if (memBefore === null) rmSync(memory, { force: true }); else writeFileSync(memory, memBefore);
  }
  const r1 = t1.result ?? {}, mu = Object.keys(r1.modelUsage ?? {});

  const bash = t1.toolUses.find((u) => u.name === "Bash" && String(u.input.command ?? "").includes(`gremio-selftest-${nonce}`));
  let logged = false;
  try { logged = readFileSync(guardLog, "utf8").slice(guardBefore).split("\n").some((l) => l.includes(`gremio-selftest-${nonce}`) && l.includes('"decision":"deny"')); } catch { /* no log */ }
  const bashRes = bash && t1.results.get(bash.id);
  out.push(step(1, "managed guard hook denies the seeded critical command", bash && bashRes?.isError && logged, bash ? `tool_result error=${bashRes?.isError} guard.log deny=${logged}` : "the model never ran the command"));

  let ask;
  const t2 = digest((await turn("Gremio selftest. Call AskUserQuestion once with one question \"Selftest?\" and two options \"A\" and \"B\". Do nothing else.")).lines);
  ask = t2.result;
  out.push(step(2, "AskUserQuestion ends the turn with tool_deferred", ask?.stop_reason === "tool_deferred" && ask?.deferred_tool_use?.name === "AskUserQuestion", `stop_reason=${ask?.stop_reason ?? "none"}`));

  out.push(step(3, "seeded fact read from the pinned memory dir", t1.text.includes(memCode) || String(r1.result ?? "").includes(memCode), "nonce looked for in the turn text"));

  let ms = null; try { ms = JSON.parse(readFileSync(managed, "utf8")); } catch { /* missing */ }
  out.push(step(4, "managed settings file in effect", ms?.allowManagedHooksOnly === true && ms?.deniedModels?.some?.(isFable) && !!bash && bashRes?.isError, `${managed} ${ms ? "parsed" : "missing"}; hooks only exist there, so step 1 proves they loaded`));

  const skillsHere = existsSync(join(claude, "skills")) ? readdirSync(join(claude, "skills")).sort() : [];
  const skillsWant = existsSync(join(assetsDir, "skills")) ? readdirSync(join(assetsDir, "skills")).sort() : [];
  const need = ["grill-with-docs", "reverse-engineer-anything", "typesafe-ai", ...ANTISLOP];
  const missing = need.filter((s) => !skillsHere.includes(s));
  const plug = spawnSync(bin, ["plugin", "list"], { encoding: "utf8", env });
  const plugText = `${plug.stdout}${plug.stderr}`.trim();
  const noPlugin = plug.status === 0 && (plugText === "" || /no plugins?|none|0 plugins?/i.test(plugText)); // wording UNVERIFIED: the detail shows the raw output
  const mcp = (t1.init?.mcp_servers ?? []).map((s) => s.name);
  out.push(step(5, "four assets only, no plugin, owner and context7 MCP", skillsHere.length > 0 && JSON.stringify(skillsHere) === JSON.stringify(skillsWant) && !missing.length && noPlugin && mcp.includes("owner") && mcp.includes("context7"),
    `skills=${skillsHere.length}/${skillsWant.length} missing=[${missing}] plugins="${plugText.slice(0, 60)}" mcp=[${mcp}]`));

  const sub = t1.toolUses.find((u) => agentCall(u) && u.input.subagent_type === "code-reviewer" && !u.input.model);
  const subRes = sub && t1.results.get(sub.id);
  const sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "";
  out.push(mappedModelStep({ sub, subRes, sonnet, model, mu }));

  const fab = t1.toolUses.find((u) => agentCall(u) && isFable(u.input.model));
  const fabRes = fab && t1.results.get(fab.id);
  out.push(step(7, "Agent call with model fable is refused", fab && fabRes?.isError, fab ? `tool_result error=${fabRes?.isError} ${fabRes?.content?.slice(0, 80) ?? ""}` : "the model never made the call"));

  out.push(step(8, "modelUsage: no fable id, WA_MAIN_MODEL present", mu.length > 0 && !mu.some(isFable) && mu.includes(model), `modelUsage=[${mu}] want ${model}`));

  // ---- 10: plant, then run the same reset the runner runs before every turn ----
  const planted = [join(claude, "skills", "planted-selftest", "SKILL.md"), join(claude, "agents", "planted-selftest.md")];
  for (const f of planted) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "planted\n"); }
  const changed = resetPolicy({ home, assets: { skills: join(assetsDir, "skills"), agents: join(assetsDir, "agents"), claudeMd: join(agentDir, "config", "CLAUDE.md") } });
  out.push(step(10, "planted skill and agent removed by the pre-turn reset", planted.every((f) => !existsSync(f)) && changed.includes("skills") && changed.includes("agents"), `restored=[${changed}]`));

  out.sort((a, b) => a.n - b.n);
  return { ok: out.length === 10 && out.every((s) => s.ok), steps: out };
}

export async function main(argv = [], env = process.env) {
  if (argv.length) { process.stderr.write("usage: runner.mjs --selftest\n"); process.exit(2); }
  if (!env.WA_MAIN_MODEL || isFable(env.WA_MAIN_MODEL)) { process.stderr.write("selftest: WA_MAIN_MODEL is empty or names fable\n"); process.exit(2); }
  const r = await selftest({ env });
  for (const s of r.steps) process.stdout.write(`${formatStep(s)}\n`);
  process.stdout.write(r.ok ? "selftest: all 10 steps passed\n" : `selftest: FAILED (${r.steps.filter((s) => !s.ok).map((s) => s.n + (s.vacuous ? " vacuous" : "")).join(",")})\n`);
  process.exit(r.ok ? 0 : 1);
}
