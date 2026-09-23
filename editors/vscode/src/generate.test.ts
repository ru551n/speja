// Self-check: node --experimental-strip-types src/generate.test.ts
import assert from "node:assert/strict";
import {
  parseEntityHover,
  parseEnumHover,
  renderInstance,
  renderSignals,
  readActuals,
  renderFsm,
} from "./generate.ts";

// Verbatim textDocument/hover output from vhdl_ls (release build, probe3.mjs).
const ENTITY_HOVER = `entity leaf is
  generic (
    g_width : positive := 8
  );
  port (
    clk : in std_logic;
    din : in std_logic_vector(g_width - 1 downto 0);
    dout : out std_logic_vector(g_width - 1 downto 0)
  );
end entity;`;

const e = parseEntityHover(ENTITY_HOVER, "work");
assert.ok(e);
assert.equal(e.name, "leaf");
assert.equal(e.library, "work");
assert.deepEqual(
  e.generics.map((g) => g.name),
  ["g_width"],
);
assert.equal(e.generics[0].def, "8");
assert.deepEqual(
  e.ports.map((p) => p.name),
  ["clk", "din", "dout"],
);
assert.deepEqual(
  e.ports.map((p) => p.dir),
  ["in", "in", "out"],
);
// The `downto 0)` inside the type must not end the port clause.
assert.equal(e.ports[1].type, "std_logic_vector(g_width - 1 downto 0)");

assert.equal(
  renderInstance(e),
  `  i_leaf : entity work.leaf
    generic map (
      g_width => g_width
    )
    port map (
      clk  => clk,
      din  => din,
      dout => dout
    );`,
);

// Ports already declared are skipped; generics are substituted into the type.
assert.equal(
  renderSignals(e.ports, {
    existing: ["clk"],
    genericValues: new Map([["g_width", "16"]]),
  }),
  `  signal din  : std_logic_vector(16 - 1 downto 0);
  signal dout : std_logic_vector(16 - 1 downto 0);`,
);

// Actuals are read out of the port map using the formals vhdl_ls reported.
const actuals = readActuals(
  "port map (clk => clk, din => data_in, dout => open)",
  e.ports.map((p) => p.name),
);
assert.equal(actuals.get("din"), "data_in");
assert.equal(
  renderSignals(e.ports, { existing: ["clk"], actuals }),
  "  signal data_in : std_logic_vector(g_width - 1 downto 0);",
);
// A comment after an actual is not part of it.
assert.deepEqual(
  readAssociations(
    "port map ( -- ports\n    clk => sys_clk, -- the clock\n    din => data -- in\n  );",
    ["clk", "din"],
  ).map((a) => a.actual),
  ["sys_clk", "data"],
);
// `open` is not an identifier to declare.
assert.ok(!renderSignals(e.ports, { actuals }).includes("open"));
// A port the map leaves out has no actual yet, and is not declared under its own name.
assert.equal(
  renderSignals(e.ports, {
    actuals: readActuals(
      "port map (din => data_in)",
      e.ports.map((p) => p.name),
    ),
  }),
  "  signal data_in : std_logic_vector(g_width - 1 downto 0);",
);

const en = parseEnumHover("type state_t is (idle, run, done);");
assert.ok(en);
assert.deepEqual(en.literals, ["idle", "run", "done"]);
// A record or array type must not be mistaken for an enum.
assert.equal(parseEnumHover("type word_t is array (7 downto 0) of bit;"), null);

const fsm = renderFsm(en, { clock: "clk", reset: "rst" });
assert.ok(fsm.includes("signal state : state_t := idle;"));
assert.ok(fsm.includes("if rising_edge(clk) then"));
assert.ok(fsm.includes("when done =>"));
assert.ok(fsm.includes("if rst then"));

const async_ = renderFsm(en, { resetStyle: "async", reset: "rst_n" });
assert.ok(async_.includes("process (clk, rst_n) is"));
assert.ok(async_.includes("if rst_n then"));

console.log("ok");

// Snippet mode: the label is the first tab stop, then each actual in order.
const snip = renderInstance(e, { label: "u_leaf", snippet: true });
assert.ok(snip.includes("${1:u_leaf} : entity work.leaf"));
assert.ok(snip.includes("${2:g_width}"));
assert.ok(snip.includes("${3:clk}"));
assert.ok(snip.includes("${5:dout}"));
console.log("ok - snippet");

