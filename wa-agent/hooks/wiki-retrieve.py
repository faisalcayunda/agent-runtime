#!/usr/bin/env python3
"""UserPromptSubmit hook: inject up to 3 wiki pages that look relevant to the prompt (PLAN 2.10).

Port of the Mac ~/.claude/hooks/wiki_hooks.py `retrieve` command, same parsing, scoring and thresholds. Changes:
- root is $HOME/.claude/wiki (read from the environment, never from the hook input);
- stateless: the index is rebuilt per prompt (about 40 ms for 120 pages) and there is no per-session "already injected"
  list, because a WhatsApp chat session is resumed for days and that list would starve retrieval after the first hits;
- no org-from-cwd boost, no usage log, no SubagentStart/Read hooks, no mcp__wiki__search pointer (the pod has none).
Pages are never filtered by status: a draft is injected with a halved score and labelled `draft` in the output.
Any failure exits 0 silently so a prompt is never blocked. Compatible with Python 3.9+, standard library only.
"""
import json
import os
import re
import sys

WIKI_ROOT = os.path.join(os.environ.get("HOME") or os.path.expanduser("~"), ".claude", "wiki")

MAX_HITS = 3
MIN_SCORE = 6.0
MAX_CONTEXT_CHARS = 6000        # hook output cap is 10,000 chars
MAX_DESC_CHARS = 300

SKIP_DIRS = {".obsidian", ".git", ".trash", "templates", "hubs", "log"}
NAV_PAGES = {"index.md", "log.md", "hot.md", "_index.md"}

# Short acknowledgements never trigger retrieval (list inherited from the retired wave0-enforce hook).
CONTINUATIONS = {
    "ya", "iya", "ok", "oke", "okay", "sip", "siap", "yes", "y", "lanjut", "lanjutkan",
    "teruskan", "gas", "proceed", "go", "next", "no", "ngga", "nggak", "gak", "tidak",
    "batal", "stop", "abort", "noted", "thanks", "thx", "makasih", "ty", "done",
    "setuju", "semua", "mantap", "betul", "benar", "boleh", "silakan", "continue",
}
STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "what", "how", "why", "when",
    "where", "which", "are", "was", "were", "you", "your", "can", "does", "not", "all", "any",
    "please", "check", "wiki", "page", "data", "yang", "dan", "dari", "untuk", "dengan", "ini",
    "itu", "ada", "apa", "bagaimana", "gimana", "kenapa", "saja", "aja", "juga", "sudah",
    "udah", "belum", "bisa", "akan", "atau", "kalau", "kalo", "jadi", "pada", "dalam", "oleh",
    "lagi", "mau", "kamu", "saya", "aku", "nya", "dong", "sih", "deh", "cek", "tolong",
    "mohon", "buat", "bikin", "tahu", "cara", "coba", "terkait", "tentang", "sama",
}
TOKEN_RX = re.compile(r"[a-z0-9_]+")


# ---------------------------------------------------------------- frontmatter
def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def _strip_comment(v):
    v = v.strip()
    if v and v[0] in "\"'":                      # empty string is "in" every string
        end = v.find(v[0], 1)
        return v[: end + 1] if end > 0 else v
    return v.split(" #", 1)[0].strip()


def _split_inline(inner):
    items, buf, quote = [], "", None
    for ch in inner:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            buf += ch
        elif ch == ",":
            items.append(buf)
            buf = ""
        else:
            buf += ch
    if buf.strip():
        items.append(buf)
    return [_unquote(i) for i in items if i.strip()]


def parse_frontmatter(text):
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    data, key = {}, None
    for raw in text[3:end].splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][\w\-]*):\s*(.*)$", raw)
        if m and raw[:1] not in (" ", "\t", "-"):
            key, val = m.group(1), _strip_comment(m.group(2))
            if val == "":
                data[key] = []
            elif val.startswith("[") and val.endswith("]"):
                data[key] = _split_inline(val[1:-1])
            else:
                data[key] = _unquote(val)
        elif key and re.match(r"^\s*-\s+", raw):
            item = _unquote(_strip_comment(re.sub(r"^\s*-\s+", "", raw)))
            if not isinstance(data.get(key), list):
                data[key] = [] if data.get(key) in (None, "") else [data[key]]
            data[key].append(item)
    return data


