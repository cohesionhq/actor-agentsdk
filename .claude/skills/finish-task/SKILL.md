---
name: finish-task
description: How to finish a piece of work in actor-agentsdk — checks, docs, a commit of only your own files, push to master, and the report. Use whenever a change here is implemented and you are about to wrap up, commit or say you're done.
---

# Finish a task

1. **Verify.** `bun run check` and `bun test` pass (see `verify`). If one
   fails only because of someone else's uncommitted file, don't fix or
   hide it: note it in the report.
2. **Docs.** Update what your change makes untrue:
   - `README.md` for behaviour a user sees (the bullets under "How a task
     runs", "What each actor offers", "Usage"). It describes behaviour
     precisely; keep that voice.
   - `ARCHITECTURE.md` for a new module, flow or dependency.
   - `CLAUDE.md` or a skill under `.claude/skills/` if a rule or command
     there changed.
   - Protocol docs (`docs/actors.md`) live in `../cohesion`; changing them
     is cohesion work, not this repo's.
3. **Commit only your own files.** Run `git status` and stage explicit
   paths: `git add src/translate.ts test/translate.test.ts`, never
   `git add -A` or `git commit -a`. For a file that also holds someone
   else's edits, follow `dirty-checkout`. Check `git diff --cached --stat`
   before committing.
4. **Message.** Match `git log`: `feat: …`, `fix: …`, `test: …`, `docs: …`,
   `chore: …`, then a lowercase summary of the behaviour ("feat: a skill is
   its own tool category"). Add a prose body saying what now happens and
   why, when the subject isn't enough. No `Co-Authored-By` trailer.
5. **Push.** `git push origin master`. If it is rejected because origin
   moved, follow "Pulling" in `dirty-checkout` (a plain `git pull --rebase`
   refuses while others' changes are uncommitted), re-run the checks, and
   push again. If that conflicts, stop and report it.
6. **Don't deploy.** Don't restart `actor-agentsdk.service`, run
   `install.sh`, or touch `~/.config/actor-agentsdk` unless told
   (see `live-client`). Your change is live only after the client restarts.
7. **Report** in the `report` format.
