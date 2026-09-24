# Claude Code plugin

The plugin gives Claude a **skill** that says when and how to use speja:

```text
/plugin marketplace add ru551n/speja
/plugin install speja@speja
```

`claude plugin update speja@speja` brings it up to date with a new release.

For one project instead, commit [`skills/speja/SKILL.md`](https://github.com/ru551n/speja/blob/main/skills/speja/SKILL.md)
to the project's `.claude/skills/speja/`, and everyone who clones it has the skill.

Either way, the skill runs the `speja` on `PATH`:

```sh
pip install speja        # or: uv tool install speja
```

## What the skill says

Claude loads it when a request is about formatting VHDL, checking its style, or whether it is
ready to commit. What it carries:

* **Before committing**, the two commands, over the changed files rather than the whole tree:
  `speja --fix` then `speja --check style,lint`. Exit code 0 means nothing of error severity.
* **How to read a finding.** Anything a default run reports is a definite error, because that is
  the only class on by default. Advisory and experimental rules depend on what you meant, so they
  are read rather than obeyed. `--explain` answers what a rule id means, instead of guessing from
  the message.
* **The library map warning is not noise.** Without `vhdl_ls.toml` most of the lint layer does not
  run, and a run that says so has not given the file a clean bill of health.
* **Do not reformat by hand.** Layout the formatter would undo on its next run makes the diff
  bigger, not smaller.
* **Do not silence what you will not fix.** Rules come from the project's configuration, and an
  accepted violation is a [waiver](waivers.md), which records a reason.

## The MCP server, optionally

The command line is the cheaper route for files on disk: many files per run, and nothing travels
through the conversation. The [MCP server](mcp.md) earns its place on the case the command line
cannot reach, which is source that is not a file yet: an agent writing a new module can format the
text and read its findings **before** the write. Register it on its own if you want that:

```sh
claude mcp add speja -- speja mcp
```