def _as_list(v):
    if v is None or v == "":
        return []
    return v if isinstance(v, list) else [v]


# ---------------------------------------------------------------- index
def _norm(t):
    return t[:-3] if t.endswith("nya") and len(t) > 6 else t   # Indonesian possessive suffix


def tokens(text):
    out = []
    for t in TOKEN_RX.findall(text.lower()):
        t = _norm(t)
        if len(t) >= 3 and t not in STOPWORDS:
            out.append(t)
    return out


def _hit(token, vocab):
    """Exact match, or containment for tokens of 4+ chars (brew in homebrew, venv in venvs)."""
    if token in vocab:
        return True
    if len(token) < 4:
        return False
    return any(len(v) >= 4 and (token in v or v in token) for v in vocab)


def _page_files(root):
    for dp, dn, fn in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        dn[:] = [d for d in dn if d not in SKIP_DIRS and not d.startswith(".")]
        if rel_dir != "." and rel_dir.split(os.sep)[0] in SKIP_DIRS:
            continue
        for f in fn:
            if f.endswith(".md") and f not in NAV_PAGES:
                yield os.path.join(dp, f)


def build_index(root):
    pages = []
    for path in _page_files(root):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                fm = parse_frontmatter(fh.read(20000))
        except OSError:
            continue
        stem = os.path.splitext(os.path.basename(path))[0]
        pages.append({
            "path": path,
            "title": str(fm.get("title") or stem),
            "aliases": [str(a) for a in _as_list(fm.get("aliases"))],
            "tags": [str(t) for t in _as_list(fm.get("tags"))],
            "org": str(fm.get("org") or ""),
            "status": str(fm.get("status") or ""),
            "type": str(fm.get("type") or ""),
            "description": str(fm.get("description") or "")[:MAX_DESC_CHARS],
        })
    return {"pages": pages}



# ---------------------------------------------------------------- scoring
def is_continuation(prompt):
    low = prompt.strip().lower()
    words = re.findall(r"[a-z]+", low)
    if not words:
        return True
    return low in CONTINUATIONS or (len(words) <= 4 and all(w in CONTINUATIONS for w in words))


def score_page(page, prompt_low, prompt_tokens):
    title_alias = set(tokens(page["title"] + " " + " ".join(page["aliases"])))
    tag_t = set(tokens(" ".join(page["tags"]).replace("/", " ").replace("-", " ")))
    desc_t = set(tokens(page["description"]))
    score, matched, phrase = 0.0, 0, False
    for t in set(prompt_tokens):
        w = 3 if _hit(t, title_alias) else 2 if _hit(t, tag_t) else 1 if _hit(t, desc_t) else 0
        if w:
            score += w
            matched += 1
    for phrase_text in [page["title"]] + page["aliases"]:
        p = phrase_text.strip().lower()
        if len(p) >= 6 and p in prompt_low:
            score += 6
            phrase = True
    if not phrase and matched < 2:
        return 0.0
    if page["status"] == "draft":
        score *= 0.5
    return score


def rank(index, prompt):
    low, toks = prompt.lower(), tokens(prompt)
    scored = []
    for page in index["pages"]:
        s = score_page(page, low, toks)
        if s >= MIN_SCORE:
            scored.append((s, page))
    scored.sort(key=lambda x: (-x[0], x[1]["title"]))
    return scored[:MAX_HITS]


def render(hits):
    lines = ["Wiki pages that may be relevant (read the file before relying on it; status draft means "
             "not yet reviewed):"]
    for _, p in hits:
        meta = ", ".join(x for x in (p["type"], p["org"], p["status"]) if x)
        lines.append("- %s [%s]: %s" % (p["title"], meta, p["path"]))
        if p["description"]:
            lines.append("  " + p["description"])
    return "\n".join(lines)[:MAX_CONTEXT_CHARS]


def main():
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt") or ""
    if is_continuation(prompt):
        return
    hits = rank(build_index(WIKI_ROOT), prompt)
    if hits:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": render(hits)}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