// --- context clause -------------------------------------------------------
import { contextClauseEdit, designatorOf } from "./generate.ts";

assert.equal(
  designatorOf("constant 'VitalDefaultPortFlag'"),
  "VitalDefaultPortFlag",
);
assert.equal(
  designatorOf("function COMPLEX_TO_POLAR[COMPLEX return COMPLEX_POLAR]"),
  "COMPLEX_TO_POLAR",
);
assert.equal(designatorOf("procedure stop[INTEGER]"), "stop");
assert.equal(
  designatorOf("array type 'VitalPortFlagVectorType'"),
  "VitalPortFlagVectorType",
);
// An operator is made visible by a use clause but is not named by one.
assert.equal(
  designatorOf(
    'operator "/"[STD_ULOGIC_VECTOR, NATURAL return STD_ULOGIC_VECTOR]',
  ),
  null,
);

// Nothing there yet: both clauses, with a blank line before the unit.
assert.deepEqual(
  contextClauseEdit(["entity foo is"], 0, "ieee", "numeric_std"),
  { line: 0, text: "library ieee;\nuse ieee.numeric_std.all;\n\n" },
);

// The library is already declared, so only the use clause is added, and it goes where that
// library is conventionally written: numeric_std after std_logic_1164, not alphabetically.
const existing = [
  "library ieee;",
  "use ieee.std_logic_1164.all;",
  "",
  "entity foo is",
];
assert.deepEqual(contextClauseEdit(existing, 3, "ieee", "numeric_std"), {
  line: 2,
  text: "use ieee.numeric_std.all;\n",
});

// A use clause belongs with the library it names, not at the end of whatever is there. Appending
// after a later library block would leave it orphaned from its own `library` clause, which is
// legal VHDL and unreadable.
const twoLibraries = [
  "library ieee;",
  "use ieee.std_logic_1164.all;",
  "",
  "library osvvm;",
  "use osvvm.randompkg.all;",
  "",
  "entity foo is",
];
assert.deepEqual(contextClauseEdit(twoLibraries, 6, "ieee", "numeric_std"), {
  line: 2,
  text: "use ieee.numeric_std.all;\n",
});

// A name used in the architecture belongs in the entity's context clause, which the architecture
// inherits. Starting a second one between `end entity` and `architecture` is legal VHDL and not
// where anyone looks for it.
{
  const file = [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "",
    "entity foo is",
    "end entity foo;",
    "",
    "architecture rtl of foo is",
    "begin",
    "end architecture rtl;",
  ];
  assert.deepEqual(contextClauseEdit(file, 6, "mylib", "counter_pkg"), {
    line: 2,
    text: "\nlibrary mylib;\nuse mylib.counter_pkg.all;\n",
  });
  // And an ieee package joins the block that is already there rather than starting one.
  assert.deepEqual(contextClauseEdit(file, 6, "ieee", "numeric_std"), {
    line: 2,
    text: "use ieee.numeric_std.all;\n",
  });
  // An entity with a context clause of its own still gets its own.
  const two = [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "",
    "entity foo is",
    "end entity foo;",
    "",
    "library osvvm;",
    "",
    "architecture rtl of foo is",
    "begin",
    "end architecture rtl;",
  ];
  assert.equal(contextClauseEdit(two, 8, "osvvm", "randompkg")?.line, 7);
}

