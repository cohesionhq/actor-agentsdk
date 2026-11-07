---
name: change-client-behaviour
description: Recipe for adding a feature or fixing a bug in how actor-agentsdk runs Claude Code actor sessions — tool display, permission/question/plan requests, statuses, titles, images, usage, modes and models, resume. Use when a task asks to change what Cohesion shows or does for a Claude Code task, or reports something wrong in that, to find where the change goes and what has to change with it.
---

# Changing the client's behaviour

Read `ARCHITECTURE.md` for the map. Then:

## 1. Decide where it goes

| The change is about… | Goes in | Tested in |
| --- | --- | --- |
| How a tool use reads: name, icon category, one-line summary, progress verb | `src/translate.ts`: `displayName`, `CATEGORIES`, `summary`, `progress` | `test/translate.test.ts` |
| A permission, question or plan request, or what the user's answer tells Claude Code | `translate.ts` `request` / `subject` / `result`; waiting in `ActorSession.prompt` / `hear` | `translate.test.ts`, `task.test.ts` (`prompt`) |
| Reacting to an SDK message (status, tool ends, images, context, title) | `ActorSession.handle` in `src/session.ts` | `test/session.test.ts`, `test/title.test.ts` via `test/fake_session.ts` |
| Session options (mode, model, effort, resume, settings sources) | `ActorSession.open` | rarely testable; say so in the report |
| A cohesiond call, picking up an actor session, reconnect resync | `Host` in `src/host.ts` | through `ActorSession` where possible |
| Modes or models offered | `src/offers.ts` (`MODES`, `newestModels`) | `test/offers.test.ts` |
| Context or plan usage | `src/usage.ts` | `test/usage.test.ts` |
| Images either way | `src/images.ts` | `test/images.test.ts` |
| What survives a restart | `SessionRecord` in `src/session_store.ts` (add optional fields; old `sessions.json` files must still load) | |

Look at how a neighbour does it before adding anything. Most changes are a
new case in an existing function, not a new module.

## 2. Keep to the protocol's rules

- Statuses follow `docs/actors.md` "Statuses" in `../cohesion`: `idle` at
  the end of every turn, `failed` only when Claude Code itself failed, and
  never a status cohesiond sets itself (a new or stopped session's).
- Allow-for-session adds rules for the session only; never write
  permission rules or anything else to a settings file.
- Usage never fails an actor session; whatever Claude Code can't say is left out.
- Wire fields are snake_case and enum values camelCase, as cohesion-ts types
  them; use its types (`ActorSaidContent`, `ActorSessionReport`, …), not your own.

## 3. If the protocol itself must change

If cohesion-ts has no field or kind for what you need, the change isn't
this repo's alone. The order is: cohesion (the Rust frames in
`cohesion-core`, `docs/actors.md`), then cohesion-ts (`bun run generate`
for `src/generated.ts`; `src/frames.ts` by hand), then here after
`bun install`. Each repo has its own CLAUDE.md and checks. Do it only if
the task asks for protocol work; otherwise build what the current protocol
allows and list the gap under **Caveats**.

## 4. Finish

- Add a test for the rule a regression would quietly break (see `verify`).
- Update the matching `README.md` bullet: it documents each behaviour
  ("Tool categories", "Requests", "Title", …) in the same precise voice.
- Then `finish-task`. The change reaches real actor sessions only when the live
  client restarts (`live-client`), so put concrete steps under
  **Try by hand**.
