# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/liemargo/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/liemargo/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies edits that AI models write to a tree of text files. It reads all four formats models produce — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — finds the lines each edit names with three-tier fuzzy matching (exact, then trailing-whitespace-insensitive, then fully trimmed, with re-indentation at the loosest tier), and writes every change or nothing at all: a failed edit is reported, the rest still run, and no file is touched unless the whole patch succeeds.

## Run it

```sh
node main.ts fix.patch
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=rkd14ktt&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