// A group is set off from its neighbours by a blank line whether or not a library clause is
// written for it: `work` never has one, and three layouts glued groups together because of it.
{
  const apply = (lines: string[], unit: number, lib: string, pkg: string) => {
    const e = contextClauseEdit(lines, unit, lib, pkg);
    const out = [...lines];
    if (e) out.splice(e.line, 0, ...e.text.replace(/\n$/, "").split("\n"));
    return out.join("\n");
  };
  assert.equal(
    apply(
      ["library ieee;", "use ieee.std_logic_1164.all;", "", "entity e is"],
      3,
      "work",
      "p",
    ),
    "library ieee;\nuse ieee.std_logic_1164.all;\n\nuse work.p.all;\n\nentity e is",
  );
  assert.equal(
    apply(["use work.pkg.all;", "", "entity e is"], 2, "ieee", "numeric_std"),
    "library ieee;\nuse ieee.numeric_std.all;\n\nuse work.pkg.all;\n\nentity e is",
  );
  assert.equal(
    apply(
      [
        "library ieee;",
        "use ieee.std_logic_1164.all;",
        "",
        "use work.pkg.all;",
        "",
        "entity e is",
      ],
      5,
      "osvvm",
      "randompkg",
    ),
    "library ieee;\nuse ieee.std_logic_1164.all;\n\nlibrary osvvm;\nuse osvvm.randompkg.all;\n\nuse work.pkg.all;\n\nentity e is",
  );
  // Joining a group adds no blank line inside it.
  assert.equal(
    apply(
      [
        "library ieee;",
        "use ieee.std_logic_1164.all;",
        "",
        "use work.a_pkg.all;",
        "",
        "entity e is",
      ],
      5,
      "work",
      "b_pkg",
    ),
    "library ieee;\nuse ieee.std_logic_1164.all;\n\nuse work.a_pkg.all;\nuse work.b_pkg.all;\n\nentity e is",
  );
}

// Appended after the last block, a new library still gets a blank line above it: two libraries
// running together stop reading as two groups.
{
  const appended = contextClauseEdit(
    ["library ieee;", "use ieee.std_logic_1164.all;", "", "entity foo is"],
    3,
    "mylib",
    "counter_pkg",
  );
  assert.equal(appended.line, 2);
  assert.equal(appended.text, "\nlibrary mylib;\nuse mylib.counter_pkg.all;\n");
}

// A whole new library sorts into place too, in the order organizeImports uses: ieee and std
// first, everything else alphabetically, work last. It is separated from the block it precedes.
const ieeeAndWork = [
  "library ieee;",
  "use ieee.std_logic_1164.all;",
  "",
  "library work;",
  "use work.pkg.all;",
  "",
  "entity foo is",
];
assert.deepEqual(contextClauseEdit(ieeeAndWork, 6, "osvvm", "randompkg"), {
  line: 3,
  text: "library osvvm;\nuse osvvm.randompkg.all;\n\n",
});

// Already visible.
assert.equal(contextClauseEdit(existing, 3, "ieee", "std_logic_1164"), null);

// work needs no library clause.
assert.deepEqual(contextClauseEdit(["entity foo is"], 0, "work", "my_pkg"), {
  line: 0,
  text: "use work.my_pkg.all;\n\n",
});

// A second design unit later in the file gets its own clause, not the first one's.
const two = [
  "library ieee;",
  "use ieee.numeric_std.all;",
  "",
  "entity a is",
  "end entity;",
  "",
  "entity b is",
];
assert.deepEqual(contextClauseEdit(two, 6, "ieee", "numeric_std"), {
  line: 6,
  text: "library ieee;\nuse ieee.numeric_std.all;\n\n",
});

console.log("ok - context clause");

// --- associations, fill, component, context clause -------------------------
import {
  contextClause,
  missingFormals,
  readAssociations,
  renderComponent,
  renderMissingAssociations,
} from "./generate.ts";

const MAP = "port map (\n    clk => sys_clk,\n    din => data_in\n  );";
const assoc = readAssociations(
  MAP,
  e.ports.map((p) => p.name),
);
assert.deepEqual(
  assoc.map((a) => a.formal),
  ["clk", "din"],
);
assert.deepEqual(
  assoc.map((a) => a.actual),
  ["sys_clk", "data_in"],
);
// Offsets must point at the actual, so an inlay hint lands in the right place.
assert.equal(MAP.slice(assoc[1].start, assoc[1].end), "data_in");

const missing = missingFormals(
  e.ports,
  assoc.map((a) => a.formal),
);
assert.deepEqual(
  missing.map((p) => p.name),
  ["dout"],
);
assert.equal(
  renderMissingAssociations(missing, "    ", true),
  ",\n    dout => dout",
);
assert.equal(renderMissingAssociations([], "    ", true), "");

assert.equal(
  renderComponent(e),
  `  component leaf is
    generic (
      g_width : positive := 8
    );
    port (
      clk  : in    std_logic;
      din  : in    std_logic_vector(g_width - 1 downto 0);
      dout : out   std_logic_vector(g_width - 1 downto 0)
    );
  end component;`,
);

