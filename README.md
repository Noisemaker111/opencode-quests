# opencode-quests

Quests for OpenCode 2 — an explicit durable work ledger with deliverables, acceptance criteria, lifecycle controls and many exact sessions per Quest.

## What it does

A Quest is one explicitly created unit of work, tracked to completion. It replaces todo lists:

- **Backlog** is a Quest nobody has picked up.
- **In progress** is a Quest with sessions attached — several sessions and
  several subagents can work the same Quest.
- **Done** is an archived Quest.

Each Quest carries a title, a full objective, **deliverables** (the to-dos),
**acceptance criteria** (`take a screenshot after`, `tests must pass`),
a blast radius, file claims, and the evidence gathered so far. Other sessions
can read the board to see what is being worked on and what it touches.

Ordinary messages and unbound Tasks create no Quests. Create one through the
Quest tool with its objective, deliverables and acceptance criteria attached;
then bind as many real sessions or subagents as the work needs.

## UI

Chrome mounts on `prompt.footer` (a live clickable `N Quests` count) and
on `sidebar.content` (exact per-session rows beside Subagents). `/quests`
and the count open a searchable selector; details can start and navigate real
sessions or accept, complete, archive, abandon, reopen and delete a Quest.

## Storage

One Markdown file per Quest under `.opencode/quests/`, with the state in
YAML frontmatter and an append-only event journal beside it. Files are the
source of truth; the journal reconciles concurrent writers.

## Requires

- `opencode-orchestration` — imported, not vendored. Install it alongside.

## License

MIT
