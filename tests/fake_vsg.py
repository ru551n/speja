"""A stand-in for VSG in the local-rules test: one "local rule", fake_001, reports and fixes TODO.

Checks that vsg-rs passes the local rules directory and a last configuration file that disables
the built-in rules.
"""

import json
import sys

args = sys.argv[1:]
assert args[args.index("-lr") + 1].endswith("rules"), args
configs = args[args.index("-c") + 1 : args.index("-of")]
assert json.load(open(configs[-1]))["rule"]["entity_001"] == {"disable": True}, configs
fix = "--fix" in args
found = False
for path in args[args.index("-f") + 1 :]:
    with open(path) as f:
        lines = f.read().splitlines(keepends=True)
    for number, line in enumerate(lines, 1):
        if "TODO" in line:
            if fix:
                lines[number - 1] = line.replace("TODO", "DONE")
            else:
                found = True
                print(f"ERROR: {path}({number})fake_001 -- Replace TODO")
    if fix:
        with open(path, "w") as f:
            f.write("".join(lines))
sys.exit(1 if found else 0)
