# CLAUDE.md

`actor-agentsdk`: a Cohesion actor client that runs Claude Code through
the Claude Agent SDK, on Bun. Read `README.md` first, then `ARCHITECTURE.md`,
then `docs/actors.md` in cohesion (`../cohesion`), which this implements. It
talks to cohesiond only through `cohesion-ts` (`../cohesion-ts`); protocol
work belongs there, not here. What every actor client shares (CLI, config,
call routing, run loop) is `cohesion-agent-kit` (`../cohesion-agent-kit`).

- `index.ts`: `runCli` and `ActorService`. `src/host.ts`: the kit's
  `SessionEngine`, one `ActorSession` per actor session. `src/session.ts`: one Claude Code session per actor session.
  `src/translate.ts`: Claude Code's tools to Cohesion's transcript kinds and
  back. `src/offers.ts`: modes and models offered.
- Follow `docs/actors.md` for every status rule: report `idle` at the end of
  each turn, `failed` only when Claude Code itself failed, and nothing
  cohesiond already sets itself.
- Never write permission rules to settings files on the user's behalf;
  allow-for-session is session-scoped.
- Tests (`bun test`) cover the translation rules a regression would quietly
  break. `bun run check` and `bun test` must pass before a change is done.

## Commits

Commits must NOT include a `Co-Authored-By` (co-author) trailer.

## Working on your own

Skills in `.claude/skills/` hold the how-to: `verify`, `finish-task`,
`report`, `dirty-checkout`, `change-client-behaviour`, `live-client`.

- **Decide, don't ask.** Where a design, naming or copy question is open,
  take the conservative choice that fits `README.md` and the code around
  it, keep going, and list every such choice in the report. Stop only when
  truly blocked, when a step is destructive, or when it needs credentials.
- **Checkout.** Work on master in this checkout, not a worktree, unless
  the work truly needs isolation. Others' uncommitted changes are theirs:
  never stash, revert or commit them; commit only your own files
  (`dirty-checkout`).
- **Done** means the checks pass, docs match (`README.md` for behaviour,
  `ARCHITECTURE.md` for structure), the work is committed and pushed to
  origin master, and you've reported (`finish-task`).
- **Don't deploy.** The live client runs from this checkout as a systemd
  service; restarting it ends every actor session, yours too. Don't restart it, run
  `install.sh`, or touch the real config unless told (`live-client`).
- **Report** briefly: what changed, commits, checks, caveats, choices made
  without asking, and what to try by hand (`report`).