const doc = [
  "library ieee;",
  "use ieee.std_logic_1164.all;",
  "use ieee.numeric_std.all;",
  "",
  "entity foo is",
];
const clauses = contextClause(doc, 4);
assert.deepEqual(
  clauses.map((c) => c.kind),
  ["library", "use", "use"],
);
assert.deepEqual(clauses[0].names, ["ieee"]);
assert.deepEqual(clauses[2].names, ["ieee.numeric_std"]);
// A multi-name library clause lists each library.
assert.deepEqual(
  contextClause(["library ieee, work;", "entity f is"], 1)[0].names,
  ["ieee", "work"],
);

console.log("ok - associations, component, context clause");

import { portMapShape } from "./generate.ts";

const FILLED = `u_x : entity work.leaf
  port map (
    clk => clk,
    din => din
  );`;
const shape = portMapShape(FILLED);
assert.ok(shape);
assert.equal(shape.hasEntries, true);
assert.equal(shape.indent, "    ");
// Appending here must land right after the last association, not after the newline.
assert.equal(FILLED.slice(0, shape.insertAt).endsWith("din => din"), true);

const empty = portMapShape("u_x : entity work.leaf port map ();");
assert.ok(empty);
assert.equal(empty.hasEntries, false);

// A parenthesised type in an actual must not be taken as the closing paren.
const nested = portMapShape(
  "u_x : entity work.leaf\n  port map (\n    d => v(7 downto 0)\n  );",
);
assert.ok(nested);
assert.equal(nested.hasEntries, true);
assert.ok(
  "u_x : entity work.leaf\n  port map (\n    d => v(7 downto 0)\n  );"
    .slice(0, nested.insertAt)
    .endsWith("v(7 downto 0)"),
);

assert.equal(portMapShape("u_x : entity work.leaf;"), null);

console.log("ok - port map shape");

import { compareCandidates, compareLibraries } from "./generate.ts";

assert.deepEqual(
  ["work", "osvvm", "ieee", "std", "altera"].sort(compareLibraries),
  ["ieee", "altera", "osvvm", "std", "work"],
);
assert.deepEqual(
  [
    { library: "work", pkg: "types" },
    { library: "ieee", pkg: "numeric_std" },
    { library: "ieee", pkg: "math_real" },
    { library: "osvvm", pkg: "RandomPkg" },
  ]
    .sort(compareCandidates)
    .map((c) => `${c.library}.${c.pkg}`),
  ["ieee.math_real", "ieee.numeric_std", "osvvm.RandomPkg", "work.types"],
);
console.log("ok - library order");

// --- the library an instantiation names -------------------------------------------------------
// `entity mylib.fifo` is only legal once `library mylib;` has made the name visible, so the
// instance needs either `work` (inside the library the file is analysed in) or a library clause.
// This used to write the first form for every named library and no clause, which the server
// rejects with "No declaration of 'mylib'".
{
  const { renderInstance: instance, contextClauseEdit: clause } =
    await import("./generate.ts");
  const fifo = { name: "fifo", library: "mylib", generics: [], ports: [] };

  assert.ok(
    instance(fifo).includes("entity mylib.fifo"),
    "defaults to the reported library",
  );
  assert.ok(instance(fifo, { library: "work" }).includes("entity work.fifo"));

  // Only the library clause, and only when it is missing.
  assert.deepEqual(clause(["entity top is"], 0, "mylib"), {
    line: 0,
    text: "library mylib;\n\n",
  });
  const declared = ["library ieee;", "library mylib;", "", "entity top is"];
  assert.equal(clause(declared, 3, "mylib"), null, "already declared");
  assert.deepEqual(
    clause(
      ["library ieee;", "use ieee.std_logic_1164.all;", "", "entity top is"],
      3,
      "mylib",
    ),
    { line: 2, text: "\nlibrary mylib;\n" },
    "goes after the existing clauses, not above them, with a blank line between",
  );
  assert.equal(
    clause(["entity top is"], 0, "work"),
    null,
    "work is always visible",
  );
}
console.log("ok - instance library");

