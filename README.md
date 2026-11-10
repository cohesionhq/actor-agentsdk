# actor-agentsdk

Offers Agent SDK to Cohesion as actors, one per directory, and runs the
actor sessions Cohesion hands them through the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
Each actor session is one Claude Code session in its directory: what the user says in
Cohesion goes in as the session's input, and Claude Code's words, tool uses,
questions, permission prompts and plans come back as the actor session's transcript,
with its status and progress. See `docs/actors.md` in cohesion for the
protocol; this client speaks it through [cohesion-ts](https://github.com/cohesionhq/ts), and
its command line, configuration and call routing are
[cohesion-agent-kit](https://github.com/cohesionhq/actor-kit)'s.

It runs on Bun, as the user who runs it, with that user's Claude Code login
and settings (user, project and local settings and `CLAUDE.md` load as they
do in the terminal).

## Set up

```sh
bun install
# On the machine running cohesiond (its socket, or the default one):
bun index.ts setup --local /tmp/cohesion.sock --name "My laptop"
# Or from another device, with a code from `cohesion pair`:
bun index.ts setup <setup-code> --name "My laptop"

bun index.ts add ~/src/website  # offered as "website"
bun index.ts add ~/src/api-server --as api
bun index.ts run
```

The configuration lives in `~/.config/actor-agentsdk` (or
`--config <dir>`, or `$COHESION_ACTOR_AGENTSDK_CONFIG`): `config.json` holds how
to reach cohesiond, the client's key, and the directories offered, readable
only by its owner; `sessions.json` maps each actor session to its Claude Code
session. `add` and `remove` take effect on a running client at once.

## What each actor offers

- **Modes**, Claude Code's permission modes: Auto (`auto`, the default,
  where the model and account support it), Ask (`default`), Accept edits
  (`acceptEdits`), Plan (`plan`) and Bypass permissions (`bypassPermissions`,
  which runs every tool without asking).
- **Models**, as Claude Code lists them for the account at startup, each
  with its reasoning efforts.

## How an actor session runs

- **Start**: a new Claude Code session with a session id this client picks,
  so it is on disk before the first turn ends.
- **Messages**: go into the running session; one sent mid-turn joins it. A
  session's process exits after ten minutes with nothing to do, and the
  next message resumes it (`resume`), as does the first one after a restart.
  An actor session this client has no record of starts a new session from Cohesion's
  transcript.
- **Requests**: Claude Code's permission prompt (`canUseTool`) becomes a
  `permission` request (a `command`, a `fileChange` with a unified diff for
  `Edit` and `Write`, or any other `tool`); `AskUserQuestion` becomes a
  `question` and `ExitPlanMode` a `plan`. The actor session needs attention until the
  user responds. An approved plan moves the session to Auto. Allow for
  session adds Claude Code's suggested rules for the session only, never to
  a settings file. Abort denies and ends the turn.
- **Instructions**: Claude Code's own system prompt, plus a note (`src/instructions.ts`)
  that Cohesion renders `mermaid` code blocks as diagrams, to use where one
  helps explain a flow, architecture, sequence or state.
- **Images**: the user's go in with what they said as image content
  blocks. The ones Claude Code shows come back under the transcript message
  they belong to: an image `Read` and an MCP tool's (a screenshot, say)
  under the tool use, reported once its result is in, and any in Claude's
  own output under what it said. One cohesiond would refuse (over 10, over
  5 MB encoded, not PNG, JPEG, GIF or WebP) is left out, with a note in the
  transcript; so is every image of a message cohesiond refuses anyway.
- **Tool times**: each tool use is reported as it starts and ended
  (`end`, naming the message its reply stored) once its result is in,
  failed or not, so Cohesion times it. One reported only once its result is
  in (for its images) ends as it is shown; one whose result never comes,
  such as a tool the turn was stopped in, isn't ended.
- **Thinking**: Claude Code runs with adaptive thinking and summaries on
  (`thinking: { type: 'adaptive', display: 'summarized' }`), since by default
  the SDK gives thinking with no text. Each stretch with text is reported as a
  `thinking` message and ended (`end`) at once: its text comes only once it
  is done and a message's text can't change, so Cohesion shows its time as
  about nothing. Thinking
  of a subagent goes in its own transcript (below), and
  thinking with no text, or redacted, isn't shown. A background agent's tool
  use stays open (no `end`) until it finishes, though its tool result came
  at once; the `task_notification` ends it, or the end of the process.
- **Subagents**: `forwardSubagentText: true` makes Claude Code forward a
  subagent's text and thinking, not just its tools. Each subagent (a
  `local_agent` `task_started`, by its `task_id`, which every message of it
  carries as `agent_id`) is `launch`ed to Cohesion under the session, before
  anything else about it: `title` its description, `agent_type` its
  `subagent_type`, `background` its `is_backgrounded`, `message_id` the
  Cohesion message of the tool use that launched it, `parent` the subagent
  whose transcript holds that tool use (or none), and, once its first step
  shows it, `model` by launching again. Its thinking, text and tool uses (with
  their `end`s) and its context (by its model's window, once a turn has
  said it) go in its own transcript, addressed with `subagent`; the
  session's own status, progress and turn aren't touched. Its permission and
  question requests (`can_use_tool`'s `agentID`) are in its transcript too, and
  mark it `needsAttention`; the user's answer arrives as `sendActorSessionMessage`
  with `subagent` and goes to that request, and words to the session never
  answer one of a subagent's. `task_updated`/`task_notification` settle it: `completed` and
  `stopped`/`killed` are `idle` ("Done"), `failed` is `failed` (with its error as a
  message); a foreground one is also done when its tool use gets its result. A
  stopped session, or the end of the process, leaves working ones `idle`. After a reconnect
  every subagent the process still knows is launched again, parents first, with its status.
- **Tool categories**: each tool use carries a `category` for its icon,
  from its name: `command` (`Bash`, `BashOutput`, `KillShell`), `read`
  (`Read`, `NotebookRead`, `LS`), `edit` (`Edit`, `MultiEdit`, `Write`,
  `NotebookEdit`), `search` (`Grep`, `Glob`), `web` (`WebFetch`,
  `WebSearch`), `agent` (`Agent`, `Task`), `skill` (`Skill`), and `other`
  for the rest, MCP tools included. An MCP tool shows by a readable name,
  `mcp__claude_ai_Gmail__search_threads` as "Gmail: search threads".
- **Mode**: the user can switch it at any time; the running session takes
  it from its next step on.
- **Status**: working while Claude Code is at it, idle at the end of each
  turn, failed when Claude Code itself fails (not when, say, tests it ran
  fail). A turn Claude Code starts on its own, over a background shell's or
  monitor's notification say, isn't reported working until it uses a tool:
  one that only speaks shows in the transcript with no status change, so it
  wakes no one. A turn isn't over while subagents or workflows Claude Code runs in
  the background are: the actor session stays working, its progress "Waiting on a
  background agent", until Claude Code has taken their results up and
  ended the turn it does so in (or, should none follow, ten seconds after
  the last is done). Background shells and monitors don't hold it, as a
  dev server may run for good. Stop interrupts the turn and stops the
  background agents.
- **Title**: an actor session Cohesion titled with its prompt's first line takes
  Claude Code's own title for the session (as `claude --resume` lists it)
  as a `title` report once Claude Code has one, and again whenever it
  changes, such as with `/rename`; Claude Code has no message for it, so
  the client reads it after each step and turn. An actor session started with a
  title keeps it, and the session goes by it too. An actor session picked up from a
  session no longer available keeps its title.
- **Away from cohesiond**: the session keeps working; its updates are held
  and sent in order once it reconnects, after reporting each running actor session's
  status.

## Usage

Each actor session tells cohesiond how full its context window is, and each actor
how much of its plan it has used, whenever either changes:

- **Context**: an actor session's own, as a `context` report, which cohesiond keeps
  with the actor session: how full its session's context window is, as `/context`
  counts it (`getContextUsage`, in summary) as Claude Code starts, after
  each step that uses tools, and after each turn; from each response's
  usage between those; and from what compaction leaves.
- **Plan**: the account's claude.ai plan limits (5-hour, weekly, weekly
  per model), shared by every actor (`actorUsage`, said again on every
  reconnect), each naming the account as its `pool` (`claude:` and its
  email, within its organization when it has one) so cohesiond shows one
  row for the account, across directories and devices. They come from Claude Code's
  `/usage` data (an experimental SDK call) at startup, as each session
  starts and after a turn (at most every 30 seconds), and from the rate
  limit events Claude Code sends during a turn; each limit keeps its last
  known value. An API-key, Bedrock or Vertex login has none, so no plan is
  said.

What Claude Code can't say is left out, and a cohesiond that refuses usage
(an older one) is ignored: usage never fails an actor session.

## Checks

```sh
bun run check
bun test
```

CI (`.github/workflows/test.yml`) runs both on every push to `master`,
against the commits of cohesion-ts and cohesion-agent-kit that `bun.lock`
pins.

## Licence

Copyright (c) 2026 Jackson Zamorano.

Licensed under the MIT License. See [`LICENSE`](LICENSE).
