# Architecture

How this client is put together. What it does is in `README.md`, and the
protocol it implements is `docs/actors.md` in cohesion (`../cohesion`); how
cohesiond holds actors is "Actors" in cohesion's `docs/architecture.md`.

## Shape

One process (`bun index.ts run`) is one paired Cohesion client. It offers
one actor per configured directory, and runs one `ActorSession` per actor session.
Each actor session is one Claude Code session in its actor's directory, driven
through the Agent SDK's `query()`:

```
cohesiond ⇄ cohesion-ts Client ⇄ SessionHost ─┬─ Session 12 ─ query() ─ claude (session a1b2…)
                                              ├─ Session 13 ─ query() ─ claude (session c3d4…)
Usage (plan limits, shared by every actor) ───┘
```

An actor session's process (a *stretch*) exits after ten idle minutes (`LINGER`), and
the next message opens a new one that resumes the session. `sessions.json`
keeps the actor session → session mapping so a restart resumes too.

The parts every actor client shares come from `cohesion-agent-kit`: the CLI
(`runCli`), the run loop and config watch (`ActorService`), call routing
(`SessionHost`), `config.json` and `sessions.json`. This repo is what is
particular to Claude Code, behind the kit's `SessionEngine` and
`SessionRunner`.

## Modules

| File | Role |
| --- | --- |
| `index.ts` | The kit's `runCli`, with `run` building `Usage`, a `SessionHost` and an `ActorService`, and saying what to offer. |
| `src/host.ts` | `claudeCodeEngine`, the kit's `SessionEngine`: the `SessionRecord` for an actor session started or picked up from Cohesion's transcript, the modes (checked against `MODES`), and the `ActorSession` to run it. `SessionHost` answers cohesiond's four calls with it. |
| `src/instructions.ts` | Text appended to Claude Code's system prompt (mermaid diagrams). |
| `src/session.ts` | `SessionRecord`, and `ActorSession`, the kit's `SessionRunner`: one session. `open()` starts a stretch (`query()` with `canUseTool: this.prompt`); `handle()` turns each SDK message into reports (messages, `end`, status, progress, context, title); `prompt` turns permission prompts into requests and waits on the user (`waiting`). |
| `src/translate.ts` | Pure functions between Claude Code's tools and Cohesion's transcript kinds: `toolUse`, `category`/`CATEGORIES`, `displayName`, `progress`, `request` (permission, question, plan), and `result` (the user's response back to a `PermissionResult`). |
| `src/offers.ts` | The modes (`MODES`) and models (`availableModels`, `newestModels`) each actor offers. |
| `src/usage.ts` | Context usage per actor session (`contextOf`, `liveContext`) and the `Usage` class: the plan's limits, pulled and taken from rate-limit events, said for every actor. |
| `src/images.ts` | Image conversion both ways (`imagesIn`, `imageBlocks`); the limits are the kit's `sendable`. |

## Flows

- **In**: cohesiond call → `SessionHost.onCall` → `ActorSession.say` / `ActorSession.hear` → the
  stretch's `Input` queue → Claude Code.
- **Out**: SDK message → `ActorSession.handle` → `translate` → `ActorSession.report` →
  `Client` (cohesion-ts queues reports while offline and resends in order).
- **Requests**: `canUseTool` → `ActorSession.prompt` → `translate.request` reported
  as a message, and the actor session reports `needsAttention` → the user's response
  arrives through `hear` → `translate.result` → Claude Code.
- **Status**: `working` while a turn runs (one Claude Code starts on its own,
  `turn` being `own` as nothing was `told` it, only from its first tool use;
  until then it reports no status at all), `needsAttention` while a request
  waits, `idle` at each successful `result` with no background agent
  running (`background`, from `background_tasks_changed`, filtered by
  `keepsWorking`; otherwise the actor session is `held` working until Claude Code's
  own turn on their results ends, or `RESUME` passes with none), `failed` only when Claude Code
  itself fails (an error `result`, or the SDK throwing in `ActorSession.run`); a
  stopped turn is `idle` without a report, as cohesiond already set it. The tool use of
  a background agent (its `tool_use_result.status` is `async_launched`) isn't ended with that
  result: it moves to `launched` and ends on the `task_notification` for its
  `tool_use_id`, or when the process ends or restarts. Never report what cohesiond sets itself; rules:
  `docs/actors.md` "Statuses".

## Dependencies

- `cohesion-ts` (`file:../cohesion-ts`) owns the protocol: frames, pairing,
  TLS, reconnects. A protocol change starts in cohesion, then cohesion-ts,
  then here.
- `cohesion-agent-kit` (`file:../cohesion-agent-kit`) owns what actor clients
  share, on top of cohesion-ts. What `actor-opencode` needs too belongs
  there, not here.
- Both are copies under `node_modules` (the kit has its own of cohesion-ts),
  so run `bun install` after changing either.
- `@anthropic-ai/claude-agent-sdk` ships the `claude` binary under
  `node_modules`; sessions load user, project and local settings like the
  terminal does.

## Where to look

- A tool shown wrong, or a wrong category: `translate.ts`, `test/translate.test.ts`.
- A status, a tool end, a missing message: `ActorSession.handle` in `session.ts`, `test/session.test.ts`.
- A permission, question or plan flow: `ActorSession.prompt` / `hear`, `translate.request` / `result`.
- Resume and restart behaviour: `SessionHost.hear` in the kit, `claudeCodeEngine` in `host.ts`.
- Usage numbers: `usage.ts`, `test/usage.test.ts`.