// --- the state machine belongs in two places ---------------------------------------------------
// A signal is a declaration and a process is a concurrent statement, and an architecture keeps
// them either side of `begin`. Written as one block, the process sat among the declarations and
// the server rejected the file ("Expected 'type', 'subtype', 'component', ...").
{
  const { renderFsmParts: parts, renderFsm: block } =
    await import("./generate.ts");
  const fsm = { name: "state_t", literals: ["idle", "run", "finish"] };
  const both = parts(fsm, {
    indent: "  ",
    processIndent: "  ",
    signal: "state",
    clock: "clk",
    reset: "rst",
  });

  assert.equal(both.declaration, "  signal state : state_t := idle;");
  assert.ok(
    !both.declaration.includes("process"),
    "the declaration holds no statement",
  );
  assert.ok(both.process.startsWith("  p_state : process (clk) is"));
  assert.ok(both.process.endsWith("end process;"));
  assert.ok(
    !both.process.includes("signal state"),
    "and the process holds no declaration",
  );
  // The process takes its own indentation, since it sits in a different part of the unit.
  assert.ok(
    parts(fsm, { indent: "  ", processIndent: "    " }).process.startsWith(
      "    p_state",
    ),
  );
  // Joined, it is what it always was.
  assert.equal(
    block(fsm, { signal: "state", clock: "clk", reset: "rst" }),
    `${both.declaration}\n\n${both.process}`,
  );
}
console.log("ok - state machine parts");

// --- declarations and case statements ---------------------------------------

import {
  declarableKinds,
  assignmentKind,
  renderDeclaration,
  instantiationContext,
  typeOfLiteral,
  caseSelector,
  enumFromSource,
  coveredChoices,
  missingChoices,
  renderWhenChoices,
  comparePackages,
  compareUseCandidates,
  usablePackage,
  declaresName,
  ownBegin,
} from "./generate.ts";

// The operator settles what the name is; a process assigns to the architecture's signals too.
assert.equal(assignmentKind("    held <= go;", "held"), "signal");
assert.equal(assignmentKind("    scratch := go;", "scratch"), "variable");
assert.equal(assignmentKind("    counts(3) <= go;", "counts"), "signal");
// "less than or equal" is not an assignment: the name is not the target of the line.
assert.equal(assignmentKind("    if a <= limit then", "limit"), null);
assert.equal(assignmentKind("    y <= a and b;", "a"), null);

// A constant cannot be assigned to, but it is offered either way: picking it says the line is
// about to change.
assert.deepEqual(declarableKinds(true, "signal"), ["signal", "constant"]);
assert.deepEqual(declarableKinds(true, "variable"), ["variable", "constant"]);
assert.deepEqual(declarableKinds(false, "variable"), ["constant"]);
// Only read, never assigned: whatever the enclosing declarative parts can hold.
assert.deepEqual(declarableKinds(false), ["signal", "constant"]);
assert.deepEqual(declarableKinds(true), ["signal", "variable", "constant"]);

assert.equal(
  renderDeclaration("signal", "count"),
  "  signal count : ${1:std_logic};",
);
assert.match(
  renderDeclaration("constant", "c_top", "    "),
  /^ {4}constant c_top : \$\{1:std_logic} := \$\{2:'0'};$/,
);

assert.equal(caseSelector("    case state is"), "state");
assert.equal(caseSelector("  CASE r.state IS -- note"), "r.state");
assert.equal(caseSelector("  case ?? sel is"), "sel");
assert.equal(caseSelector("  if state = idle then"), null);
// Before `is` is typed, which is the moment the action exists for.
assert.equal(caseSelector("    case state"), "state");
assert.equal(caseSelector("    case state  "), "state");

// Read out of the source, because a case with no `end case` does not parse and the server
// answers a hover on the selector with nothing at all.
const SRC = `architecture rtl of e is
  type t_mode is (boot, idle, active);
  signal mode : t_mode := boot;
  signal other : std_logic;
  variable count, mark : t_mode;
begin
  case mode
end architecture rtl;`;
assert.deepEqual(enumFromSource(SRC, "mode"), {
  name: "t_mode",
  literals: ["boot", "idle", "active"],
});
// One of several names on a line counts; a name that is not declared does not; a signal whose
// type is not an enumeration declared in this file gives nothing.
assert.deepEqual(enumFromSource(SRC, "mark")?.literals, [
  "boot",
  "idle",
  "active",
]);
assert.equal(enumFromSource(SRC, "other"), null);
assert.equal(enumFromSource(SRC, "nosuch"), null);
// A port is a declaration too.
assert.deepEqual(
  enumFromSource("type t_s is (a, b);\nport (\n  sel : in t_s\n);", "sel")
    ?.literals,
  ["a", "b"],
);

