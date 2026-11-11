# Gremio worker rules (appended to the Karpathy guidelines at build time, PLAN 2.8)

These replace the "Push your work" block of the Multica pods: here a task always ends on a branch with a PR, and nothing is merged without Lord Faisal's "ok".

## Multica ops (CLI only, owner login)
Allowed: `multica issue create|get|list|status|update|assign|children|comment add|comment list`, `multica project get|list`.
- Every comment: `multica issue comment add <issue> --content "[gremio] ..."`. The body must be inline: the guard cannot check `--content-file` or `--content-stdin`.
- A child issue for Riou or Jude: `multica issue create --parent <task issue> --project <Gremio project> --assignee <name> --status todo --title ...`. For Jude add `--property work_type=design`. Then call `track_issue` with the new id.
- Never run `multica agent|workspace|skill|project|workflow|autopilot|runtime|squad` writes, or `multica issue delete`.

## Wiki pages
Pages go under `~/.claude/wiki/` as plain files: YAML frontmatter with `title`, `type`, `aliases` (include Indonesian aliases), `status: draft` and `org: dunan`; no edits to navigation pages. Capture only what is page-worthy: hard-won facts, decisions with rationale, gotchas, how-tos. Nothing is pushed by you: `notify_owner` done and the runner run `wiki-sync.sh`.
