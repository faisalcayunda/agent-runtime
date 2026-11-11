// Pre-turn policy reset (PLAN 2.7): files under ~/.claude that a hijacked turn could plant are compared with
// root-owned copies and mirrored back, deleting extras. agent-memory/, projects/ and wiki/ are never touched.
// Used by the runner before every turn; worker-boot.sh does the same at boot.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Stable digest of a file or tree (names, file bytes, symlink targets). Missing path = digest of "absent".
export function treeHash(p) {
  const h = createHash("sha256");
  const walk = (path, rel) => {
    let st;
    try { st = lstatSync(path); } catch { return; }
    if (st.isSymbolicLink()) h.update(`L ${rel} ${readlinkSync(path)}\n`);
    else if (st.isDirectory()) { h.update(`D ${rel}\n`); for (const n of readdirSync(path).sort()) walk(join(path, n), `${rel}/${n}`); }
    else h.update(`F ${rel} ${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
  };
  walk(p, "");
  return h.digest("hex");
}

function mirror(src, dst, isFile) {
  rmSync(dst, { recursive: true, force: true });
  if (src) cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  else if (!isFile) mkdirSync(dst, { recursive: true });
}

// assets: {skills, agents, claudeMd}: root-owned source paths (a missing source means "expected empty / absent").
// Returns the list of things it restored.
export function resetPolicy({ home, assets }) {
  const claude = join(home, ".claude");
  mkdirSync(claude, { recursive: true });
  const changed = [];
  const want = [
    ["skills", assets.skills, false], ["agents", assets.agents, false], ["commands", null, false], ["rules", null, false],
    ["CLAUDE.md", assets.claudeMd, true],
  ];
  for (const [name, src, isFile] of want) {
    const dst = join(claude, name);
    const haveSrc = !!src && existsSync(src);
    const ok = haveSrc ? treeHash(dst) === treeHash(src) : isFile ? !lstatOk(dst) : isEmptyDir(dst);
    if (!ok) { mirror(haveSrc ? src : null, dst, isFile); changed.push(name); }
  }
  // settings.json must be exactly {}
  const sj = join(claude, "settings.json");
  let ok = false;
  try { ok = JSON.stringify(JSON.parse(readFileSync(sj, "utf8"))) === "{}"; } catch { /* missing or invalid */ }
  if (!ok) { rmSync(sj, { force: true }); writeFileSync(sj, "{}\n"); changed.push("settings.json"); }
  // ~/.claude.json: drop an injected mcpServers key (--strict-mcp-config already ignores it)
  const cj = join(home, ".claude.json");
  try {
    const o = JSON.parse(readFileSync(cj, "utf8"));
    if (o && typeof o === "object" && "mcpServers" in o) { delete o.mcpServers; writeFileSync(cj, JSON.stringify(o)); changed.push(".claude.json:mcpServers"); }
  } catch { /* absent or unreadable: nothing to restore */ }
  return changed;
}

function lstatOk(p) { try { lstatSync(p); return true; } catch { return false; } }
function isEmptyDir(p) { try { return lstatSync(p).isDirectory() && readdirSync(p).length === 0; } catch { return false; } }

// CLI for worker-boot.sh: node reset.mjs <home> <skillsDir> <agentsDir> <claudeMd>. Prints what it restored.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [home, skills, agents, claudeMd] = process.argv.slice(2);
  if (!home || !skills || !agents || !claudeMd) { process.stderr.write("usage: reset.mjs <home> <skillsDir> <agentsDir> <claudeMd>\n"); process.exit(2); }
  const changed = resetPolicy({ home, assets: { skills, agents, claudeMd } });
  process.stdout.write(changed.length ? `restored: ${changed.join(", ")}\n` : "policy files already match\n");
}