const BODY = `
      when idle =>
        null;
      when busy | flush =>
        null;
      when others => -- later
        null;
`;
assert.deepEqual([...coveredChoices(BODY)].sort(), ["busy", "flush", "idle"]);
assert.deepEqual(missingChoices(BODY, ["idle", "busy", "flush", "done"]), [
  "done",
]);
// Case matters to neither VHDL nor this.
assert.deepEqual(missingChoices("when IDLE => null;", ["idle", "done"]), [
  "done",
]);
assert.match(
  renderWhenChoices(["done"], "  "),
  /^ {2}when done =>\n {4}null;\n$/,
);

// What the author is in the middle of typing, for instantiation completion.
assert.deepEqual(instantiationContext("  i_x : "), {
  kind: "label",
  library: undefined,
  typed: "",
  from: 8,
});
assert.deepEqual(instantiationContext("  i_x : mylib."), {
  kind: "label",
  library: "mylib",
  typed: "mylib.",
  from: 8,
});
assert.deepEqual(instantiationContext("  i_x : entity mylib.fi"), {
  kind: "label",
  library: "mylib",
  typed: "entity mylib.fi",
  from: 8,
});
assert.deepEqual(instantiationContext("  i_x:fi"), {
  kind: "label",
  library: undefined,
  typed: "fi",
  from: 6,
});
assert.deepEqual(instantiationContext("  fi"), {
  kind: "word",
  library: undefined,
  typed: "fi",
  from: 2,
});
assert.deepEqual(instantiationContext("  other."), {
  kind: "word",
  library: "other",
  typed: "other.",
  from: 2,
});
// Two words before the colon is a declaration, not a label; a finished statement is nothing.
assert.equal(instantiationContext("  signal x : "), null);
assert.equal(instantiationContext("  x <= y;"), null);
assert.equal(instantiationContext(""), null);

// A component is instantiated by bare name, and a label already typed is not written twice.
{
  const hover =
    "component fifo\n  generic (\n    width : positive := 8\n  );\n  port (\n    clk : in std_logic\n  );\nend component;";
  const c = parseEntityHover(hover);
  assert.equal(c?.kind, "component");
  assert.equal(c?.name, "fifo");
  assert.deepEqual(
    c?.ports.map((p) => p.name),
    ["clk"],
  );
  assert.match(
    renderInstance(c, { omitLabel: true, indent: "" }),
    /^fifo\n\s*generic map/,
  );
  assert.doesNotMatch(renderInstance(c, { indent: "" }), /entity/);
  assert.match(
    renderInstance(e, { omitLabel: true, indent: "" }),
    /^entity work\.leaf/,
  );
}

// The ieee block is not alphabetical: std_logic_1164 declares what the rest are built on, and
// that is how hdl-modules, tsfpga and VUnit all write it.
assert.ok(comparePackages("ieee", "std_logic_1164", "numeric_std") < 0);
assert.ok(comparePackages("ieee", "numeric_std", "fixed_pkg") < 0);
assert.ok(comparePackages("ieee", "fixed_pkg", "math_real") < 0);
// Any other library is plain alphabetical.
assert.ok(comparePackages("osvvm", "std_logic_1164", "numeric_std") > 0);

{
  const lines = [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "",
    "entity e is",
  ];
  const added = contextClauseEdit(lines, 3, "ieee", "numeric_std");
  assert.equal(added.line, 2, "numeric_std goes after std_logic_1164");
  const before = contextClauseEdit(
    ["library ieee;", "use ieee.numeric_std.all;", "", "entity e is"],
    3,
    "ieee",
    "std_logic_1164",
  );
  assert.equal(before.line, 1, "std_logic_1164 goes before numeric_std");
}

// For a name several packages declare, the one people mean comes first and the ones they are
// migrating away from last.
{
  const sorted = [
    { library: "ieee", pkg: "std_logic_arith" },
    { library: "ieee", pkg: "NUMERIC_BIT" },
    { library: "ieee", pkg: "numeric_std" },
    { library: "mylib", pkg: "own_pkg" },
  ].sort(compareUseCandidates);
  assert.deepEqual(
    sorted.map((c) => c.pkg),
    ["numeric_std", "own_pkg", "NUMERIC_BIT", "std_logic_arith"],
  );
}

