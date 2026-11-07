---
name: live-client
description: The running actor-agentsdk client and how not to break it — it runs from this very checkout, every Claude Code actor session (likely including you) is its child, and restarting it is the deploy. Use before running `bun index.ts`, `bun install`, `install.sh`, `systemctl`, or anything touching ~/.config/actor-agentsdk, and when asked to deploy, restart or read the client's logs.
---

# The live client

Where it is deployed, the client runs as the systemd user unit
`actor-agentsdk.service`, which runs `bun start` (`bun index.ts run`)
**in this checkout**, with the real configuration in
`~/.config/actor-agentsdk`. If you were dispatched from Cohesion,
your own Claude Code process is one of its children. See `CLAUDE.local.md`
for the machine's details.

## What that means

- **Editing source is safe**: the running process loaded it at start, so
  your edits take effect only when it restarts.
- **Restarting is the deploy**, and it ends every running Claude Code actor session,
  yours included (they resume on their next message). Never run
  `systemctl --user restart|stop actor-agentsdk` unless the user asked
  you to deploy. When asked, make it the very last step, after committing,
  pushing and sending your report, since it may end your session mid-command.
- **`bun install`** rewrites `node_modules`, including the SDK's `claude`
  binary that live sessions spawn. Run it only when a dependency,
  `../cohesion-ts` or `../cohesion-agent-kit` changed, and say so in the report.
- **`install.sh`** compiles `actor-agentsdk` into `~/bin`; the service doesn't
  use it. Don't run it unless asked.
- **The real config** is watched: `add` or `remove` without `--config`
  changes what Cohesion is offered at once, and `setup` re-pairs. Use a
  scratch `--config` (see `verify`). Don't edit `sessions.json`; it maps live
  actor sessions to their Claude Code sessions.

## Looking without touching

```sh
systemctl --user status actor-agentsdk --no-pager
journalctl --user -u actor-agentsdk -n 50 --no-pager -o cat
```

Log lines are `<time> actor session <id> on <actor>: <call>`; Claude Code's
stderr and the client's errors show as `session <id>: …`. cohesiond itself is `cohesion.service`
(cohesion's repo).
