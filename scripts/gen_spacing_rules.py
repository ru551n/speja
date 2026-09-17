#!/usr/bin/env python3
"""Generate src/spacing_rules.json from the descriptions of VSG's spacing rules.

Every VSG rule with a `number_of_spaces` option checks the spacing next to some token, and its
documentation says which: "a single space after the **function** keyword", "before the **=>**
operator", "between the label and the colon", "between the following elements: ...". Each
spacing becomes a pair [previous token, next token] of matchers, either of which may be null
(any token). A matcher is a keyword (`is`), a symbol (`:`, `=>`, `(`) or `identifier`. A
keyword that follows `end` only matches `end <keyword>`.

    git clone --depth 1 -b 3.35.0 https://github.com/jeremiah-c-leary/vhdl-style-guide vsg
    python scripts/gen_spacing_rules.py vsg/docs

The descriptions are read from the `*_rules.rst` files there. Rules whose description does not
match are listed and left out.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SYMBOLS = {
    "open parenthesis": "(",
    "guard open parenthesis": "(",
    "close parenthesis": ")",
    "(": "(",
    ")": ")",
    "colon": ":",
    "label colon": ":",
    "comma": ",",
    "=>": "=>",
    "<=": "<=",
    ":=": ":=",
    "assignment": None,  # := or <=, depending on the rule
    "default assignment": ":=",
    "default assignment token": ":=",
    "double less than": "<<",
    "double greater than": ">>",
}
IDENTIFIER = re.compile(
    r"^(\*?\w+\*? )*\*?(name|identifier|label|designator|entity_name|simple name|"
    r"subprogram name|package name|selected name|context identifier|attribute_designator|return type)\*?$"
)
# Descriptions the patterns do not cover.
EXTRA = {
    "block_100": [["identifier", ":"], [":", "block"], ["block", "("], [")", "is"]],
    "component_013": [["end component", None]],
    "constant_100": [[":=", None]],
    "entity_013": [["end entity", None]],
    "generate_013": [["end generate", None]],
    "package_002": [["package", "identifier"], ["identifier", "is"]],
    "package_body_100": [["package", "body"], ["body", "identifier"], ["identifier", "is"]],
    "port_003": [["port", "("]],
    "if_015": [["end", "if"]],
    "process_025": [[":", "process"]],
}
KEYWORD = re.compile(r"^\*\*(\w+)\*\*( keywords?)?$")


def matcher(phrase: str, rule: str) -> str | None:
    p = re.sub(r"\s+", " ", phrase).strip(" .")
    p = re.sub(r"^(the|a|an|at least a|single) ", "", p)
    p = re.sub(r" (keywords?|operator|token)$", "", p)
    p = p.removeprefix("the ")
    m = KEYWORD.match(p)
    if m:
        return m.group(1).lower()
    if re.fullmatch(r"\*\*(=>|<=|:=)\*\*", p):
        return p.strip("*")
    if p in SYMBOLS:
        found = SYMBOLS[p]
        if found is None:
            prefix = rule.rsplit("_", 1)[0]
            if prefix.endswith("_map"):
                return "=>"
            return "<=" if prefix in {"selected_assignment", "concurrent", "sequential"} else ":="
        return found
    if IDENTIFIER.match(p) or p in {"name", "identifier", "designator", "label"}:
        return "identifier"
    return None


def items(text: str) -> list[str]:
    return [i for i in re.split(r",? and |, ", text) if i]


def pairs(rule: str, text: str) -> list[list[str | None]] | None:
    t = re.sub(r"\s+", " ", text.split("**Violation**")[0]).strip()
    t = t.split(". ")[0].rstrip(".")
    m = re.search(r"after the following [\w ]*elements?: (.*)$", t)
    if m:
        ms = [matcher(i, rule) for i in items(m.group(1))]
        return None if None in ms else [[a, None] for a in ms]
    m = re.search(r"between (?:the following [\w ]*elements?: )?(.*?)(?: in .*| if .*)?$", t)
    if m:
        ms = [matcher(i, rule) for i in items(m.group(1))]
        if None in ms or len(ms) < 2:
            return None
        prevs = list(ms[:-1])
        if len(prevs) > 1 and prevs[0] == "end":
            prevs[1] = f"end {prevs[1]}"
        # "open parenthesis, close parenthesis": the spaces outside the parentheses.
        return [[a, b] for a, b in zip(prevs, ms[1:]) if [a, b] != ["(", ")"]]
    m = re.search(r"(?:spaces?|space exists) (after|before) (.+?)(?: in .*| if .*| for .*)?$", t)
    if m:
        where, what = m.groups()
        if " and " in what:
            parts = what.split(" and ")
            ms = [matcher(parts[0], rule), matcher(parts[1], rule)]
            if None in ms:
                return None
            return (
                [[ms[0], None], [None, ms[1]]]
                if "before" in parts[1]
                else [[ms[0], None], [ms[1], None]]
            )
        x = matcher(what, rule)
        if x is None:
            return None
        return [[x, None]] if where == "after" else [[None, x]]
    return None


def main() -> int:
    descriptions = {}
    for doc in Path(sys.argv[1]).glob("*_rules.rst"):
        for m in re.finditer(
            r"^(\w+_\d{3})\n#+\n(.*?)(?=^\w+_\d{3}\n#+\n|\Z)", doc.read_text(), re.M | re.S
        ):
            body = "\n".join(line for line in m.group(2).splitlines() if not line.startswith("|"))
            descriptions[m.group(1)] = body
    defaults = json.loads((ROOT / "src" / "vsg_defaults.json").read_text())["rule"]
    table, missing = {}, []
    for rule, config in sorted(defaults.items()):
        if "number_of_spaces" not in config:
            continue
        found = EXTRA.get(rule) or pairs(rule, descriptions.get(rule, ""))
        if found:
            table[rule] = found
        else:
            missing.append(rule)
    (ROOT / "src" / "spacing_rules.json").write_text(
        json.dumps(table).replace("]], ", "]],\n ") + "\n"
    )
    print(f"{len(table)} rules mapped; not mapped: {' '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
