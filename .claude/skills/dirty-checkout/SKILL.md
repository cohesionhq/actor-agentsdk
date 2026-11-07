---
name: dirty-checkout
description: How to work in the actor-agentsdk checkout when it already holds uncommitted changes that aren't yours (the user's, or another Claude Code task's). Use at the start of any task where `git status` isn't clean, before committing, and whenever you're tempted to stash, reset, checkout or revert anything.
---

# Working in a dirty checkout

The user and several Claude Code tasks work in this one checkout on master
at once. Uncommitted changes you didn't make are someone's work in progress.

## Rules

- **At the start**, run `git status --short` and `git diff --stat`, and
  remember which files were already modified. Those aren't yours.
- **Never** `git stash` (except the `--autostash` under "Pulling"), `git checkout -- <file>`, `git restore`,
  `git reset --hard`, `git clean`, or revert their hunks, even to get a
  clean test run. Never commit their changes, even if they look finished.
- Work on master in this checkout; don't make a worktree or branch unless
  the task truly needs isolation (and say why in the report).
- If their edits stop the checks passing, don't fix them. Check that your
  own change is right (`bun test test/<your file>.test.ts`, reading the
  error's file) and report the failure as theirs.

## Committing a file you share with them

If you edited a file that already had their changes, commit only your hunks:

```sh
git diff -U1 -- src/session.ts > /tmp/mine.patch   # -U1 keeps nearby edits in separate hunks
# edit /tmp/mine.patch: delete their whole hunks (from @@ to the next @@), keep yours
git apply --cached --recount /tmp/mine.patch
git diff --cached -- src/session.ts                # only yours?
```

`git add -p` is interactive and not available here. If your edits and theirs
fall in one hunk even at `-U1`, or touch the same lines, leave the file
uncommitted, commit the rest, and say so in the report under **Caveats**.

## Pulling

A plain `git pull --rebase` refuses while anything is uncommitted. When a
push is rejected:

```sh
git fetch origin
git diff --name-only HEAD...origin/master   # the files coming in
```

If none of those files has someone else's uncommitted changes, run
`git pull --rebase --autostash origin master`. This is the one stash
allowed: git puts their changes back itself. Afterwards `git stash list`
should be empty, and `git status` should show their files still modified.
If git says the autostash conflicted, their changes are safe in the stash:
don't drop or pop it. Stop and report. If the incoming files overlap theirs,
don't pull: report that the push needs the user.

## If a file changes under you

Another task may commit or edit while you work. Re-read a file before
editing it if time has passed. If a commit or pull fails because of their
changes, stop and report rather than force it.
