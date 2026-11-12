// Ids that arrive from another process (the runner, a tool) and then become keys or file names. One rule everywhere:
// 1 to 64 of letters, digits, _ and -, never a name that is special on an object.
import { resolve, sep } from "node:path";

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
export const validId = (x) => typeof x === "string" && ID_RE.test(x) && !RESERVED.has(x);
// A WhatsApp group gets a lane id derived from its JID: grp_<digits[-digits]>. Task ids may not use the prefix, so a task can
// never be named like a lane whose output goes to a group.
export const GROUP_PREFIX = "grp_";
export const groupLaneId = (jid) => { const m = /^(\d{5,30}(?:-\d{1,20})?)@g\.us$/.exec(String(jid ?? "")); return m ? GROUP_PREFIX + m[1] : null; };
export const isGroupLane = (id) => typeof id === "string" && id.startsWith(GROUP_PREFIX) && validId(id);
export const FILE_RE = /^[A-Za-z0-9_][\w.-]{0,98}\.json$/; // an event file name from the runner: no path, no leading dot
export const validFile = (x) => typeof x === "string" && FILE_RE.test(x) && !x.includes("..");

// dir + name, refusing anything that resolves outside dir.
export function inside(dir, name) {
  const p = resolve(dir, name), d = resolve(dir);
  if (!p.startsWith(d + sep)) throw new Error(`path escapes ${d}: ${name}`);
  return p;
}
