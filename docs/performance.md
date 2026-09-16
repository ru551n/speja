# Performance

Measured on a 24-core Linux machine with a release build (`lto = "thin"`), September 2026.

## Editor path (`fmt -`)

Best of 20–50 runs, process start to exit, including parsing, layout, output verification
(a second parse) and writing stdout:

| Input | Time |
|---|---|
| `vsg-rs --version` (cold start) | 0.4 ms |
| 30-line entity/architecture | 1.0 ms |
| VUnit `axi_stream_pkg.vhd` (1,100 lines, 42 kB) | 13 ms |
| `vsg-rs fix -` on the same file | 22 ms |

## Library (`cargo run --release --example bench`)

Best of 3–10 runs, single thread. `format` includes output verification. `fix` includes rule
checks before and after, one parse of the fixed source, and formatting.

| Input | Bytes | Parse | Format | Lint | Fix |
|---|---|---|---|---|---|
| small file | 299 | 0.02 ms | 0.08 ms | 0.02 ms | 0.17 ms |
| 5,000 statements | 338 k | 29 ms | 122 ms | 13 ms | 207 ms |
| fold-heavy (2,000 long lines) | 489 k | 31 ms | 120 ms | 164 ms | 364 ms |
| call nesting depth 300 | 6 k | 1.8 ms | 6 ms | 9 ms | 27 ms |
| 1,000 generics + 1,000 ports | 31 k | 5 ms | 18 ms | 25 ms | 53 ms |
| 2,000-term boolean chain | 36 k | 5 ms | 19 ms | 26 ms | 55 ms |
| 10,000-element aggregate | 59 k | 6 ms | 25 ms | 33 ms | 70 ms |
| 20,000-line architecture | 1.4 M | 162 ms | 546 ms | 72 ms | 984 ms |

Lint is more expensive on files with long lines, because `length_001` formats the file to find
out which overflows the formatter can fold.

## Repository

* 1,594 real-world files (12.6 MB): parse, format and verify in 2.9 s on one core
  (`examples/corpus.rs`).
* `vsg-rs check` on VUnit's `vunit/vhdl` (240 files, including OSVVM): 1.5 s using all cores.

## Complexity

Layout is linear in the input: each group is decided once, and the fit test looks ahead at most
the remaining width. Token neighbours are looked up in a per-snapshot token array. The underlying
tree's sibling navigation is linear in the number of siblings, which made a first version
quadratic on long lists (10,000-element aggregate: 10 s, now 25 ms). An upstream improvement to
`vhdl_syntax` would remove the need for the array.

## Known costs

* `check` formats each file once (the result is shared by `length_001` and the format check);
  `fix` formats the fixed source once.
* Output verification parses the output a second time. It stays enabled because it is what
  makes format-on-save safe.
