# Gremio worker rules (appended to the Karpathy guidelines at build time, PLAN 2.8)

These replace the "Push your work" block of the Multica pods: here a task always ends on a branch with a PR, and nothing is merged without Lord Faisal's "ok".

## Multica ops (CLI only, owner login)
**Handing work to Dunan (owner rule 2026-11-12): you only pass the request on, you never do the work.** When Lord Faisal says "sampaikan ke Riou", "serahkan ke Dunan" or similar, create exactly one issue and stop: `multica issue create --project 70115085-2c80-4f28-9d17-1690d620d520 --assignee-id 20b5b37d-7381-4985-8d96-20e048ec9b63 --status todo --title "<short title>" --description "<his request verbatim, the quoted context, links he gave, and what he wants (for example: assess and grill by Shu)>"` (project Dunan Delivery, assignee Riou; `--status todo` starts Riou's intake). Do not research the repo, do not plan, do not look through other issues. Then reply with the issue identifier in one line and call `track_issue` with it. Riou sizes and routes it; the poller wakes you when Riou or his agents comment.

Allowed: `multica issue create|get|list|status|update|assign|children|comment add|comment list`, `multica project get|list`.
- Every comment: `multica issue comment add <issue> --content "[gremio] ..."`. The body must be inline: the guard cannot check `--content-file` or `--content-stdin`.
- A child issue for Riou or Jude: `multica issue create --parent <task issue> --project <Gremio project> --assignee <name> --status todo --title ...`. For Jude add `--property work_type=design`. Then call `track_issue` with the new id.
- Structure you may run (your own member account, so Multica's permissions apply too): `multica project create|update`, `multica agent create|update`, `multica agent skills list`, `multica workflow create|get|list`, `multica workspace list|switch`, plus every read verb (`list`, `get`, ...).
- Never run: any `delete`, `archive` or `remove` on any noun; `multica workspace` writes (settings, members, invite); `multica skill` writes; `multica autopilot`, `runtime`, `squad` writes; `multica agent skills set|add` (it rewrites another agent's prompt); `multica issue delete`; anything not listed above.
- In another workspace, run `multica workspace switch <id>` first and switch back to Dunan after.
- `multica agent create` only works on a runtime your account owns; the existing runtimes (rt-home, rt-instabox) belong to Lord Faisal, so creating an agent there returns 403 even as workspace admin. Then write the agent's full instructions, model and runtime for Lord Faisal and let him create it. An empty `agent list`/`project list` in a new workspace just means it is empty.

## Wiki pages
Pages go under `~/.claude/wiki/` as plain files: YAML frontmatter with `title`, `type`, `aliases` (include Indonesian aliases), `status: draft` and `org: dunan`; no edits to navigation pages. Capture only what is page-worthy: hard-won facts, decisions with rationale, gotchas, how-tos. Nothing is pushed by you: `notify_owner` done and the runner run `wiki-sync.sh`.
