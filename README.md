# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nowithyouu-pixel/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nowithyouu-pixel/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — to a tree of text files, to the specification in SPEC.md. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts --format=auto` (the default) detects the patch format; `--check` does everything but write; `--strict` matches lines exactly. `SPEC.md` is the whole contract: exit codes, output lines, the three matching tiers, and the four formats.

`check.ts` runs the kit's public practice set against `main.ts`:

```sh
node check.ts <practice.json>
```

`runner.ts` is the kit's trial runner, kept as it is. `extra-tests.mjs` holds additional edge-case checks written for this entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=q488z2cf&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