// A generic package is instantiated, not used.
assert.equal(usablePackage("ieee", "float_generic_pkg"), false);
assert.equal(usablePackage("IEEE", "fixed_generic_pkg"), false);
assert.equal(usablePackage("ieee", "numeric_std"), true);
assert.equal(usablePackage("mylib", "my_generic_pkg"), true);

// A name being declared is not a name to import.
assert.equal(declaresName("entity e is\n  port (\n    cl"), true);
assert.equal(declaresName("  port (\n    clk : in std_logic;\n    da"), true);
assert.equal(declaresName("  port (clk, rs"), true);
assert.equal(declaresName("  generic (\n    wid"), true);
assert.equal(declaresName("  function f (va"), true);
assert.equal(declaresName("  signal co"), true);
assert.equal(declaresName("  constant c_de"), true);
// A use is still a use: a type, a default value, a port map actual, an expression.
assert.equal(declaresName("  port (\n    clk : in std_l"), false);
assert.equal(declaresName("  signal count : unsig"), false);
assert.equal(declaresName("  port map (\n    clk => cl"), false);
assert.equal(declaresName("  u : entity work.x port map (cl"), false);
assert.equal(declaresName("      count <= to_uns"), false);
assert.equal(declaresName("      x <= f(a, to_uns"), false);
assert.equal(declaresName("  generic map (\n    width => c_wi"), false);

// The `begin` a construct owns, found by reading rather than by indentation.
{
  const at = (src: string, header: RegExp, statements = false) => {
    const lines = src.split("\n");
    const b = ownBegin(
      lines,
      lines.findIndex((l) => header.test(l)),
      statements,
    );
    return b === null ? null : b + 1; // 1-based, as read
  };
  // A function body in the declarative part has its own begin, before the architecture's.
  const withFunction = `architecture rtl of e is
  function f (a : integer) return integer is
  begin
    if a > 0 then
      return a;
    end if;
    return 0;
  end function f;
  signal s : bit;
begin
end architecture rtl;`;
  assert.equal(at(withFunction, /^architecture/), 10);
  // The same, not indented at all.
  assert.equal(at(withFunction.replace(/^ +/gm, ""), /^architecture/), 10);
  // A function declaration without a body, over two lines, has no begin to skip.
  assert.equal(
    at(
      "architecture rtl of e is\n  function f (a : integer)\n    return integer;\n  signal s : bit;\nbegin\nend architecture;",
      /^architecture/,
    ),
    5,
  );
  // Two architectures in a file: each finds its own.
  const two =
    "architecture a of e is\nbegin\nend architecture;\n\narchitecture b of e is\n  signal s : bit;\nbegin\nend architecture;";
  assert.equal(at(two, /^architecture b/), 7);
  // A process that declares a procedure: the process's begin, not the procedure's.
  const proc = `  p : process (clk) is
    procedure bump (n : in integer) is
    begin
      null;
    end procedure bump;
    variable v : integer;
  begin
    null;
  end process;`;
  assert.equal(at(proc, /p : process/), 7);
  // A record type and a component are not bodies, however many lines they take.
  assert.equal(
    at(
      "architecture rtl of e is\n  type t is record\n    a : bit;\n  end record;\n  component c is\n    port (x : in bit);\n  end component;\nbegin\nend;",
      /^architecture/,
    ),
    8,
  );
  // A generate with no declarative part has no begin; its first statement says so.
  assert.equal(
    at(
      "  g : for i in 0 to 3 generate\n    x(i) <= y(i);\n  end generate;",
      /generate$/,
      true,
    ),
    null,
  );
  assert.equal(
    at(
      "g : for i in 0 to 3 generate\np : process (clk) is\nbegin\nend process;\nend generate;",
      /generate$/,
      true,
    ),
    null,
  );
  // And one with a declaration has its own.
  assert.equal(
    at(
      "  g : for i in 0 to 3 generate\n    signal t : bit;\n  begin\n    t <= '1';\n  end generate;",
      /generate$/,
      true,
    ),
    3,
  );
}

console.log("generate.test.ts: ok");
