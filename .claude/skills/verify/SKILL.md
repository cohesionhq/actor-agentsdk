---
name: verify
description: How to check a change in actor-agentsdk is right, and what "passing" means here. Use before committing or reporting any change to this repo, when a typecheck or test fails and you need to know whether it is yours, after moving to a new cohesion-ts or cohesion-agent-kit, or when you want to exercise the CLI without touching the live client.
---

# Verify a change

## The checks

Both must pass before a change is done. Each takes about a second.

```sh
bun run check   # tsc --noEmit -p . (strict, noUncheckedIndexedAccess)
bun test        # bun:test over test/*.test.ts
```

There is no linter, formatter or CI. Match the code around you: tabs,
single quotes, short prose comments that say what a thing *is*.

**Baseline**: both are green on master (61 tests across 8 files as of
2026-11-07). A failure is therefore new: yours, or from someone else's
uncommitted file (see `dirty-checkout`). To tell which, look at
`git status` and whether the failing file or test is one you touched;
don't stash their work to find out.

## Tests

`CLAUDE.md` says what deserves a test: the translation and session rules a
regression would quietly break. Follow the existing files:

- `test/translate.test.ts`: the pure functions in `src/translate.ts`.
- `test/session.test.ts`, `test/title.test.ts`: an `ActorSession` driven through
  `test/fake_session.ts`, which fakes the cohesion-ts `Client`, the store and
  `Usage`. `handle(message)` feeds it SDK messages; `prompt(name, input)`
  calls its permission prompt; `sent` and `ended()` show what it reported.
  Private members are reached with `as unknown as { … }`, as the fake does.
- `test/usage.test.ts`, `test/images.test.ts`, `test/offers.test.ts`.

The config, the CLI, call routing and the image rules live in
cohesion-agent-kit (cohesionhq/actor-kit), which has no tests of its own.

Don't pin whole wire JSON, error wording, or timing (no tests that sleep
on real timers; `Bun.sleep(0)` to let promises settle is fine). Run one
file with `bun test test/session.test.ts`, one test with `-t '<name part>'`.

## After changing cohesion-ts or the kit

Both come from GitHub (`github:cohesionhq/ts`, `github:cohesionhq/actor-kit`)
at the commits `bun.lock` pins. Once a change to either is pushed (and passes
its own `bun run check`), run `bun update cohesion-agent-kit cohesion-ts` here,
then the checks, and commit the new `bun.lock`.

## Exercising the CLI

Never point experiments at the real configuration (`~/.config/actor-agentsdk`):
the live client watches it, and `add`/`remove` change what it offers at once.
Use a scratch one:

```sh
d=$(mktemp -d)
bun index.ts --config "$d" setup --local /tmp/none.sock --name scratch
bun index.ts --config "$d" add /tmp --as scratch
bun index.ts --config "$d" list
rm -rf "$d"
```

`run` needs a cohesiond; testing a whole actor session end to end means the live
client, which only the user restarts (see `live-client`). Say in the report
what they should try instead.
