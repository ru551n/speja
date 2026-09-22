# Choosing a server

The extension runs an executable and talks to it. Which one is the only thing these settings
decide.

| `speja.server.mode` | Runs |
|---|---|
| `embedded` (default) | the server bundled with this extension |
| `systemPath` | `speja` from `PATH` |
| `userPath` | the executable named by `speja.server.path` |

## The bundled server

The extension is published per platform, and each build carries one server binary, the one
produced by the same release that built the extension. Nothing is downloaded at install time, and
there is no version to keep in step: **speja: Show Server Version** prints what the extension is
and what the server it launched reports.

| | |
|---|---|
| Linux | x86-64, arm64 |
| Windows | x86-64, arm64 |
| macOS | Intel, Apple silicon |

On anything else the extension says so rather than failing to start something that was never
there; install speja and set `server.mode` to `systemPath`.

## A local build

For working on speja itself:

```jsonc
"speja.server.mode": "userPath",
"speja.server.path": "/home/you/git/speja/target/debug/speja"
```

Changing either setting restarts the server, so a rebuild needs only **speja: Restart Server**
from the command palette, not a reload of the window.

## When it cannot start

The extension says so, and the reason is in the **speja** output channel
(**speja: Show Output**). The usual causes are that `speja` is not installed, or that
`server.path` points at something that is not there.

## Versions

The extension and the server are versioned together: an extension numbered `0.11.x` expects the
`speja` of the same minor version. `speja --version` prints what you have.
