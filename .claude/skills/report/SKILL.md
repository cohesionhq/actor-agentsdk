---
name: report
description: The standard final report for work in actor-agentsdk — what changed, commits, checks, caveats, choices made without asking, and what the user should try by hand. Use as the last message of any task here, including one that stopped early or was blocked.
---

# The final report

Brief: a reader should take it in in half a minute. Use these headings,
dropping any that would be empty except **Choices made without asking**
(say "None" there).

```markdown
**Changed**: one or two lines per change, in user terms (what Claude Code
tasks in Cohesion now do), with `file:line` for anything to look at.

**Commits**: `abc1234 feat: …` (pushed to origin/master), one per line.

**Checks**: `bun run check` ✓, `bun test` ✓ (N pass). Anything else run,
such as the scratch-config CLI test, with its result. A failure says
whose it is.

**Caveats**: what isn't done, what might break, what was left uncommitted
and why (someone else's files you didn't touch, a hunk you couldn't
separate).

**Choices made without asking**: each design, naming or copy decision you
made where the task was open, with the alternative you passed over.

**Try by hand**: what the user should check once they restart
`actor-agentsdk.service`, as concrete steps ("start a task on any
actor, ask it to run `ls`, approve once, and see the command's
permission request close").
```

Say "Not done" plainly with the reason, and the next step, if the task
stopped short. Don't restate the task, list files you only read, or pad
with summaries of the code.
