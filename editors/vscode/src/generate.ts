// Pure code generation. Input is text that vhdl_ls produced (hover contents),
// never raw user VHDL, so there is no parser here and none is wanted:
// vhdl_lang already did the analysis.

export interface Iface {
  name: string;
  dir?: string;
  type: string;
  def?: string;
}

export interface EntityIface {
  name: string;
  library: string;
  generics: Iface[];
  ports: Iface[];
  /** A component declaration is instantiated by bare name, with no `entity` and no library. */
  kind?: "entity" | "component";
}

export interface EnumType {
  name: string;
  literals: string[];
}

/** Text between the parens following `kw`, matched at depth. */
function clause(src: string, kw: string): string | null {
  const m = new RegExp(`\\b${kw}\\b\\s*\\(`, "i").exec(src);
  if (!m) return null;
  let depth = 0;
  const open = m.index + m[0].length - 1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Split on `sep` at paren depth zero. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === sep && depth === 0) {
      out.push(text.slice(last, i));
      last = i + 1;
    }
  }
  out.push(text.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseIface(text: string): Iface[] {
  return splitTop(text, ";")
    .map((item) => {
      const eq = item.indexOf(":=");
      const def = eq >= 0 ? item.slice(eq + 2).trim() : undefined;
      const lhs = (eq >= 0 ? item.slice(0, eq) : item).trim();
      const colon = lhs.indexOf(":");
      const name = lhs
        .slice(0, colon)
        .replace(/^\s*(signal|constant|variable)\s+/i, "")
        .trim();
      let rest = lhs.slice(colon + 1).trim();
      const dm = /^(in|out|inout|buffer|linkage)\b\s*/i.exec(rest);
      if (dm) rest = rest.slice(dm[0].length);
      return {
        name,
        dir: dm ? dm[1].toLowerCase() : undefined,
        type: rest.replace(/\s+/g, " ").trim(),
        def,
      };
    })
    .filter((i) => i.name && i.type);
}

/**
 * Parse the entity declaration that `textDocument/hover` returns.
 * `library` comes from the workspace symbol's containerName.
 */
export function parseEntityHover(
  hover: string,
  library = "work",
): EntityIface | null {
  // A component's hover has no `is`: `component fifo` then the clauses, then `end component;`.
  const m = /\b(entity|component)\s+(\w+)\b/i.exec(hover);
  if (!m) return null;
  const g = clause(hover, "generic");
  const p = clause(hover, "port");
  return {
    name: m[2],
    library,
    generics: g ? parseIface(g) : [],
    ports: p ? parseIface(p) : [],
    kind: m[1].toLowerCase() === "component" ? "component" : "entity",
  };
}

/** Parse `type state_t is (idle, run, done);` as hover returns it. */
export function parseEnumHover(hover: string): EnumType | null {
  const m = /\btype\s+(\w+)\s+is\s*\(/i.exec(hover);
  if (!m) return null;
  const body = clause(hover.slice(m.index), "is");
  if (body === null) return null;
  const literals = splitTop(body, ",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!literals.length || literals.some((l) => !/^('.'|\w+)$/.test(l)))
    return null;
  return { name: m[1], literals };
}

const pad = (xs: string[]) => Math.max(0, ...xs.map((x) => x.length));

/** Actuals that look like identifiers but never name a signal. */
const NOT_A_SIGNAL = new Set([
  "open",
  "others",
  "null",
  "unaffected",
  "inertial",
]);

function assocList(
  items: Iface[],
  actual: (i: Iface) => string,
  indent: string,
): string[] {
  const w = pad(items.map((i) => i.name));
  return items.map(
    (i, n) =>
      `${indent}${i.name.padEnd(w)} => ${actual(i)}${n < items.length - 1 ? "," : ""}`,
  );
}

export interface InstanceOptions {
  label?: string;
  indent?: string;
  /** Omit generics left at their default value. */
  skipDefaultedGenerics?: boolean;
  /** Emit LSP snippet placeholders so the actuals can be tabbed through. */
  snippet?: boolean;
  /**
   * How the library is spelled. Defaults to the one the server reported, which is only right
   * when the file declares it: inside the library the file is itself analysed in, `work` is
   * the name that needs no clause, and spelling that library out without one is an error.
   */
  library?: string;
  /** The label is already on the line, so the instantiation starts at the entity name. */
  omitLabel?: boolean;
}

/** Instantiation of an entity, formals mapped to like-named actuals. */
export function renderInstance(
  e: EntityIface,
  opts: InstanceOptions = {},
): string {
  const i = opts.indent ?? "  ";
  const label = opts.label ?? `i_${e.name}`;
  const generics = opts.skipDefaultedGenerics
    ? e.generics.filter((g) => g.def === undefined)
    : e.generics;
  let stop = 0;
  const actual = (x: Iface) =>
    opts.snippet ? `\${${++stop}:${x.name}}` : x.name;

  const head = opts.snippet ? `\${${++stop}:${label}}` : label;
  const target =
    e.kind === "component"
      ? e.name
      : `entity ${opts.library ?? e.library}.${e.name}`;
  const out = [opts.omitLabel ? `${i}${target}` : `${i}${head} : ${target}`];
  if (generics.length) {
    out.push(`${i}  generic map (`);
    out.push(...assocList(generics, actual, `${i}    `));
    out.push(`${i}  )`);
  }
  if (e.ports.length) {
    out.push(`${i}  port map (`);
    out.push(...assocList(e.ports, actual, `${i}    `));
    out.push(`${i}  );`);
  } else {
    out[out.length - 1] += ";";
  }
  return out.join("\n");
}

/** Replace generic names in a type mark with the values used in the generic map. */
export function substituteGenerics(
  type: string,
  values: Map<string, string>,
): string {
  let out = type;
  for (const [name, value] of values)
    out = out.replace(new RegExp(`\\b${name}\\b`, "gi"), value);
  return out;
}

export interface SignalOptions {
  indent?: string;
  /** Names that already have a declaration, from documentSymbol. */
  existing?: Iterable<string>;
  /** formal -> actual, read out of the port map. */
  actuals?: Map<string, string>;
  /** generic -> value, for types like std_logic_vector(g_width - 1 downto 0). */
  genericValues?: Map<string, string>;
}

/**
 * Signal declarations for every port of an instantiation that is not declared yet.
 * ponytail: types are copied verbatim from the port, with generic names textually
 * substituted. A port typed by an unconstrained array resolved through the actual
 * needs elaboration, which vhdl_ls does not expose; such a type lands as written.
 */
export function renderSignals(
  ports: Iface[],
  opts: SignalOptions = {},
): string {
  const indent = opts.indent ?? "  ";
  const declared = new Set(
    [...(opts.existing ?? [])].map((s) => s.toLowerCase()),
  );
  const generics = opts.genericValues ?? new Map();
  const seen = new Set<string>();
  const rows: [string, string][] = [];

  for (const p of ports) {
    // Given a map, only what it names: a port it leaves out has no actual to declare yet, and
    // "Map missing ports" is the action that gives it one.
    if (opts.actuals && !opts.actuals.has(p.name.toLowerCase())) continue;
    const actual = opts.actuals?.get(p.name.toLowerCase()) ?? p.name;
    const key = actual.toLowerCase();
    // An actual that is an expression, a slice or `open` is not a signal to declare.
    if (!/^[a-z]\w*$/i.test(actual) || NOT_A_SIGNAL.has(actual.toLowerCase()))
      continue;
    if (declared.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push([actual, substituteGenerics(p.type, generics)]);
  }

  if (!rows.length) return "";
  const w = pad(rows.map(([n]) => n));
  return rows
    .map(([n, t]) => `${indent}signal ${n.padEnd(w)} : ${t};`)
    .join("\n");
}

/** formal => actual pairs of a port map, keyed by the formals vhdl_ls reported. */
export function readActuals(
  portMapText: string,
  formals: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of formals) {
    const m = new RegExp(`\\b${f}\\s*=>\\s*([^,)]+)`, "i").exec(portMapText);
    if (m) out.set(f.toLowerCase(), m[1].trim());
  }
  return out;
}

export interface FsmOptions {
  indent?: string;
  /** Indentation of the process, when it is not written beside the declaration. */
  processIndent?: string;
  signal?: string;
  clock?: string;
  reset?: string;
  resetStyle?: "sync" | "async" | "none";
}

/**
 * A registered state machine over an existing enum type, in the two places VHDL wants it.
 *
 * The state signal is a declaration and the process is a concurrent statement, and an
 * architecture keeps them either side of `begin`. Written together, as one block, the process
 * sits among declarations, which is an error.
 */
export function renderFsmParts(
  e: EnumType,
  opts: FsmOptions = {},
): { declaration: string; process: string } {
  const i = opts.indent ?? "  ";
  const p = opts.processIndent ?? i;
  const sig = opts.signal ?? "state";
  const clk = opts.clock ?? "clk";
  const rst = opts.reset ?? "reset";
  const style = opts.resetStyle ?? "sync";
  const idle = e.literals[0];
  const body: string[] = [];

  body.push(
    `${p}p_${sig} : process (${clk}${style === "async" ? `, ${rst}` : ""}) is`,
  );
  body.push(`${p}begin`);

  const inner: string[] = [];
  inner.push(`${p}    case ${sig} is`);
  for (const lit of e.literals) {
    inner.push(`${p}      when ${lit} =>`);
    inner.push(`${p}        null;`);
    inner.push("");
  }
  inner.pop();
  inner.push(`${p}    end case;`);

  if (style === "async") {
    body.push(`${p}  if ${rst} then`);
    body.push(`${p}    ${sig} <= ${idle};`);
    body.push(`${p}  elsif rising_edge(${clk}) then`);
    body.push(...inner.map((l) => l.replace(/^ {2}/, "")));
    body.push(`${p}  end if;`);
  } else {
    body.push(`${p}  if rising_edge(${clk}) then`);
    body.push(...inner.map((l) => l.replace(/^ {2}/, "")));
    if (style === "sync") {
      body.push("");
      body.push(`${p}    if ${rst} then`);
      body.push(`${p}      ${sig} <= ${idle};`);
      body.push(`${p}    end if;`);
    }
    body.push(`${p}  end if;`);
  }

  body.push(`${p}end process;`);
  return {
    declaration: `${i}signal ${sig} : ${e.name} := ${idle};`,
    process: body.join("\n"),
  };
}

/** The same, as one block, for a caller that places it itself. */
export function renderFsm(e: EnumType, opts: FsmOptions = {}): string {
  const { declaration, process } = renderFsmParts(e, opts);
  return `${declaration}\n\n${process}`;
}

/**
 * What the author is in the middle of typing, read off the line up to the cursor.
 *
 * `label`: `i_x : `, `i_x : mylib.`, `i_x : entity mylib.fi`. The label is theirs; what comes
 * after the colon is replaced by the instantiation, whatever of it they have typed so far.
 * `word`: `fi`, `mylib.`, `mylib.fi` on a line of its own, where the label is still to be
 * written and the snippet supplies one. `library` is set when they have named one, and then
 * only that library's entities are wanted. `from` is the column the replacement starts at.
 */
export type InstantiationContext =
  | { kind: "label"; library?: string; typed: string; from: number }
  | { kind: "word"; library?: string; typed: string; from: number };

export function instantiationContext(
  lineToCursor: string,
): InstantiationContext | null {
  const label =
    /^\s*[A-Za-z]\w*\s*:\s*(entity\s+)?(?:([A-Za-z]\w*)\s*\.\s*)?([A-Za-z]\w*)?$/i.exec(
      lineToCursor,
    );
  if (label) {
    const colon = lineToCursor.indexOf(":");
    let from = colon + 1;
    while (from < lineToCursor.length && lineToCursor[from] === " ") from++;
    return {
      kind: "label",
      library: label[2]?.toLowerCase(),
      typed: lineToCursor.slice(from),
      from,
    };
  }
  const word = /^(\s*)(?:([A-Za-z]\w*)\s*\.\s*)?([A-Za-z]\w*)?$/.exec(
    lineToCursor,
  );
  if (word && (word[2] || word[3])) {
    return {
      kind: "word",
      library: word[2]?.toLowerCase(),
      typed: lineToCursor.slice(word[1].length),
      from: word[1].length,
    };
  }
  return null;
}

/** Libraries that are visible without a library clause. */
const IMPLICIT_LIBRARIES = new Set(["work", "std"]);

/**
 * The identifier a workspace symbol declares, as vhdl_ls names it:
 * `constant 'c_foo'`, `function to_integer[...]`. Operator symbols return null,
 * since they are made visible by a use clause but not named by one.
 */
export function designatorOf(symbolName: string): string | null {
  const quoted = /'([^']+)'/.exec(symbolName);
  if (quoted) return quoted[1];
  const subprogram = /\b([A-Za-z]\w*)\s*\[/.exec(symbolName);
  return subprogram ? subprogram[1] : null;
}

/**
 * Where an `ieee` package sorts among its siblings: `std_logic_1164`, then `numeric_std`, then
 * the rest alphabetically.
 *
 * Not alphabetical throughout, because the ecosystem is not. Counted across hdl-modules, tsfpga
 * and VUnit, `std_logic_1164` is written before `numeric_std` between seven and twenty-two times
 * as often as after it. Nothing else in `ieee` shows a preference worth encoding.
 */
export function comparePackages(library: string, a: string, b: string): number {
  const rank = (name: string): [number, string] => {
    const lower = name.toLowerCase();
    if (library.toLowerCase() !== "ieee") return [2, lower];
    if (lower === "std_logic_1164") return [0, lower];
    if (lower === "numeric_std") return [1, lower];
    return [2, lower];
  };
  const [ra, na] = rank(a);
  const [rb, nb] = rank(b);
  return ra !== rb ? ra - rb : na < nb ? -1 : na > nb ? 1 : 0;
}

export interface ContextEdit {
  /** Line to insert before. */
  line: number;
  text: string;
}

/**
 * The context clause needed to make `library.pkg` visible to the design unit
 * starting at `unitLine`, or null when it already is. Without `pkg` only the library
 * itself is wanted, as for `entity lib.name`, and only its clause is added.
 *
 * ponytail: the existing clause is recognised by matching `library` and `use`
 * at the start of a line. A clause split across lines is not detected and would
 * produce a duplicate, which is legal VHDL and flagged by the server.
 */
export function contextClauseEdit(
  lines: string[],
  unitLine: number,
  library: string,
  pkg?: string,
): ContextEdit | null {
  const lib = library.toLowerCase();

  const isClause = (l: string) => /^\s*(library|use)\b/i.test(l);
  const isAbove = (l: string) => /^\s*(library\b|use\b|--|\s*$)/i.test(l);

  let start = unitLine;
  while (start > 0 && isAbove(lines[start - 1])) start--;

  // The line the clause goes before. Usually the design unit itself, but an architecture or a
  // package body has no context clause of its own: it inherits its primary unit's, further up
  // the file. Starting a second one between `end entity` and `architecture` is legal VHDL and
  // not where anyone looks for it, so the one that is already there is extended instead.
  //
  // Only for a secondary unit. A second entity in the file inherits nothing, and reusing the
  // first one's clause would make a name visible where it is not.
  const secondary = /^\s*(architecture|package\s+body)\b/i.test(
    lines[unitLine] ?? "",
  );
  let anchor = unitLine;
  if (secondary && !lines.slice(start, unitLine).some(isClause)) {
    let last = -1;
    for (let i = unitLine - 1; i >= 0; i--) {
      if (isClause(lines[i])) {
        last = i;
        break;
      }
    }
    if (last >= 0) {
      anchor = last + 1;
      start = anchor;
      while (start > 0 && isAbove(lines[start - 1])) start--;
    }
  }

  const region = lines.slice(start, anchor);
  if (pkg) {
    const isUse = new RegExp(`^\\s*use\\s+${lib}\\s*\\.\\s*${pkg}\\s*\\.`, "i");
    if (region.some((l) => isUse.test(l))) return null;
  }

  const hasLibrary =
    IMPLICIT_LIBRARIES.has(lib) ||
    region.some((l) =>
      new RegExp(`^\\s*library\\b[^;]*\\b${lib}\\b`, "i").test(l),
    );

  if (!pkg && hasLibrary) return null;

  // Where the clause belongs, rather than at the end of whatever is there. A `use` goes with the
  // library it names, in the order that library is conventionally written in, and a new
  // library goes in the order `source.organizeImports` sorts into: `ieee` and `std` first, then
  // everything else alphabetically, then `work` last. Appending to the end is legal VHDL but
  // leaves a `use` orphaned from its `library`, which is what someone reading the file trips on.
  const rank = (name: string): [number, string] => {
    const n = name.toLowerCase();
    if (n === "ieee" || n === "std") return [0, n];
    if (n === "work") return [2, n];
    return [1, n];
  };
  const before = (a: string, b: string) => {
    const [ra, na] = rank(a);
    const [rb, nb] = rank(b);
    return ra !== rb ? ra < rb : na < nb;
  };
  const useOf = (l: string) =>
    /^\s*use\s+([A-Za-z]\w*)\s*\.\s*([A-Za-z]\w*)/i.exec(l);
  const libOf = (l: string) => /^\s*library\s+([A-Za-z]\w*)/i.exec(l);

  let line = anchor;
  if (pkg && hasLibrary) {
    // Last `use` of this library that still sorts before the new package, else just after the
    // `library` clause itself.
    let at = -1;
    region.forEach((l, i) => {
      const u = useOf(l);
      if (
        u &&
        u[1].toLowerCase() === lib &&
        comparePackages(lib, u[2], pkg) < 0
      )
        at = i;
      else if (at < 0 && libOf(l)?.[1].toLowerCase() === lib) at = i;
    });
    if (at >= 0) line = start + at + 1;
  }
  if (line === anchor) {
    // A whole new library block, or no context clause to join. Place it before the first library
    // that sorts after it, so the file stays in the order organizeImports would put it in.
    let at = -1;
    for (const [i, l] of region.entries()) {
      const name = libOf(l)?.[1] ?? useOf(l)?.[1];
      if (name && before(library, name)) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      line = start + at;
    } else {
      let lastClause = -1;
      region.forEach((l, i) => {
        if (/^\s*(library|use)\b/i.test(l)) lastClause = i;
      });
      line = lastClause >= 0 ? start + lastClause + 1 : anchor;
    }
  }
  const indent = /^\s*/.exec(lines[anchor] ?? lines[unitLine] ?? "")![0];

  let text = "";
  // A whole new library block appended after another one needs a blank line above it just as
  // much as one inserted in front: without it the two libraries run together and stop reading
  // as separate groups. Only when the line above really is a clause, not a blank already there.
  if (
    !hasLibrary &&
    line > start &&
    /^\s*(library|use)\b/i.test(lines[line - 1] ?? "")
  )
    text += "\n";
  if (!hasLibrary) text += `${indent}library ${library};\n`;
  if (pkg) text += `${indent}use ${library}.${pkg}.all;\n`;
  // Keep a blank line between the clause and the design unit it precedes.
  if (line === anchor && (lines[anchor] ?? "").trim()) text += "\n";
  // And between a whole new library block and the one it was placed in front of, so the groups
  // stay groups rather than running together.
  else if (!hasLibrary && libOf(lines[line] ?? "")) text += "\n";

  return { line, text };
}

export interface Association {
  formal: string;
  actual: string;
  /** Offsets of the actual within the text that was searched. */
  start: number;
  end: number;
}

/**
 * `formal => actual` pairs, located by the formal names the server reported.
 * ponytail: named association only. Positional association is not recognised,
 * and a formal appearing inside an actual expression could mislead the search.
 */
export function readAssociations(
  text: string,
  formals: string[],
): Association[] {
  const out: Association[] = [];
  for (const f of formals) {
    const m = new RegExp(`\\b${f}\\s*=>\\s*([^,)]+)`, "i").exec(text);
    if (!m) continue;
    const actual = m[1].trimEnd();
    const start = m.index + m[0].length - m[1].length;
    out.push({
      formal: f,
      actual: actual.trim(),
      start,
      end: start + actual.length,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Formals of `ports` that the port map does not associate. */
export function missingFormals(
  ports: Iface[],
  associated: Iterable<string>,
): Iface[] {
  const have = new Set([...associated].map((s) => s.toLowerCase()));
  return ports.filter((p) => !have.has(p.name.toLowerCase()));
}

/**
 * Association lines to append to an existing map. `precededByEntries` decides
 * whether the block has to start with a comma continuing the previous entry.
 */
export function renderMissingAssociations(
  missing: Iface[],
  indent: string,
  precededByEntries: boolean,
): string {
  if (!missing.length) return "";
  const w = Math.max(0, ...missing.map((p) => p.name.length));
  const rows = missing.map((p) => `${indent}${p.name.padEnd(w)} => ${p.name}`);
  return (precededByEntries ? ",\n" : "") + rows.join(",\n");
}

/** Component declaration matching an entity, for old style instantiation. */
export function renderComponent(e: EntityIface, indent = "  "): string {
  const out = [`${indent}component ${e.name} is`];
  const clause = (kw: string, items: Iface[], close: string) => {
    if (!items.length) return;
    const w = Math.max(0, ...items.map((i) => i.name.length));
    out.push(`${indent}  ${kw} (`);
    items.forEach((i, n) => {
      const dir = i.dir ? `${i.dir.padEnd(5)} ` : "";
      const def = i.def !== undefined ? ` := ${i.def}` : "";
      out.push(
        `${indent}    ${i.name.padEnd(w)} : ${dir}${i.type}${def}${n < items.length - 1 ? ";" : ""}`,
      );
    });
    out.push(`${indent}  )${close}`);
  };
  clause("generic", e.generics, ";");
  clause("port", e.ports, ";");
  out.push(`${indent}end component;`);
  return out.join("\n");
}

export interface ClauseLine {
  index: number;
  kind: "library" | "use";
  /** Lower-cased names the clause makes visible. */
  names: string[];
}

/** The context clause preceding the design unit at `unitLine`. */
export function contextClause(lines: string[], unitLine: number): ClauseLine[] {
  let start = unitLine;
  while (start > 0 && /^\s*(library\b|use\b|--|\s*$)/i.test(lines[start - 1]))
    start--;

  const out: ClauseLine[] = [];
  for (let i = start; i < unitLine; i++) {
    const lib = /^\s*library\s+([^;]+);/i.exec(lines[i]);
    if (lib) {
      out.push({
        index: i,
        kind: "library",
        names: lib[1]
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      });
      continue;
    }
    const use = /^\s*use\s+([^;]+);/i.exec(lines[i]);
    if (use) {
      out.push({
        index: i,
        kind: "use",
        names: use[1]
          .split(",")
          .map((s) => s.trim().split(".").slice(0, 2).join(".").toLowerCase())
          .filter(Boolean),
      });
    }
  }
  return out;
}

export interface PortMapShape {
  /** Offset just after the last association, where new ones are appended. */
  insertAt: number;
  /** Whether the map already has associations to continue with a comma. */
  hasEntries: boolean;
  /** Indent of the last association line, reused for the new ones. */
  indent: string;
}

/** Locate where to append associations in an existing `port map (...)`. */
export function portMapShape(text: string): PortMapShape | null {
  const kw = /\bport\s+map\b/i.exec(text);
  if (!kw) return null;
  let i = text.indexOf("(", kw.index + kw[0].length);
  if (i < 0) return null;

  const open = i;
  let depth = 0;
  let close = -1;
  for (; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;

  const body = text.slice(open + 1, close);
  const hasEntries = body.trim().length > 0;
  let insertAt = close;
  while (insertAt > open + 1 && /\s/.test(text[insertAt - 1])) insertAt--;

  const lastLine = text.lastIndexOf("\n", insertAt - 1);
  const indent =
    hasEntries && lastLine >= 0
      ? /^\s*/.exec(text.slice(lastLine + 1))![0]
      : "    ";
  return { insertAt, hasEntries, indent };
}

/** ieee first, then everything else alphabetically, then work. */
export function compareLibraries(a: string, b: string): number {
  const rank = (lib: string) => {
    const l = lib.toLowerCase();
    if (l === "ieee") return 0;
    if (l === "work") return 2;
    return 1;
  };
  return rank(a) - rank(b) || a.toLowerCase().localeCompare(b.toLowerCase());
}

/**
 * How much a package is wanted, for a name several of them declare.
 *
 * The standard `ieee` packages come first, then the less common standard ones, then the two
 * `numeric_bit` variants that nobody reaches for by accident, and last the Synopsys packages
 * (`std_logic_arith` and friends) that predate the standard and are what a codebase is trying
 * to get away from. A package this table does not know sorts with the standard ones, so a
 * project's own package is never pushed below a deprecated one.
 */
const IEEE_PREFERENCE: Record<string, number> = {
  std_logic_1164: 0,
  numeric_std: 0,
  math_real: 1,
  math_complex: 1,
  fixed_pkg: 1,
  float_pkg: 1,
  fixed_float_types: 1,
  std_logic_textio: 1,
  numeric_std_unsigned: 2,
  numeric_bit: 3,
  numeric_bit_unsigned: 3,
  std_logic_arith: 4,
  std_logic_unsigned: 4,
  std_logic_signed: 4,
  std_logic_misc: 4,
};

/**
 * Whether `use library.pkg.all` can make anything visible. The `ieee` generic packages cannot:
 * `float_generic_pkg` and `fixed_generic_pkg` exist to be instantiated, and a use clause naming
 * one directly is not what anyone typing `to_unsigned` means, however well the name matches.
 */
export function usablePackage(library: string, pkg: string): boolean {
  return !(library.toLowerCase() === "ieee" && /_generic_pkg$/i.test(pkg));
}

/** How much a package is wanted, lower first: the ranking both the lightbulb and completion use. */
export function useRank(library: string, pkg: string): number {
  return library.toLowerCase() === "ieee"
    ? (IEEE_PREFERENCE[pkg.toLowerCase()] ?? 1)
    : 0;
}

/**
 * Whether the word being typed is a name being declared rather than one being used.
 *
 * A new port, generic or parameter at the start of its element, or the name after `signal`,
 * `constant`, `function` and the rest. Nothing is imported for a name that does not exist yet:
 * typing `cl` for a new port called `clk` is not a request for `clamp` from some package.
 * `before` is the source up to the cursor.
 */
export function declaresName(before: string): boolean {
  const code = before.replace(/--[^\n]*/g, "");
  if (
    /(^|[\s;(])(signal|variable|constant|type|subtype|alias|file|function|procedure|component|entity|architecture|package|attribute|units)\s+[A-Za-z]\w*$/i.test(
      code,
    )
  )
    return true;
  let depth = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const ch = code[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const head = code.slice(0, i);
      const list =
        /(\bport|\bgeneric|\b(function|procedure)\s+[A-Za-z]\w*)\s*$/i.test(
          head,
        );
      if (!list) return false;
      const tail = code.slice(i + 1);
      const element = tail.slice(tail.lastIndexOf(";") + 1);
      return /^\s*([A-Za-z]\w*\s*,\s*)*[A-Za-z]\w*$/.test(element);
    }
  }
  return false;
}

/**
 * Order the packages offered for an unresolved name, most likely wanted first.
 *
 * Alphabetical put `NUMERIC_BIT` above `numeric_std` for `unsigned`, and the top row of a
 * lightbulb is the one that gets accepted.
 */
export function compareUseCandidates(
  a: { library: string; pkg: string },
  b: { library: string; pkg: string },
): number {
  return (
    useRank(a.library, a.pkg) - useRank(b.library, b.pkg) ||
    compareCandidates(a, b)
  );
}

/** Order candidate packages for any list shown to the user. */
export function compareCandidates(
  a: { library: string; pkg: string },
  b: { library: string; pkg: string },
): number {
  return (
    compareLibraries(a.library, b.library) ||
    a.pkg.toLowerCase().localeCompare(b.pkg.toLowerCase())
  );
}

// --- declarations and case statements ---------------------------------------

/** What an object declaration may be, at the point the cursor sits. */
export type ObjectKind = "signal" | "variable" | "constant";

/**
 * What an assignment to `name` on this line says it has to be.
 *
 * `<=` is a signal assignment and `:=` a variable one, and that is a harder fact than where the
 * cursor happens to sit: a process assigns to signals all the time, and those signals are the
 * architecture's. `<=` is also "less than or equal", so only a name at the start of the line,
 * where a target goes, is read as an assignment.
 */
export function assignmentKind(
  line: string,
  name: string,
): "signal" | "variable" | null {
  const target = new RegExp(
    `^\\s*${name}\\s*(\\([^)]*\\))?\\s*(<=|:=)`,
    "i",
  ).exec(line.replace(/--.*$/, ""));
  if (!target) return null;
  return target[2] === "<=" ? "signal" : "variable";
}

/**
 * The kinds of declaration that could explain this name, most likely first.
 *
 * An assignment settles which of a signal and a variable it is. A constant is offered either
 * way: it cannot be assigned to at all, so an author who picks it is telling you the line is
 * what they will change next, and leaving it out would be the tool arguing with them.
 *
 * Without an assignment the name is only being read, and then it is the declarative parts in
 * reach that decide: a variable needs a process or a subprogram, and a signal and a constant are
 * declared above them and so are always available.
 */
export function declarableKinds(
  inSequentialPart: boolean,
  assigned: "signal" | "variable" | null = null,
): ObjectKind[] {
  if (assigned === "signal") return ["signal", "constant"];
  if (assigned === "variable")
    return inSequentialPart ? ["variable", "constant"] : ["constant"];
  return inSequentialPart
    ? ["signal", "variable", "constant"]
    : ["signal", "constant"];
}

/**
 * The type a literal says it is, or null when it says nothing.
 *
 * Only the forms that are unambiguous. A bit string could be a `std_logic_vector`, an `unsigned`
 * or a `bit_vector`, and guessing between those is worse than leaving the tab stop for the
 * author, so `std_logic_vector` is offered as the tab stop's default rather than as a fact.
 */
export function typeOfLiteral(expr: string): string | null {
  const e = expr.trim();
  if (/^'[^']'$/.test(e)) return "std_logic";
  if (/^"[01uxzwlh-]*"$/i.test(e)) return "std_logic_vector";
  if (/^(true|false)$/i.test(e)) return "boolean";
  if (/^\d+$/.test(e)) return "natural";
  if (/^-\d+$/.test(e)) return "integer";
  if (/^\d+\s*(ns|us|ms|ps|fs|sec|min|hr)$/i.test(e)) return "time";
  return null;
}

/**
 * A value a constant of `type` could start from, as the second tab stop's default.
 *
 * A constant has to have one, so the tab stop is always there; what is in it should at least be
 * legal for the type, and `'0'` is not a `positive`. A type this does not know gets an empty
 * stop, which the editor lands on straight after the type.
 */
export function initialOf(type: string): string {
  const t = type.toLowerCase();
  if (/^(std_u?logic|bit)$/.test(t)) return "'0'";
  if (/^(std_u?logic_vector|unsigned|signed|bit_vector)\b/.test(t))
    return "(others => '0')";
  if (t === "boolean") return "false";
  if (t === "positive") return "1";
  if (/^(natural|integer|real)$/.test(t)) return "0";
  if (t === "time") return "0 ns";
  return "";
}

/** A one-line object declaration, with the type left as a tab stop for the editor. */
export function renderDeclaration(
  kind: ObjectKind,
  name: string,
  indent = "  ",
  type = "std_logic",
): string {
  const value = kind === "constant" ? ` := \${2:${initialOf(type)}}` : "";
  return `${indent}${kind} ${name} : \${1:${type}}${value};`;
}

/**
 * The selector of a `case` statement: the `x` of `case x is`, and of `case x` on its own.
 *
 * `is` is optional because the action this feeds exists to fire before the statement is
 * finished. A line that has not reached `is` yet is exactly the moment the author wants help.
 */
export function caseSelector(line: string): string | null {
  const m = /^\s*case\b\s*(\?\?)?\s*(.+?)(\s+is)?\s*$/i.exec(
    line.replace(/--.*$/, ""),
  );
  return m ? m[2].trim() : null;
}

/**
 * The enumeration `name` is declared with, read out of the source itself.
 *
 * Everything else in this file transforms what vhdl_ls said, and for good reason. This does not,
 * because at the moment it is for there is nothing to transform: a `case` with no `end case` does
 * not parse, the design unit does not analyse, and a hover on the selector comes back empty.
 * Measured in the extension host, not assumed. The declaration is in front of the author anyway,
 * so it is read from there, and only from the same file: a type from a package is a question for
 * the server, and the server will answer it once the statement is finished.
 */
export function enumFromSource(source: string, name: string): EnumType | null {
  const text = source.replace(/--.*$/gm, "");
  const declaration = new RegExp(
    `(?:^|\\n)\\s*(?:signal|variable|constant|shared\\s+variable)?\\s*` +
      `([\\w\\s,]*\\b${name}\\b[\\w\\s,]*?)\\s*:\\s*(?:in|out|inout|buffer)?\\s*([A-Za-z]\\w*)`,
    "i",
  ).exec(text);
  if (!declaration) return null;
  // The name has to be one of the names declared, not a substring of a longer one.
  if (
    !declaration[1]
      .split(",")
      .some((n) => n.trim().toLowerCase() === name.toLowerCase())
  )
    return null;

  const enumeration = new RegExp(
    `\\btype\\s+${declaration[2]}\\s+is\\s*\\(([^)]*)\\)`,
    "i",
  ).exec(text);
  if (!enumeration) return null;
  const literals = enumeration[1]
    .split(",")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z]\w*$/.test(l));
  return literals.length ? { name: declaration[2], literals } : null;
}

/** The choices a `case` body already covers, lower-cased. `others` counts as covering nothing. */
export function coveredChoices(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.replace(/--.*$/gm, "").matchAll(/\bwhen\b([^=]*)=>/gi))
    for (const choice of m[1].split("|"))
      if (
        /^\s*[a-z]\w*\s*$/i.test(choice) &&
        choice.trim().toLowerCase() !== "others"
      )
        out.add(choice.trim().toLowerCase());
  return out;
}

/** The enum literals a `case` body has no `when` for, in declaration order. */
export function missingChoices(body: string, literals: string[]): string[] {
  const covered = coveredChoices(body);
  return literals.filter((l) => !covered.has(l.toLowerCase()));
}

/** `when` arms for each choice, each with a `null;` to be replaced. */
export function renderWhenChoices(
  choices: string[],
  indent = "      ",
): string {
  return choices
    .map((c) => `${indent}when ${c} =>\n${indent}  null;\n`)
    .join("\n");
}
