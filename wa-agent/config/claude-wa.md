# Gremio worker rules (appended to the Karpathy guidelines at build time, PLAN 2.8)

These replace the "Push your work" block of the Multica pods: here a task always ends on a branch with a PR, and nothing is merged without Lord Faisal's "ok".

## Multica ops (CLI only, your own account)
**Handing work to Dunan (owner rule 2026-11-12): you only pass the request on, you never do the work.** When Lord Faisal says "sampaikan ke Riou", "serahkan ke Dunan" or similar, create exactly one issue and stop: `multica issue create --project 70115085-2c80-4f28-9d17-1690d620d520 --assignee-id 20b5b37d-7381-4985-8d96-20e048ec9b63 --status todo --title "<short title>" --description "<his request verbatim, the quoted context, links he gave, and what he wants (for example: assess and grill by Shu)>"` (project Dunan Delivery, assignee Riou; `--status todo` starts Riou's intake). Do not research the repo, do not plan, do not look through other issues. Then reply with the issue identifier in one line and call `track_issue` with it. Riou sizes and routes it; the poller wakes you when Riou or his agents comment.

Full access (owner decision 2026-11-12): you run the `multica` CLI under your own account, every noun and verb, and the guard no longer filters it; Multica's own permissions are the only limit. Comments are yours by account, so they need no prefix: `multica issue comment add <issue> --content "..."`, and the body may come from `--content-file` or `--content-stdin`.
- A child issue for Riou or Jude: `multica issue create --parent <task issue> --project <Gremio project> --assignee <name> --status todo --title ...`. For Jude add `--property work_type=design`. Then call `track_issue` with the new id.
- In another workspace, run `multica workspace switch <id>` first and switch back to Dunan after.
- An agent you create uses your own runtime: find it with `multica runtime list` (name `rt-gremio` once deployed) and pass its id. Never rt-home or rt-instabox: they belong to Lord Faisal, and an agent made there runs on his machines under his account. An empty `agent list`/`project list` in a new workspace just means it is empty.

## Wiki pages
Pages go under `~/.claude/wiki/` as plain files: YAML frontmatter with `title`, `type`, `aliases` (include Indonesian aliases), `status: draft` and `org: dunan`; no edits to navigation pages. Capture only what is page-worthy: hard-won facts, decisions with rationale, gotchas, how-tos. Nothing is pushed by you: `notify_owner` done and the runner run `wiki-sync.sh`.
