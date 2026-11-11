// Grants (PLAN 2.12): written by the bridge from the owner's raw text only, read by hooks/guard.mjs.
// /xchg/grants/<id>.json = {id, kind: merge|push-main|approval, url | task_id + branch | code, created_at}, 24 h.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeWrite } from "./state.mjs";

export const GRANT_TTL_MS = 24 * 3600 * 1000;
export const CODE_PATTERN = "[a-z0-9]{3,8}-[0-9]{3,6}"; // same shape the guard and notify_owner enforce

const APPROVAL = new RegExp(`^\\s*(done|deny)\\s+(${CODE_PATTERN})\\s*$`, "i");
export const parseApproval = (text) => { const m = APPROVAL.exec(text); return m ? { verb: m[1].toLowerCase(), code: m[2].toLowerCase() } : null; };

export const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export const isMergeYes = (answer) => /^\s*(ok|merge)\s*[.!]?\s*$/i.test(answer);

// An explicit order to push straight to main, master or dev (Q16). A negation ("jangan push ke main") never matches.
const NEGATION = /\b(jangan|jgn|gak\s+usah|ga\s+usah|nggak|tidak|tanpa|don'?t|do\s+not|never|without)\b[^\n.!?]{0,40}\b(push|commit|merge)\b/i;
const PUSH_A = /\bpush\b[^\n.!?]{0,40}?\b(?:ke|to|into)\s+(?:branch\s+)?(main|master|dev)\b/i;
const PUSH_B = /\b(?:langsung|directly|straight)\b[^\n.!?]{0,30}?\b(?:ke|to|into)\s+(?:branch\s+)?(main|master|dev)\b/i;
export function pushMainOrder(text) {
  if (NEGATION.test(text)) return null;
  const m = PUSH_A.exec(text) ?? PUSH_B.exec(text);
  return m ? m[1].toLowerCase() : null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function writeGrant(xchg, kind, fields, now = Date.now()) {
  const id = randomUUID();
  const g = { id, kind, ...fields, created_at: now };
  safeWrite(join(xchg, "grants", `${id}.json`), JSON.stringify(g), 0o644);
  return g;
}

export function deleteGrant(xchg, id) {
  if (!ID_RE.test(String(id))) return false;
  try { unlinkSync(join(xchg, "grants", `${id}.json`)); return true; } catch { return false; }
}

// Deletes expired grants. Returns the ids it removed.
export function sweepGrants(xchg, now = Date.now()) {
  const gone = [];
  let files = [];
  try { files = readdirSync(join(xchg, "grants")).filter((f) => f.endsWith(".json")); } catch { return gone; }
  for (const f of files) {
    let g = null;
    try { g = JSON.parse(readFileSync(join(xchg, "grants", f), "utf8")); } catch { /* unreadable: treat as expired */ }
    const created = Number(g?.created_at ?? 0);
    if (!g || !(created + GRANT_TTL_MS > now)) { try { unlinkSync(join(xchg, "grants", f)); gone.push(f.replace(/\.json$/, "")); } catch { /* gone */ } }
  }
  return gone;
}
