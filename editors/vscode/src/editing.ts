import * as vscode from "vscode";
import {
  ContextEdit,
  EntityIface,
  EnumType,
  ObjectKind,
  caseSelector,
  assignmentKind,
  declarableKinds,
  enumFromSource,
  missingChoices,
  renderDeclaration,
  renderWhenChoices,
  typeOfLiteral,
  returnTypeOf,
  compareCandidates,
  compareUseCandidates,
  declaresName,
  ownBegin,
  usablePackage,
  useRank,
  contextClause,
  contextClauseEdit,
  designatorOf,
  instantiationContext,
  InstantiationContext,
  missingFormals,
  parseEntityHover,
  parseEnumHover,
  readAssociations,
  renderComponent,
  renderFsmParts,
  renderInstance,
  renderMissingAssociations,
  renderSignals,
  substituteGenerics,
  portMapShape,
} from "./generate";

// Everything semantic is asked of the VHDL language server (VHDL-LS) through VS Code's own
// provider commands. Nothing here parses VHDL: an entity's ports come back from a hover, a
// design's instances from document symbols, a package's contents from workspace symbols. The
// generators in `generate.ts` transform that output and nothing else.
//
// The consequence is worth stating plainly: with no VHDL-LS running, every command here reports
// that no server answered. The lint and format half of this extension is unaffected.

type Sym = vscode.SymbolInformation;

// --- talking to the language server ---------------------------------------

async function hoverText(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    uri,
    position,
  );
  const parts: string[] = [];
  for (const h of hovers ?? [])
    for (const c of h.contents) {
      const raw =
        typeof c === "string" ? c : "value" in c ? c.value : String(c);
      parts.push(raw.replace(/^```\w*\n?|```$/g, "").trim());
    }
  return parts.join("\n").trim();
}

/** vhdl_ls names symbols `entity 'foo'`, `signal 'bar'`; pull out the identifier. */
function identOf(name: string): string {
  return /'([^']+)'/.exec(name)?.[1] ?? name.replace(/^\w+\s+/, "").trim();
}

const isEntitySymbol = (s: { name: string }) => /^entity\b/i.test(s.name);
const isInstance = (s: { name: string }) => /^instance\b/i.test(s.name);
const isArchitecture = (s: { name: string }) => /^architecture\b/i.test(s.name);

function flatten(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const out: vscode.DocumentSymbol[] = [];
  const walk = (s: vscode.DocumentSymbol) => {
    out.push(s);
    s.children.forEach(walk);
  };
  symbols.forEach(walk);
  return out;
}

async function documentSymbols(
  uri: vscode.Uri,
): Promise<vscode.DocumentSymbol[]> {
  const syms = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | vscode.SymbolInformation[]
  >("vscode.executeDocumentSymbolProvider", uri);
  if (!syms?.length) return [];
  // Only the hierarchical form carries children; the flat form is unusable here.
  return "children" in syms[0] ? (syms as vscode.DocumentSymbol[]) : [];
}

const workspaceSymbols = (query: string) =>
  vscode.commands.executeCommand<Sym[]>(
    "vscode.executeWorkspaceSymbolProvider",
    query,
  );

const indentOf = (line: string) => /^\s*/.exec(line)![0];

/** Library is whatever the server put in containerName, e.g. `work`. */
const libraryOf = (s: Sym) => (s.containerName || "work").split(".")[0];

async function findEntities(query: string): Promise<Sym[]> {
  return ((await workspaceSymbols(query)) ?? []).filter(isEntitySymbol);
}

/**
 * Every entity the workspace declares.
 *
 * Not an empty workspace symbol query. VHDL-LS answers those with at most 200 symbols, and
 * every port, generic, architecture and type counts toward them, so a project of a few dozen
 * entities loses some of its own without a word: the picker would offer part of the design and
 * the hierarchy would list part of it. A specific name still finds its entity, and a file's
 * document symbols are the server's answer to "what does this file declare" with no cap at
 * all, so each file is asked instead.
 */
async function projectEntities(): Promise<Sym[]> {
  const files = await vscode.workspace.findFiles(
    "**/*.{vhd,vhdl}",
    "**/node_modules/**",
  );
  const found: Sym[] = [];
  // A few at a time: each is a round trip to the server, and opening a document for it is
  // not free either.
  for (let at = 0; at < files.length; at += 8) {
    const batch = await Promise.all(files.slice(at, at + 8).map(entitiesIn));
    found.push(...batch.flat());
  }
  return found;
}

/** A component declaration somewhere in the workspace, instantiable by bare name. */
interface ComponentDecl {
  name: string;
  uri: vscode.Uri;
  position: vscode.Position;
}

async function componentsIn(uri: vscode.Uri): Promise<ComponentDecl[]> {
  return flatten(await documentSymbols(uri))
    .filter((s) => /^component\b/i.test(s.name))
    .map((s) => ({
      name: identOf(s.name),
      uri,
      position: s.selectionRange.start,
    }));
}

/**
 * Every entity in the workspace, for completion: `projectEntities`, kept because completion asks
 * on every keystroke while an instantiation is typed. Once built, a list older than thirty
 * seconds, or one a save has made stale, is still served while a fresh one is built behind it:
 * rebuilding in line would stall one keystroke in every thirty for as long as reading every file
 * takes. Only the very first list of a session is waited for.
 *
 * ponytail: a TTL and a save hook, not a file watcher; per-file invalidation if a project gets
 * big enough for the rebuild itself to matter.
 */
let entityCache: { builtAt: number; entities: Sym[] } | null = null;
let rebuilding: Promise<void> | null = null;

async function cachedEntities(): Promise<Sym[]> {
  const rebuild = () =>
    (rebuilding ??= projectEntities()
      .then((entities) => {
        entityCache = { builtAt: Date.now(), entities };
      })
      .finally(() => {
        rebuilding = null;
      }));
  if (!entityCache) await rebuild();
  else if (Date.now() - entityCache.builtAt > 30_000) void rebuild();
  return entityCache?.entities ?? [];
}

function forgetDesignIndex(): void {
  if (entityCache) entityCache.builtAt = 0;
}

/** The entities one file declares, as the workspace symbols the rest of this file works with. */
async function entitiesIn(uri: vscode.Uri): Promise<Sym[]> {
  const declared = flatten(await documentSymbols(uri)).filter(isEntitySymbol);
  return Promise.all(
    declared.map(async (entity) => {
      // The library an entity was analysed in is only reported on the workspace symbol, as its
      // containerName. Asking by name is a specific query, so it is not the one that hits the
      // cap; the match is on file and line, since two entities can share a name.
      const line = entity.selectionRange.start.line;
      const named = (await findEntities(identOf(entity.name))).find(
        (w) =>
          w.location.uri.toString() === uri.toString() &&
          w.location.range.start.line === line,
      );
      return (
        named ??
        new vscode.SymbolInformation(
          entity.name,
          entity.kind,
          "",
          new vscode.Location(uri, entity.selectionRange),
        )
      );
    }),
  );
}

async function entityAt(
  uri: vscode.Uri,
  position: vscode.Position,
  library: string,
) {
  return parseEntityHover(await hoverText(uri, position), library);
}

async function noServer(): Promise<void> {
  const pick = await vscode.window.showErrorMessage(
    "These actions need VHDL-LS and a vhdl_ls.toml. Lint and format do not.",
    "Open VHDL-LS setup",
  );
  if (pick)
    vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/VHDL-LS/rust_hdl#configuration"),
    );
}

// --- resolving an instantiation to its entity ------------------------------

interface ResolvedInstance {
  entity: EntityIface;
  uri: vscode.Uri;
  position: vscode.Position;
}

const resolvedInstances = new Map<string, ResolvedInstance>();

/**
 * Resolve the entity an instantiation refers to by asking the server for the
 * definition of each identifier on the statement's first lines. The first one
 * whose declaration is an entity wins; a component name resolves through its
 * own declaration the same way. Cached per document version, since the inlay
 * hint and code action providers ask repeatedly.
 *
 * Only a resolution that succeeded is cached. A null means either "this is not an
 * instantiation of anything the server knows" or "the server has not finished
 * analysing yet", and from the outside those cannot be told apart. Remembering the
 * second one is a bug, because a document nobody edits never changes version and so
 * never asks again: a file opened while VHDL-LS was still starting would show no
 * hints for good.
 */
async function resolveInstance(
  doc: vscode.TextDocument,
  inst: vscode.DocumentSymbol,
): Promise<ResolvedInstance | null> {
  const key = `${doc.uri.toString()}@${doc.version}#${inst.range.start.line}`;
  const cached = resolvedInstances.get(key);
  if (cached) return cached;

  const lastLine = Math.min(inst.range.start.line + 2, doc.lineCount - 1);
  const header = new vscode.Range(
    inst.range.start,
    new vscode.Position(lastLine, doc.lineAt(lastLine).text.length),
  );
  const text = doc.getText(header);
  const offset = doc.offsetAt(header.start);

  let found: ResolvedInstance | null = null;
  outer: for (const m of text.matchAll(/[A-Za-z]\w*/g)) {
    if (/^(entity|component|configuration|generic|port|map|work)$/i.test(m[0]))
      continue;
    const locs = await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >(
      "vscode.executeDefinitionProvider",
      doc.uri,
      doc.positionAt(offset + m.index!),
    );

    for (const loc of locs ?? []) {
      const uri = "uri" in loc ? loc.uri : loc.targetUri;
      const range =
        "range" in loc
          ? loc.range
          : (loc.targetSelectionRange ?? loc.targetRange);
      const entity = parseEntityHover(
        await hoverText(uri, range.start),
        "work",
      );
      if (!entity) continue;
      // containerName carries the library the entity was analyzed in.
      const sym = (await findEntities(entity.name)).find(
        (s) => s.location.uri.toString() === uri.toString(),
      );
      if (sym) entity.library = libraryOf(sym);
      found = { entity, uri, position: range.start };
      break outer;
    }
  }

  if (!found) {
    // Go-to-definition from inside an instantiation is not something every VHDL-LS answers:
    // 0.80.0, the one the Marketplace extension embeds, returns nothing for it, and with that
    // every feature built on the instance went dark while the picker and the completion kept
    // working. Those hover the entity at its own declaration, which every version answers. So
    // the name is read off the header and the entity looked up by it, the same way they do.
    const direct = /\bentity\s+(?:([A-Za-z]\w*)\s*\.\s*)?([A-Za-z]\w*)/i.exec(
      text,
    );
    const viaComponent =
      /\bcomponent\s+([A-Za-z]\w*)/i.exec(text) ??
      /^\s*[A-Za-z]\w*\s*:\s*([A-Za-z]\w*)/.exec(text);
    const library = direct?.[1]?.toLowerCase();
    const name = direct?.[2] ?? viaComponent?.[1];
    if (name) {
      const candidates = (await findEntities(name)).filter(
        (s) => identOf(s.name).toLowerCase() === name.toLowerCase(),
      );
      const sym =
        candidates.find(
          (s) =>
            library !== undefined &&
            library !== "work" &&
            libraryOf(s).toLowerCase() === library,
        ) ?? candidates[0];
      if (sym) {
        const at = sym.location.range.start;
        const entity = await entityAt(sym.location.uri, at, libraryOf(sym));
        if (entity) found = { entity, uri: sym.location.uri, position: at };
      }
    }
  }

  if (found) {
    if (resolvedInstances.size > 400) resolvedInstances.clear();
    resolvedInstances.set(key, found);
  }
  return found;
}

/**
 * The whole statement that starts at `start`: to the first `;` outside parentheses.
 *
 * The document symbol for an instantiation is not trusted for this. VHDL-LS 0.88 gives it the
 * statement's range; 0.80, the version the Marketplace extension embeds, gives it the label's
 * nine characters, and every feature that read the port map out of that range read nothing.
 */
function statementRange(
  doc: vscode.TextDocument,
  start: vscode.Position,
): vscode.Range {
  let depth = 0;
  for (let l = start.line; l < doc.lineCount && l < start.line + 400; l++) {
    const code = doc.lineAt(l).text.replace(/--.*$/, "");
    for (let c = l === start.line ? start.character : 0; c < code.length; c++) {
      const ch = code[c];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === ";" && depth <= 0)
        return new vscode.Range(start, new vscode.Position(l, c + 1));
    }
  }
  return new vscode.Range(start, doc.lineAt(doc.lineCount - 1).range.end);
}

/** Every instantiation in the document, each with the range of its whole statement. */
async function instanceSymbols(
  doc: vscode.TextDocument,
): Promise<vscode.DocumentSymbol[]> {
  return flatten(await documentSymbols(doc.uri))
    .filter(isInstance)
    .map((s) => {
      const whole = new vscode.DocumentSymbol(
        s.name,
        s.detail,
        s.kind,
        statementRange(doc, s.range.start),
        s.selectionRange,
      );
      whole.children = s.children;
      return whole;
    });
}

/**
 * The instantiation statement containing `position`, innermost first.
 *
 * Whole lines count: a cursor in the indentation before the label, or past the `;`, is on the
 * statement as far as anyone looking at it is concerned. And when the file does not analyse,
 * VHDL-LS reports no symbols at all, so the statement is found from the text instead: a file
 * with one half-typed line elsewhere made every instance in it invisible.
 */
async function instanceAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.DocumentSymbol | undefined> {
  const onLines = (r: vscode.Range) =>
    position.line >= r.start.line && position.line <= r.end.line;
  const found = (await instanceSymbols(doc))
    .filter((s) => onLines(s.range))
    .sort((a, b) => (a.range.contains(b.range) ? 1 : -1))[0];
  if (found) return found;

  const header =
    /^\s*([A-Za-z]\w*)\s*:\s*(entity\b|component\b|configuration\b|(?!(process|block|for|if|case|assert|postponed|with)\b)[A-Za-z]\w*\s*($|--|generic\b|port\b))/i;
  for (let l = position.line; l >= 0 && l > position.line - 80; l--) {
    const text = doc.lineAt(l).text;
    const m = header.exec(text);
    if (!m) {
      if (l < position.line && /;\s*(--.*)?$/.test(text)) return undefined;
      continue;
    }
    const start = new vscode.Position(l, text.indexOf(m[1]));
    const range = statementRange(doc, start);
    if (!onLines(range) || !/\bport\s+map\b/i.test(doc.getText(range)))
      return undefined;
    return new vscode.DocumentSymbol(
      `instance '${m[1]}'`,
      "",
      vscode.SymbolKind.Module,
      range,
      new vscode.Range(start, start),
    );
  }
  return undefined;
}

/**
 * Every name that is declared where `position` is: in the architecture around it, and the
 * entity's ports and generics. Not the whole file, where a second architecture with a signal of
 * the same name made this one's undeclared actual look declared. Without symbols, from the text.
 */
async function declaredNear(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<string[]> {
  const top = await documentSymbols(doc.uri);
  const architecture = top.find(
    (s) => isArchitecture(s) && s.range.contains(position),
  );
  if (architecture) {
    const entity = /\bof\s+([A-Za-z]\w*)/i.exec(
      doc.lineAt(architecture.range.start.line).text,
    )?.[1];
    const own = top.find(
      (s) =>
        isEntitySymbol(s) &&
        identOf(s.name).toLowerCase() === entity?.toLowerCase(),
    );
    return [architecture, ...(own ? [own] : [])]
      .flatMap((s) => flatten(s.children))
      .map((s) => identOf(s.name));
  }
  if (top.length) return flatten(top).map((s) => identOf(s.name));
  const names: string[] = [];
  for (const m of doc
    .getText()
    .replace(/--[^\n]*/g, "")
    .matchAll(
      /(?:^|[;(])\s*(?:signal|constant|variable|shared\s+variable|alias)?\s*([A-Za-z][\w\s,]*?)\s*:(?!=)/gm,
    ))
    names.push(...m[1].split(",").map((n) => n.trim()));
  return names;
}

// --- context clauses -------------------------------------------------------

interface UseCandidate {
  library: string;
  pkg: string;
  /** How the server described the declaration, shown in the picker. */
  describes: string;
}

/**
 * Every package that declares `name`, from the server's workspace symbols.
 * containerName is `library.package` for anything declared in a package, and
 * just the library for a design unit, which no use clause can make visible.
 */
async function findDeclaringPackages(name: string): Promise<UseCandidate[]> {
  const syms = (await workspaceSymbols(name)) ?? [];
  const out: UseCandidate[] = [];
  const seen = new Set<string>();
  const packages = new Map<string, boolean>();

  for (const s of syms) {
    if ((designatorOf(s.name) ?? "").toLowerCase() !== name.toLowerCase())
      continue;
    // VHDL-LS files an entity's ports under `library.entity`, the same shape as a package's
    // contents. `use mylib.counter.all` names nothing a use clause can reach, and offering it
    // for every undeclared `value` or `count` is what made the offers look random.
    if (s.kind === vscode.SymbolKind.Interface) continue;
    const parts = (s.containerName ?? "").split(".");
    if (parts.length < 2) continue;
    const [library, pkg] = parts;
    const key = `${library}.${pkg}`.toLowerCase();
    if (seen.has(key) || !usablePackage(library, pkg)) continue;
    if (!packages.has(key)) packages.set(key, await isPackage(library, pkg));
    if (!packages.get(key)) continue;
    seen.add(key);
    out.push({ library, pkg, describes: s.name });
  }
  return out.sort(compareUseCandidates);
}

/** Whether `library.name` is a package, as opposed to an entity or anything else with contents. */
async function isPackage(library: string, name: string): Promise<boolean> {
  return ((await workspaceSymbols(name)) ?? []).some(
    (s) =>
      /^package\b/i.test(s.name) &&
      identOf(s.name).toLowerCase() === name.toLowerCase() &&
      libraryOf(s).toLowerCase() === library.toLowerCase(),
  );
}

/** First line of the design unit the position belongs to. */
async function designUnitLine(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<number> {
  const top = await documentSymbols(doc.uri);
  const unit = top.find((s) => s.range.contains(position));
  return unit ? unit.range.start.line : 0;
}

/**
 * The library the server analysed a file in, or undefined when the file says nothing about it.
 *
 * Only a workspace symbol carries a library, as its containerName, and only design units are
 * asked for here: the file's first entity or package, matched by file and line since two units
 * can share a name. A file holding nothing but architectures declares no unit of its own.
 */
async function libraryOfFile(uri: vscode.Uri): Promise<string | undefined> {
  const units = (await documentSymbols(uri)).filter(
    (s) => isEntitySymbol(s) || /^package\b/i.test(s.name),
  );
  for (const unit of units) {
    const line = unit.selectionRange.start.line;
    const own = ((await workspaceSymbols(identOf(unit.name))) ?? []).find(
      (w) =>
        w.location.uri.toString() === uri.toString() &&
        w.location.range.start.line === line,
    );
    if (own?.containerName) return own.containerName.split(".")[0];
  }
  return undefined;
}

/**
 * How an instantiation of an entity from `library` has to be written in `doc`, and the context
 * edit that makes it legal.
 *
 * `library.entity` only resolves once `library x;` has made the name visible. Inside the library
 * the file is itself analysed in, `work` names it and needs no clause; spelling that library out
 * without one is an error, which is what a named library used to produce here. When the file's
 * library cannot be told, the clause is added: `library mylib;` is legal in mylib itself.
 */
async function libraryFor(
  doc: vscode.TextDocument,
  unitLine: number,
  library: string,
): Promise<{ name: string; edit: ContextEdit | null }> {
  const home = await libraryOfFile(doc.uri);
  if (home && home.toLowerCase() === library.toLowerCase())
    return { name: "work", edit: null };
  return {
    name: library,
    edit: contextClauseEdit(doc.getText().split("\n"), unitLine, library),
  };
}

function applyContextEdit(
  doc: vscode.TextDocument,
  edit: ContextEdit,
): vscode.WorkspaceEdit {
  const ws = new vscode.WorkspaceEdit();
  ws.insert(doc.uri, new vscode.Position(edit.line, 0), edit.text);
  return ws;
}

/** Packages already made visible to the design unit, as `library.package`. */
function visiblePackages(lines: string[], unitLine: number): Set<string> {
  const out = new Set<string>();
  for (const c of contextClause(lines, unitLine))
    if (c.kind === "use") c.names.forEach((n) => out.add(n));
  return out;
}

/**
 * Add a use clause by searching every package's contents, the way Ctrl+T searches symbols.
 *
 * Opens on the name under the cursor when there is one, and follows what is typed: each
 * keystroke asks the server's symbol index again, so the list is never limited to what a single
 * query happened to return. A package can be found by its own name too. Picking a row adds its
 * package's use clause where the context clause keeps them, from `work` for the file's own
 * library, and a package that is already visible says so rather than being added twice.
 */
async function addUseClause(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const at = editor.selection.active;
  const word = doc.getWordRangeAtPosition(at);
  const unitLine = await designUnitLine(doc, at);
  const own = (await libraryOfFile(doc.uri))?.toLowerCase();
  const lines = doc.getText().split("\n");

  type Row = vscode.QuickPickItem & { library: string; pkg: string };
  const pick = vscode.window.createQuickPick<Row>();
  pick.title = "Add a use clause";
  pick.placeholder =
    "Type a name from any package (to_unsigned, t_state, c_width), or a package's own name";
  pick.matchOnDescription = true;
  let asked = 0;
  const search = async (query: string): Promise<void> => {
    const mine = ++asked;
    if (query.trim().length < 2) {
      pick.items = [];
      return;
    }
    pick.busy = true;
    const rows: Row[] = [];
    const seen = new Set<string>();
    const packages = new Map<string, boolean>();
    for (const s of (await workspaceSymbols(query.trim())) ?? []) {
      if (s.kind === vscode.SymbolKind.Interface || isEntitySymbol(s)) continue;
      let library: string;
      let pkg: string;
      let name: string;
      let what: string;
      if (/^package\b/i.test(s.name)) {
        library = libraryOf(s);
        pkg = identOf(s.name);
        name = pkg;
        what = "the package itself";
      } else {
        const parts = (s.containerName ?? "").split(".");
        const designator = designatorOf(s.name);
        if (!designator || parts.length < 2) continue;
        [library, pkg] = parts;
        name = designator;
        what = s.name;
      }
      if (!usablePackage(library, pkg)) continue;
      const key = `${name}:${library}.${pkg}`.toLowerCase();
      if (seen.has(key)) continue;
      const packageKey = `${library}.${pkg}`.toLowerCase();
      if (!packages.has(packageKey))
        packages.set(packageKey, await isPackage(library, pkg));
      if (!packages.get(packageKey)) continue;
      seen.add(key);
      const shown = library.toLowerCase() === own ? "work" : library;
      const visible = contextClauseEdit(lines, unitLine, shown, pkg) === null;
      rows.push({
        label: name,
        description: `${shown}.${pkg}${visible ? "   already visible" : ""}`,
        detail: what,
        library: shown,
        pkg,
      });
    }
    if (mine !== asked) return;
    rows.sort(
      (a, b) =>
        useRank(a.library, a.pkg) - useRank(b.library, b.pkg) ||
        a.label.localeCompare(b.label),
    );
    pick.items = rows;
    pick.busy = false;
  };
  pick.onDidChangeValue((value) => void search(value));
  const chosen = await new Promise<Row | undefined>((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
    pick.onDidHide(() => resolve(undefined));
    pick.show();
    if (word) pick.value = doc.getText(word);
  });
  pick.dispose();
  if (!chosen) return;

  const edit = contextClauseEdit(
    doc.getText().split("\n"),
    unitLine,
    chosen.library,
    chosen.pkg,
  );
  if (!edit) {
    vscode.window.showInformationMessage(
      `${chosen.library}.${chosen.pkg} is already visible here.`,
    );
    return;
  }
  await vscode.workspace.applyEdit(applyContextEdit(doc, edit));
}

/**
 * The editing actions the lightbulb offers at `range`, the same provider the lightbulb asks, so
 * a command bound to a key and the lightbulb can never disagree about what is on offer.
 */
export async function editingActionsAt(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<vscode.CodeAction[]> {
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .filter((d) => d.range.intersection(range) !== undefined);
  const actions = await vscode.commands.executeCommand<
    vscode.CodeAction[] | undefined
  >("speja.internal.editingActions", document.uri, range, diagnostics);
  return actions ?? [];
}

/** Carry out a code action the way the lightbulb would: its edit, then its command. */
export async function runAction(action: vscode.CodeAction): Promise<void> {
  if (action.edit) await vscode.workspace.applyEdit(action.edit);
  if (action.command)
    await vscode.commands.executeCommand(
      action.command.command,
      ...(action.command.arguments ?? []),
    );
}

/**
 * One family of the lightbulb's actions at the cursor, as a command a key can be bound to.
 * One match is applied, several are offered as a list, none says what the command needs.
 */
async function actionsAtCursor(family: RegExp, none: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vhdl") return;
  const range = new vscode.Range(editor.selection.start, editor.selection.end);
  const actions = (await editingActionsAt(editor.document, range)).filter((a) =>
    family.test(a.title),
  );
  if (!actions.length) {
    vscode.window.showInformationMessage(none);
    return;
  }
  const chosen =
    actions.length === 1
      ? actions[0]
      : (
          await vscode.window.showQuickPick(
            actions.map((a) => ({ label: a.title, action: a })),
            { placeHolder: "Which one?" },
          )
        )?.action;
  if (chosen) await runAction(chosen);
}

/**
 * Report context clauses that nothing in the design unit appears to need.
 *
 * ponytail: a clause counts as used when any identifier in the unit is declared
 * by that package somewhere in the workspace, which over-reports use rather
 * than under-reports it. Nothing is removed without the user selecting it.
 */
async function removeUnusedUseClauses(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const lines = doc.getText().split("\n");

  const units = await documentSymbols(doc.uri);
  if (!units.length) {
    await noServer();
    return;
  }

  const stale: { line: number; text: string; label: string }[] = [];
  // `work` is the file's own library under another name, and the index only knows the real one.
  const own = (await libraryOfFile(doc.uri))?.toLowerCase();
  const real = (name: string) =>
    own && name.startsWith("work.") ? `${own}${name.slice(4)}` : name;
  const starts = units.map((u) => u.range.start.line).sort((a, b) => a - b);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "speja: checking use clauses",
    },
    async () => {
      for (const unit of units) {
        const clauses = contextClause(lines, unit.range.start.line).filter(
          (c) => c.kind === "use",
        );
        if (!clauses.length) continue;

        // The unit, and the architectures or package body after it that have no context clause
        // of their own: they inherit this one, and a name only an architecture uses is still used.
        const from = unit.range.start.line;
        const next = starts.find(
          (l) => l > from && contextClause(lines, l).length > 0,
        );
        const end = next === undefined ? lines.length : contextStart(lines, next);
        const body = lines.slice(from, end).join("\n").replace(/--[^\n]*/g, "");
        const words = new Set(
          [...body.matchAll(/[A-Za-z]\w*/g)].map((m) => m[0].toLowerCase()),
        );

        const used = new Set<string>();
        for (const w of words)
          for (const c of await findDeclaringPackages(w))
            used.add(`${c.library}.${c.pkg}`.toLowerCase());

        for (const clause of clauses) {
          if (clause.names.every((n) => used.has(real(n)))) continue;
          stale.push({
            line: clause.index,
            text: lines[clause.index],
            label: clause.names.join(", "),
          });
        }
      }
    },
  );

  if (!stale.length) {
    vscode.window.showInformationMessage(
      "Every use clause appears to be needed.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    stale.map((s) => ({
      label: s.text.trim(),
      description: `line ${s.line + 1}`,
      detail: "Nothing in this design unit resolved to it",
      line: s.line,
      picked: true,
    })),
    {
      canPickMany: true,
      placeHolder: "Use clauses that appear unused - select to remove",
    },
  );
  if (!picked?.length) return;

  const edit = new vscode.WorkspaceEdit();
  for (const p of picked)
    edit.delete(doc.uri, doc.lineAt(p.line).rangeIncludingLineBreak);
  await vscode.workspace.applyEdit(edit);
}

// --- generating code -------------------------------------------------------

/** The first line of the context clause above the unit on `unitLine`. */
function contextStart(lines: string[], unitLine: number): number {
  return contextClause(lines, unitLine)[0]?.index ?? unitLine;
}

/** Pick an entity from the workspace, ordered by library then name. */
async function pickEntity(
  placeHolder: string,
): Promise<{ sym: Sym; label: string } | undefined> {
  const entities = await projectEntities();
  if (!entities.length) {
    await noServer();
    return undefined;
  }
  return vscode.window.showQuickPick(
    entities
      // The qualified name is the label because the picker ranks by the label alone: with it in
      // the description, `fifo.fifo` ranked `asynchronous_fifo` above `fifo`.
      .map((s) => ({
        label: `${libraryOf(s)}.${identOf(s.name)}`,
        description: vscode.workspace.asRelativePath(s.location.uri),
        sym: s,
      }))
      .sort((a, b) =>
        compareCandidates(
          { library: libraryOf(a.sym), pkg: identOf(a.sym.name) },
          { library: libraryOf(b.sym), pkg: identOf(b.sym.name) },
        ),
      ),
    { placeHolder, matchOnDescription: true },
  );
}

async function instantiateEntity(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  // An instantiation is a concurrent statement: after the architecture's `begin`, and not in a
  // process. Said before the picker, not after the author has chosen an entity and a label.
  const cursor = editor.selection.active;
  const begin = architectureBegin(editor.document, cursor);
  if (
    begin === null ||
    cursor.line <= begin ||
    sequentialHome(editor.document, cursor) !== null
  ) {
    vscode.window.showWarningMessage(
      "Put the cursor after an architecture's `begin`, outside any process.",
    );
    return;
  }

  const picked = await pickEntity("Entity to instantiate");
  if (!picked) return;

  const lib = libraryOf(picked.sym);
  const e = await entityAt(
    picked.sym.location.uri,
    picked.sym.location.range.start,
    lib,
  );
  if (!e) {
    vscode.window.showErrorMessage(
      `The language server returned no declaration for ${picked.label}.`,
    );
    return;
  }

  const label = await vscode.window.showInputBox({
    prompt: "Instance label",
    value: `i_${e.name}`,
    validateInput: (v) =>
      /^[a-z]\w*$/i.test(v) ? undefined : "Must be a VHDL identifier",
  });
  if (!label) return;

  const line = editor.document.lineAt(editor.selection.active.line);
  const indent = line.isEmptyOrWhitespace
    ? indentOf(editor.document.lineAt(begin).text) + "  "
    : indentOf(line.text);
  const unit = await designUnitLine(editor.document, editor.selection.active);
  const home = await libraryFor(editor.document, unit, lib);
  const text = renderInstance(e, { label, indent, library: home.name });

  await editor.edit((b) => {
    // On an empty line it takes the line's place; on one with code it goes below, and the code
    // stays where it was.
    if (line.isEmptyOrWhitespace) b.replace(line.range, text);
    else b.insert(line.range.end, "\n" + text);
    if (home.edit)
      b.insert(new vscode.Position(home.edit.line, 0), home.edit.text);
  });
}

async function componentDeclaration(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const picked = await pickEntity("Entity to declare as a component");
  if (!picked) return;

  const e = await entityAt(
    picked.sym.location.uri,
    picked.sym.location.range.start,
    libraryOf(picked.sym),
  );
  if (!e) {
    vscode.window.showErrorMessage(
      `The language server returned no declaration for ${picked.label}.`,
    );
    return;
  }

  // In an architecture a component is a declaration, so it goes before `begin` whatever line
  // the cursor is on. Anywhere else, a package say, it goes where the cursor is.
  const line = editor.document.lineAt(editor.selection.active.line);
  const site = declarationSite(
    editor.document,
    editor.selection.active,
    "signal",
  ) ?? { position: new vscode.Position(line.lineNumber, 0), indent: indentOf(line.text) };
  await editor.edit((b) =>
    b.insert(site.position, renderComponent(e, site.indent) + "\n"),
  );
}

async function declareSignals(
  uriArg?: vscode.Uri,
  atArg?: vscode.Position,
): Promise<void> {
  // Raised from a code action, this is about the document the lightbulb was opened in, not
  // whichever one has focus by the time it runs.
  const editor = uriArg
    ? await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uriArg),
      )
    : vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  const inst = await instanceAt(doc, atArg ?? editor.selection.active);
  if (!inst) {
    vscode.window.showWarningMessage(
      "Put the cursor inside an instantiation of an entity or component.",
    );
    return;
  }

  const resolved = await resolveInstance(doc, inst);
  if (!resolved) {
    vscode.window.showErrorMessage(
      `Could not resolve the entity instantiated by ${identOf(inst.name)}.`,
    );
    return;
  }
  const e = resolved.entity;

  const stmt = doc.getText(inst.range);
  const actuals = new Map(
    readAssociations(
      stmt,
      e.ports.map((p) => p.name),
    ).map((a) => [a.formal.toLowerCase(), a.actual]),
  );
  const genericValues = new Map(
    readAssociations(
      stmt,
      e.generics.map((g) => g.name),
    ).map((a) => [a.formal, a.actual]),
  );
  for (const g of e.generics)
    if (!genericValues.has(g.name) && g.def !== undefined)
      genericValues.set(g.name, g.def);

  // The same site the single declare action uses: before the architecture's own `begin`. The
  // nearest `begin` above the instance was a process's or a function's whenever one came first.
  const site = declarationSite(doc, inst.range.start, "signal");
  if (!site) {
    vscode.window.showWarningMessage(
      "Could not find the architecture this instance is in.",
    );
    return;
  }
  const existing = await declaredNear(doc, inst.range.start);
  const decls = renderSignals(e.ports, {
    existing,
    actuals,
    genericValues,
    indent: site.indent,
  });

  if (!decls) {
    vscode.window.showInformationMessage(
      "Every actual in this port map is already declared.",
    );
    return;
  }
  await editor.edit((b) => b.insert(site.position, decls + "\n"));
}

async function fsmFromEnum(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  const en = parseEnumHover(await hoverText(doc.uri, editor.selection.active));
  if (!en) {
    vscode.window.showWarningMessage(
      "Put the cursor on an enumeration type name. The type is read from the language server's declaration of it.",
    );
    return;
  }

  // A state machine is a process, and a process does not go inside one. Saying so is the whole
  // help here: the search below fails for this too, but "could not find the architecture's
  // begin" tells the author nothing about what they did. Checked before any question is asked.
  if (sequentialHome(doc, editor.selection.active) !== null) {
    vscode.window.showWarningMessage(
      "A state machine is a process, and a process cannot go inside another one. Declare this " +
        "type in the architecture instead, or fill in the states where the `case` already is.",
    );
    return;
  }

  // The signal is a declaration and the process a concurrent statement, so they go either side
  // of the architecture's `begin`. Written as one block after the type, the process ended up
  // among the declarations, which the server rejects.
  const line = doc.lineAt(editor.selection.active.line);
  // After the whole type, which may span several lines.
  const declaredAt = endOfStatement(doc, line.lineNumber) + 1;
  const begin = architectureBegin(doc, editor.selection.active);
  if (begin === null || begin < declaredAt) {
    vscode.window.showWarningMessage(
      "A state machine is generated into an architecture. Put the cursor on an enumeration type declared in one.",
    );
    return;
  }
  const architectureIndent = indentOf(doc.lineAt(begin).text);

  const ports = flatten(await documentSymbols(doc.uri))
    .filter((s) => /^port\b/i.test(s.name))
    .map((s) => identOf(s.name));
  const clock =
    ports.find((p) => /^(clk|clock)\w*$/i.test(p)) ??
    ports.find((p) => /clk/i.test(p)) ??
    "clk";
  const reset =
    ports.find((p) => /^(rst|reset)\w*$/i.test(p)) ??
    ports.find((p) => /rst/i.test(p)) ??
    "reset";

  const style = await vscode.window.showQuickPick(
    [
      { label: "Synchronous reset", value: "sync" as const },
      { label: "Asynchronous reset", value: "async" as const },
      { label: "No reset", value: "none" as const },
    ],
    {
      placeHolder: `State machine over ${en.name} (clock ${clock}, reset ${reset})`,
    },
  );
  if (!style) return;

  const signal = await vscode.window.showInputBox({
    prompt: "State signal name",
    value: "state",
    validateInput: (v) =>
      /^[a-z]\w*$/i.test(v) ? undefined : "Must be a VHDL identifier",
  });
  if (!signal) return;

  const parts = renderFsmParts(en, {
    indent: indentOf(line.text),
    processIndent: architectureIndent + "  ",
    signal,
    clock,
    reset,
    resetStyle: style.value,
  });
  await editor.edit((b) => {
    b.insert(new vscode.Position(declaredAt, 0), parts.declaration + "\n");
    b.insert(new vscode.Position(begin + 1, 0), "\n" + parts.process + "\n");
  });
}

/**
 * The last line of the statement that starts on `from`: the first line, from there, that ends
 * one with a semicolon. A type declaration is one statement however many lines it takes.
 *
 * ponytail: comments are stripped by looking for `--`, so a `--` inside a string literal on
 * the same line as a semicolon would mislead it. A type declaration has no strings.
 */
function endOfStatement(doc: vscode.TextDocument, from: number): number {
  for (let l = from; l < doc.lineCount; l++)
    if (doc.lineAt(l).text.replace(/--.*$/, "").includes(";")) return l;
  return from;
}

/** Extract the selection into a constant or signal declared before `begin`. */
async function extractObject(
  uriArg?: vscode.Uri,
  rangeArg?: vscode.Range,
  kindArg?: "constant" | "signal",
): Promise<void> {
  // The code action raises this on a particular document. Falling back to the active editor
  // would edit whichever one has focus by the time the user answers the prompts below, which
  // is not necessarily the one the selection came from.
  const editor = uriArg
    ? await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uriArg),
      )
    : vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const range = rangeArg ?? editor.selection;
  if (range.isEmpty) {
    vscode.window.showInformationMessage(
      "Select the expression to extract first.",
    );
    return;
  }
  const expression = doc.getText(range).trim();

  const kind =
    kindArg ??
    (
      await vscode.window.showQuickPick(
        [
          { label: "constant", value: "constant" as const },
          { label: "signal", value: "signal" as const },
        ],
        { placeHolder: "Declare as" },
      )
    )?.value;
  if (!kind) return;

  const name = await vscode.window.showInputBox({
    prompt: `Name of the ${kind}`,
    value: kind === "constant" ? "c_value" : "s_value",
    validateInput: (v) =>
      /^[a-z]\w*$/i.test(v) ? undefined : "Must be a VHDL identifier",
  });
  if (!name) return;

  // The server cannot tell us the type of an arbitrary expression, so ask.
  const type = await vscode.window.showInputBox({
    prompt: `Type of ${name}`,
    value: "std_logic_vector",
  });
  if (!type) return;

  const site = declarationSite(doc, range.start, kind);
  if (!site) {
    vscode.window.showWarningMessage(
      "Could not find the architecture to declare it in.",
    );
    return;
  }
  await editor.edit((b) => {
    b.replace(range, name);
    b.insert(
      site.position,
      `${site.indent}${kind} ${name} : ${type} := ${expression};\n`,
    );
  });
}

/**
 * The process or subprogram the cursor is inside, as the line it opens on, or null.
 *
 * This is what decides whether a variable can be declared at all: a variable belongs to a
 * process or a subprogram, and a signal never does. An `end` passed on the way up means the
 * cursor is below that construct rather than inside it.
 */
function sequentialHome(
  doc: vscode.TextDocument,
  from: vscode.Position,
): number | null {
  let nested = 0;
  for (let l = from.line; l >= 0; l--) {
    const text = doc.lineAt(l).text.replace(/--.*$/, "");
    // A subprogram declared above the cursor and already closed is not the cursor's home: skip
    // the whole of it and keep looking. Giving up here lost the process around a procedure.
    if (/^\s*end\s+(process|function|procedure)\b/i.test(text)) {
      nested += 1;
      continue;
    }
    const opens =
      /^\s*(\w+\s*:\s*)?process\b/i.test(text) ||
      (/^\s*(impure\s+|pure\s+)?(function|procedure)\b/i.test(text) &&
        !/;\s*$/.test(text));
    if (!opens) continue;
    if (nested > 0) {
      nested -= 1;
      continue;
    }
    return l;
  }
  return null;
}

/**
 * The `begin` of the architecture the cursor is in, or null when it is in none: in an entity, a
 * package, or between two design units.
 *
 * Found from the architecture's header, reading forward past any subprogram bodies in its
 * declarative part. "The least indented `begin` above" picked another architecture's in a file
 * with two, and a function's in one that is not indented.
 */
function architectureBegin(
  doc: vscode.TextDocument,
  from: vscode.Position,
): number | null {
  const lines = doc.getText().split("\n");
  for (let l = from.line; l >= 0; l--) {
    const code = lines[l].replace(/--.*$/, "");
    if (l < from.line && /^\s*end\s+architecture\b/i.test(code)) return null;
    if (
      /^\s*(entity\s+\w+\s+is|package|configuration|context\s+\w+\s+is)\b/i.test(
        code,
      )
    )
      return null;
    if (/^\s*architecture\s+\w+\s+of\b/i.test(code)) return ownBegin(lines, l);
  }
  return null;
}

/**
 * The innermost `generate` or `block` the cursor is inside, both of which declare signals of
 * their own.
 *
 * A signal used only inside one belongs to it: declaring it in the architecture works but widens
 * its scope for no reason, and in a `for ... generate` it is the difference between one signal
 * and one per iteration. Which of the two is wanted is the author's call, so both are offered.
 */
function concurrentScope(
  doc: vscode.TextDocument,
  from: vscode.Position,
): { line: number; label: string; begin: number | null } | null {
  let nested = 0;
  for (let l = from.line; l >= 0; l--) {
    const text = doc.lineAt(l).text.replace(/--.*$/, "");
    if (/^\s*end\s+(generate|block)\b/i.test(text)) {
      nested += 1;
      continue;
    }
    const header = /^\s*(\w+)\s*:\s*(.*\bgenerate\b|block\b)/i.exec(text);
    // `elsif ... generate` and `else generate` continue an if-generate rather than opening one.
    if (!header || /^\s*(elsif|else|when)\b/i.test(text)) continue;
    if (nested > 0) {
      nested -= 1;
      continue;
    }
    // Its own `begin`, read forward rather than matched by indentation: a process inside it
    // has one too, and a generate with no declarations has none at all.
    const begin = ownBegin(doc.getText().split("\n"), l, true);
    return { line: l, label: header[1], begin };
  }
  return null;
}

interface DeclarationSite {
  position: vscode.Position;
  indent: string;
  /** A generate or block with no declarative part yet needs the `begin` writing too. */
  opensDeclarativePart?: boolean;
}

/**
 * Where a declaration of `kind` belongs, given where the name was used.
 *
 * `local` asks for the innermost generate or block instead of the architecture. A variable
 * ignores it: it belongs to the process or subprogram around it and nowhere else.
 */
function declarationSite(
  doc: vscode.TextDocument,
  at: vscode.Position,
  kind: ObjectKind,
  local = false,
): DeclarationSite | null {
  const site = (line: number): DeclarationSite => ({
    position: new vscode.Position(line, 0),
    indent: indentOf(doc.lineAt(line).text) + "  ",
  });

  if (kind === "variable") {
    const home = sequentialHome(doc, at);
    // The process's or subprogram's own `begin`: a procedure it declares has one first.
    const begin =
      home === null ? null : ownBegin(doc.getText().split("\n"), home);
    return begin === null ? null : site(begin);
  }
  if (local) {
    const scope = concurrentScope(doc, at);
    if (!scope) return null;
    if (scope.begin !== null) return site(scope.begin);
    // No declarations yet, so there is no `begin` either, and VHDL wants one once there are.
    return {
      position: new vscode.Position(scope.line + 1, 0),
      indent: indentOf(doc.lineAt(scope.line).text) + "  ",
      opensDeclarativePart: true,
    };
  }
  const begin = architectureBegin(doc, at);
  return begin === null ? null : site(begin);
}

/**
 * What `name` is connected to, when it is an actual in an instantiation: the port or generic it
 * feeds, and so the type it has to have. A port actual is a signal and a generic actual a
 * constant; the choice of what to declare is settled by that, not offered.
 */
async function actualOf(
  doc: vscode.TextDocument,
  name: string,
  at: vscode.Position,
): Promise<{ role: "port" | "generic"; type: string } | null> {
  const inst = await instanceAt(doc, at);
  const resolved = inst && (await resolveInstance(doc, inst));
  if (!inst || !resolved) return null;
  const text = doc.getText(inst.range);
  const generics = new Map(
    readAssociations(
      text,
      resolved.entity.generics.map((g) => g.name),
    ).map((a) => [a.formal, a.actual]),
  );
  for (const g of resolved.entity.generics)
    if (!generics.has(g.name) && g.def !== undefined)
      generics.set(g.name, g.def);
  const same = (actual: string) =>
    actual.trim().toLowerCase() === name.toLowerCase();
  for (const [role, items] of [
    ["generic", resolved.entity.generics],
    ["port", resolved.entity.ports],
  ] as const) {
    const hit = readAssociations(
      text,
      items.map((i) => i.name),
    ).find((a) => same(a.actual));
    const item = items.find(
      (i) => i.name.toLowerCase() === hit?.formal.toLowerCase(),
    );
    if (item) return { role, type: substituteGenerics(item.type, generics) };
  }
  return null;
}

/**
 * The type a name must have, worked out from where it is used.
 *
 * An actual in a port map has the type of the port it feeds, generics substituted, which is
 * exactly what the port-map action already writes. An assignment from a single name has the type
 * of that name, and from a literal the type the literal says. Anything else is left to the
 * author, as the tab stop it already was: a wrong type inserted confidently is worse than an
 * obvious placeholder.
 */
async function inferredType(
  doc: vscode.TextDocument,
  name: string,
  at: vscode.Position,
): Promise<string | undefined> {
  const actual = await actualOf(doc, name, at);
  if (actual) return actual.type;

  const line = doc.lineAt(at.line).text.replace(/--.*$/, "");

  // On the right of an assignment, the target says what this has to be: `tally <= step` makes
  // `step` whatever `tally` is. Both sides of the operator, because a name is undeclared as
  // often when it is read as when it is written.
  const target = /^\s*([A-Za-z]\w*)\s*(?:\([^)]*\))?\s*(?:<=|:=)/.exec(line);
  if (target && target[1].toLowerCase() !== name.toLowerCase()) {
    const type = await typeAt(
      doc,
      new vscode.Position(at.line, line.indexOf(target[1]) + 1),
    );
    if (type) return type;
  }

  const assigned = new RegExp(
    `^\\s*${name}\\s*(\\([^)]*\\))?\\s*(?:<=|:=)\\s*(.+?)\\s*;?\\s*$`,
    "i",
  ).exec(line);
  if (!assigned) return undefined;
  const expression = assigned[2].trim();
  const literal = typeOfLiteral(expression);
  if (literal) return literal;
  const column = line.indexOf(expression, line.indexOf(name) + name.length);
  // A function call on the right: what the function returns.
  if (/^[A-Za-z][\w.]*\s*\(.*\)$/.test(expression)) {
    const called = expression.slice(0, expression.indexOf("(")).trim();
    const hover = await hoverText(
      doc.uri,
      new vscode.Position(at.line, column + called.lastIndexOf(".") + 2),
    );
    return returnTypeOf(hover) ?? undefined;
  }
  if (!/^[A-Za-z]\w*$/.test(expression)) return undefined;
  // A name on the right: whatever the server says that one is.
  return typeAt(doc, new vscode.Position(at.line, column + 1));
}

/** The type of whatever is at `position`, as the server's declaration of it spells it. */
async function typeAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<string | undefined> {
  const hover = await hoverText(doc.uri, position);
  return /:\s*(?:in|out|inout|buffer)?\s*([A-Za-z]\w*(?:\s*\([^)]*\))?)/
    .exec(hover)?.[1]
    ?.trim();
}

/**
 * Declare a name the analyser could not resolve, in the part of the unit that can hold it.
 *
 * The type is a snippet tab stop rather than a question: the editor puts the cursor on
 * `std_logic` with it selected, so accepting the default and typing over it cost the same.
 */
async function declareObject(
  uri: vscode.Uri,
  kind: ObjectKind,
  name: string,
  anchor: vscode.Position,
  local = false,
  type?: string,
): Promise<void> {
  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(uri),
  );
  const site = declarationSite(editor.document, anchor, kind, local);
  if (!site) {
    vscode.window.showWarningMessage(
      `Could not find the declarative part a ${kind} would go in.`,
    );
    return;
  }
  const opening = site.opensDeclarativePart
    ? `${indentOf(editor.document.lineAt(site.position.line - 1).text)}begin\n`
    : "";
  await editor.insertSnippet(
    new vscode.SnippetString(
      renderDeclaration(kind, name, site.indent, type) + "\n" + opening,
    ),
    site.position,
  );
}

/** The `case` statement the cursor is in: the line it opens on and what it selects. */
function caseAt(
  doc: vscode.TextDocument,
  at: vscode.Position,
): { line: number; selector: string } | null {
  let nested = 0;
  for (let l = at.line; l >= 0; l--) {
    const text = doc.lineAt(l).text.replace(/--.*$/, "");
    if (l !== at.line && /\bend\s+case\b/i.test(text)) {
      nested += 1;
      continue;
    }
    const selector = caseSelector(text);
    if (!selector) continue;
    if (nested === 0) return { line: l, selector };
    nested -= 1;
  }
  return null;
}

/** The body of the case opening on `from`, and the line its `end case` is on. */
function caseBody(
  doc: vscode.TextDocument,
  from: number,
): { text: string; endLine: number; othersLine?: number } | null {
  let depth = 1;
  let othersLine: number | undefined;
  const lines: string[] = [];
  for (let l = from + 1; l < doc.lineCount; l++) {
    const text = doc.lineAt(l).text.replace(/--.*$/, "");
    if (/\bend\s+case\b/i.test(text)) {
      depth -= 1;
      if (depth === 0) return { text: lines.join("\n"), endLine: l, othersLine };
    } else if (caseSelector(text)) {
      depth += 1;
    } else if (depth === 1 && /^\s*when\s+others\b/i.test(text)) {
      othersLine ??= l;
    }
    lines.push(text);
  }
  return null;
}

/**
 * The enumeration a case selector has as its type, or null when it has none.
 *
 * Null covers both a selector that is not an enumeration and one that does not exist: neither
 * has states to offer, and nothing here invents any.
 */
async function enumOfSelector(
  doc: vscode.TextDocument,
  at: vscode.Position,
  name: string,
): Promise<EnumType | null> {
  const direct = parseEnumHover(await hoverText(doc.uri, at));
  if (direct) return direct;

  // Before the statement is finished the design unit does not analyse and the server has nothing
  // to say about the selector, which is the one moment this is for. The declaration is in the
  // file, so read it from there.
  const fromText = enumFromSource(doc.getText(), name);
  if (fromText) return fromText;

  // `signal state : t_state;` names the type but does not list its literals, so the selector's
  // declaration is opened and the type name in it hovered in its turn. Asking the workspace
  // symbol index for the type instead found nothing: a type is not a design unit.
  const locations =
    (await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >("vscode.executeDefinitionProvider", doc.uri, at)) ?? [];
  for (const loc of locations) {
    const uri = "uri" in loc ? loc.uri : loc.targetUri;
    const range =
      "range" in loc
        ? loc.range
        : (loc.targetSelectionRange ?? loc.targetRange);
    const declaration = await vscode.workspace.openTextDocument(uri);
    const line = declaration.lineAt(range.start.line).text.replace(/--.*$/, "");
    const colon = line.indexOf(":");
    const type =
      colon < 0 ? null : /^\s*([A-Za-z]\w*)/.exec(line.slice(colon + 1))?.[1];
    if (!type) continue;
    const found = parseEnumHover(
      await hoverText(
        uri,
        new vscode.Position(range.start.line, line.indexOf(type, colon) + 1),
      ),
    );
    if (found) return found;
  }
  return null;
}

// --- providers -------------------------------------------------------------

class InstanceCompletion extends vscode.CompletionItem {
  constructor(
    readonly sym: Sym,
    label: string | vscode.CompletionItemLabel,
    readonly doc: vscode.TextDocument,
    readonly unitLine: number,
    /** The label is already typed, so the snippet starts at the entity name. */
    readonly omitLabel = false,
  ) {
    super(label, vscode.CompletionItemKind.Module);
  }
}

class ComponentCompletion extends vscode.CompletionItem {
  constructor(
    readonly component: ComponentDecl,
    label: string | vscode.CompletionItemLabel,
    readonly omitLabel = false,
  ) {
    super(label, vscode.CompletionItemKind.Class);
  }
}

class ImportCompletion extends vscode.CompletionItem {
  constructor(
    readonly candidate: UseCandidate,
    readonly doc: vscode.TextDocument,
    readonly unitLine: number,
    label: string | vscode.CompletionItemLabel,
    kind: vscode.CompletionItemKind,
  ) {
    super(label, kind);
  }
}

/**
 * Two things vhdl_ls does not complete: a whole instantiation, and a name from
 * a package this unit has not made visible yet, which is inserted together with
 * its use clause. Both are resolved lazily so typing costs one symbol query.
 */
const vhdlCompletions: vscode.CompletionItemProvider = {
  async provideCompletionItems(document, position) {
    const lineToCursor = document
      .lineAt(position.line)
      .text.slice(0, position.character);
    if (/--/.test(lineToCursor)) return [];

    const unitLine = await designUnitLine(document, position);
    const items: vscode.CompletionItem[] = [];
    // An instantiation is a concurrent statement: below the architecture's `begin`, outside any
    // process or subprogram. Elsewhere `clk : in` is a port and `cou` is a signal being typed,
    // and an instantiation offered there is one accepted by accident.
    const statementPart = architectureBegin(document, position);
    const concurrent =
      statementPart !== null &&
      statementPart < position.line &&
      sequentialHome(document, position) === null;

    // What is being typed decides what is offered. A label and a colon want an instantiation,
    // from every library or from the one being named; a bare word at the start of a statement
    // wants that too, with a label supplied.
    const context = instantiationContext(lineToCursor);
    const instantiating =
      context !== null &&
      concurrent &&
      (context.kind === "label" ||
        context.typed.includes(".") ||
        context.typed.length >= 2);
    if (context && instantiating) await instantiations(context);

    // Anywhere an identifier is being typed, it can be a name from a package the design unit
    // cannot see yet, offered with the use clause that makes it visible. Not after a label and a
    // colon, where what comes next is an instantiation or a keyword.
    const wordRange = document.getWordRangeAtPosition(position);
    const prefix = wordRange
      ? document.getText(wordRange.with(undefined, position))
      : "";
    const before = document.getText(
      new vscode.Range(
        new vscode.Position(Math.max(0, position.line - 200), 0),
        position,
      ),
    );
    if (
      prefix.length >= 2 &&
      context?.kind !== "label" &&
      !declaresName(before)
    )
      await imports(prefix);

    // Incomplete only while an instantiation is being typed, so the match text can follow the
    // form it takes; an import list is filtered by the editor as usual.
    return new vscode.CompletionList(items, instantiating);

    async function instantiations(
      context: InstantiationContext,
    ): Promise<void> {
      const replace = new vscode.Range(
        new vscode.Position(position.line, context.from),
        position,
      );

      // The editor ranks by how well what was typed matches, before any sort order, and VHDL-LS
      // has rows of its own here (`fifo_inst: entity work.fifo`). So the text matched against is
      // the form being typed: `fif` against `fifo`, `myl.fi` against `mylib.fifo`, `entity o.le`
      // against `entity other.leaf`. The list is incomplete, so the editor asks again as the form
      // changes, and each of those is a prefix match that ranks with the best.
      const typed = context.typed.toLowerCase();
      const matchText = (lib: string, name: string) =>
        typed.startsWith("entity ") || typed === "entity"
          ? `entity ${lib}.${name}`
          : typed.includes(".")
            ? `${lib}.${name}`
            : name;

      if (concurrent) {
        const entities = await cachedEntities();
        for (const s of entities) {
          const name = identOf(s.name);
          const lib = libraryOf(s);
          const item = new InstanceCompletion(
            s,
            { label: name, description: `instantiate ${lib}.${name}` },
            document,
            unitLine,
            context.kind === "label",
          );
          item.detail = `instantiate ${lib}.${name}`;
          item.range = replace;
          item.filterText = matchText(lib, name);
          item.sortText = `0_${name}`;
          items.push(item);
        }

        // A component is instantiated by its bare name, and only one declared in this file can
        // be: a component declared somewhere else is not visible here, and instantiating it is an
        // error the server reports as soon as it is accepted.
        if (!typed.includes(".") && !typed.startsWith("entity")) {
          for (const c of await componentsIn(document.uri)) {
            const item = new ComponentCompletion(
              c,
              { label: c.name, description: "instantiate component" },
              context.kind === "label",
            );
            item.detail = `instantiate component ${c.name}`;
            item.range = replace;
            item.filterText = c.name;
            // Declaring a component says it is the one to instantiate: first among equals.
            item.sortText = `0_0_${c.name}`;
            items.push(item);
          }
        }
      }
    }

    async function imports(prefix: string): Promise<void> {
      const syms = (await workspaceSymbols(prefix)) ?? [];
      const visible = visiblePackages(document.getText().split("\n"), unitLine);
      const seen = new Set<string>();
      const packages = new Map<string, boolean>();
      const own = syms.length
        ? (await libraryOfFile(document.uri))?.toLowerCase()
        : undefined;
      for (const s of syms) {
        if (isEntitySymbol(s) || s.kind === vscode.SymbolKind.Interface)
          continue;
        const designator = designatorOf(s.name);
        const parts = (s.containerName ?? "").split(".");
        if (!designator || parts.length < 2) continue;
        const [library, pkg] = parts;
        if (visible.has(`${library}.${pkg}`.toLowerCase())) continue;
        if (!usablePackage(library, pkg)) continue;
        const key = `${designator}:${library}.${pkg}`.toLowerCase();
        if (seen.has(key)) continue;
        const pkgKey = `${library}.${pkg}`.toLowerCase();
        if (!packages.has(pkgKey))
          packages.set(pkgKey, await isPackage(library, pkg));
        if (!packages.get(pkgKey)) continue;
        seen.add(key);

        // In the case the author is typing in. The editor scores case-sensitively, so
        // `TO_UNSIGNED` from NUMERIC_STD lost to `to_unsigned` from a generic package on a
        // lower-case keystroke, and VHDL does not care which one is written.
        const name =
          prefix === prefix.toUpperCase() && prefix !== prefix.toLowerCase()
            ? designator.toUpperCase()
            : prefix === prefix.toLowerCase()
              ? designator.toLowerCase()
              : designator;
        // What accepting it writes: the file's own library is `work`.
        const shown = library.toLowerCase() === own ? "work" : library;
        const item = new ImportCompletion(
          { library, pkg, describes: s.name },
          document,
          unitLine,
          { label: name, description: `${shown}.${pkg}` },
          completionKindOf(s.kind),
        );
        item.insertText = name;
        item.filterText = name;
        item.detail = `${shown}.${pkg}`;
        item.documentation = new vscode.MarkdownString(
          `${s.name}\n\nAdds \`use ${shown}.${pkg}.all;\``,
        );
        // Equal scores then fall to this: the package people mean before the ones they do not.
        item.sortText = `zzy_${useRank(library, pkg)}_${library}_${pkg}_${name}`;
        items.push(item);
      }
    }
  },

  async resolveCompletionItem(item) {
    if (item instanceof ComponentCompletion) {
      const c = parseEntityHover(
        await hoverText(item.component.uri, item.component.position),
      );
      if (!c) return item;
      c.kind = "component";
      item.insertText = new vscode.SnippetString(
        renderInstance(c, {
          label: `i_${c.name}`,
          indent: "",
          snippet: true,
          omitLabel: item.omitLabel,
        }),
      );
      item.documentation = new vscode.MarkdownString().appendCodeblock(
        renderInstance(c, { indent: "" }),
        "vhdl",
      );
      return item;
    }

    if (item instanceof InstanceCompletion) {
      const lib = libraryOf(item.sym);
      const e = await entityAt(
        item.sym.location.uri,
        item.sym.location.range.start,
        lib,
      );
      if (!e) return item;
      const home = await libraryFor(item.doc, item.unitLine, lib);
      item.insertText = new vscode.SnippetString(
        renderInstance(e, {
          label: `i_${e.name}`,
          indent: "",
          snippet: true,
          library: home.name,
          omitLabel: item.omitLabel,
        }),
      );
      item.documentation = new vscode.MarkdownString().appendCodeblock(
        renderInstance(e, { indent: "", library: home.name }),
        "vhdl",
      );
      // The clause the name needs, added with the instance the way an import adds its `use`.
      if (home.edit)
        item.additionalTextEdits = [
          vscode.TextEdit.insert(
            new vscode.Position(home.edit.line, 0),
            home.edit.text,
          ),
        ];
      return item;
    }

    if (item instanceof ImportCompletion) {
      // The file's own library is `work`, as the quick fix writes it.
      const own = (await libraryOfFile(item.doc.uri))?.toLowerCase();
      const library =
        item.candidate.library.toLowerCase() === own
          ? "work"
          : item.candidate.library;
      item.detail = `${library}.${item.candidate.pkg}`;
      const edit = contextClauseEdit(
        item.doc.getText().split("\n"),
        item.unitLine,
        library,
        item.candidate.pkg,
      );
      if (edit)
        item.additionalTextEdits = [
          vscode.TextEdit.insert(new vscode.Position(edit.line, 0), edit.text),
        ];
    }
    return item;
  },
};

/** The two enums do not line up, so map the ones VHDL actually produces. */
function completionKindOf(kind: vscode.SymbolKind): vscode.CompletionItemKind {
  switch (kind) {
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Method:
      return vscode.CompletionItemKind.Function;
    case vscode.SymbolKind.Constant:
      return vscode.CompletionItemKind.Constant;
    case vscode.SymbolKind.Enum:
      return vscode.CompletionItemKind.Enum;
    case vscode.SymbolKind.EnumMember:
      return vscode.CompletionItemKind.EnumMember;
    case vscode.SymbolKind.Struct:
    case vscode.SymbolKind.Class:
      return vscode.CompletionItemKind.Struct;
    case vscode.SymbolKind.Interface:
      return vscode.CompletionItemKind.Interface;
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Package:
      return vscode.CompletionItemKind.Module;
    default:
      return vscode.CompletionItemKind.Variable;
  }
}

const MAX_HINT = 40;

/** Port direction and type next to each actual in a port or generic map. */
const portMapHints: vscode.InlayHintsProvider = {
  async provideInlayHints(document, range) {
    const instances = (await instanceSymbols(document)).filter((s) =>
      s.range.intersection(range),
    );

    const hints: vscode.InlayHint[] = [];
    for (const inst of instances) {
      const resolved = await resolveInstance(document, inst);
      if (!resolved) continue;
      const text = document.getText(inst.range);
      const base = document.offsetAt(inst.range.start);

      for (const group of [resolved.entity.generics, resolved.entity.ports]) {
        for (const a of readAssociations(
          text,
          group.map((i) => i.name),
        )) {
          const item = group.find(
            (i) => i.name.toLowerCase() === a.formal.toLowerCase(),
          );
          if (!item) continue;
          let label = `${item.dir ? `${item.dir} ` : ""}${item.type}`;
          if (label.length > MAX_HINT)
            label = label.slice(0, MAX_HINT - 1) + "…";
          const hint = new vscode.InlayHint(
            document.positionAt(base + a.start),
            `${label} `,
            vscode.InlayHintKind.Type,
          );
          hint.paddingRight = true;
          hints.push(hint);
        }
      }
    }
    return hints;
  },
};

/**
 * Quick fixes: a use clause per package that declares an unresolved name, the
 * formals an instantiation has not mapped, and extracting a selection.
 */
const vhdlCodeActions: vscode.CodeActionProvider = {
  async provideCodeActions(document, range, context) {
    // Only the kinds asked for: VS Code drops the rest and logs a warning for each one, and asked
    // for a source action or the speja menu, nothing here is wanted and none of it need be worked out.
    const wants = (kind: vscode.CodeActionKind) =>
      !context.only || context.only.contains(kind) || kind.contains(context.only);
    const quickFixes = wants(vscode.CodeActionKind.QuickFix);
    const extract = wants(vscode.CodeActionKind.RefactorExtract);
    if (!quickFixes && !extract) return [];
    const actions: vscode.CodeAction[] = [];
    const lines = document.getText().split("\n");

    // Only the name under the cursor. The editor hands over every diagnostic that touches the
    // requested range, and on a line with two unresolved names that is both of them: asking
    // about one and being offered declarations for the other is what "the wrong symbol" feels
    // like from the keyboard.
    const underCursor = context.diagnostics.filter(
      (d) =>
        quickFixes &&
        d.code === "unresolved" &&
        range.intersection(d.range) !== undefined,
    );

    // A package the file's own library holds is `work.pkg`, with no library clause: that is how
    // hdl-modules and tsfpga write it, and how an instantiation from the same library is written.
    const ownLibrary = underCursor.length
      ? (await libraryOfFile(document.uri))?.toLowerCase()
      : undefined;
    const exported = new Set<vscode.Diagnostic>();

    for (const diagnostic of underCursor) {
      const name = document.getText(diagnostic.range);
      if (!/^[A-Za-z]\w*$/.test(name)) continue;
      const unitLine = await designUnitLine(document, diagnostic.range.start);

      const candidates = await findDeclaringPackages(name);
      if (candidates.length) exported.add(diagnostic);
      for (const c of candidates) {
        const library =
          c.library.toLowerCase() === ownLibrary ? "work" : c.library;
        const edit = contextClauseEdit(lines, unitLine, library, c.pkg);
        if (!edit) continue;
        const action = new vscode.CodeAction(
          `Add use ${library}.${c.pkg}.all`,
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = applyContextEdit(document, edit);
        action.diagnostics = [diagnostic];
        // The first candidate is the ranked one, and "preferred" is what an editor applies on
        // its auto-fix keystroke rather than asking.
        action.isPreferred = c === candidates[0];
        actions.push(action);
      }
    }
    // The ranked offers are what the index matched by exact name. When the package wanted is not
    // among them, the searchable list is one step away rather than a palette command away.
    if (
      underCursor.some((d) => /^[A-Za-z]\w*$/.test(document.getText(d.range)))
    ) {
      const search = new vscode.CodeAction(
        "Search Every Package for a Use Clause...",
        vscode.CodeActionKind.QuickFix,
      );
      search.command = {
        command: "speja.addUseClause",
        title: search.title,
      };
      actions.push(search);
    }

    // A name the analyser could not resolve is either missing an import, offered above, or
    // missing a declaration. Which declarations are legal depends on where the cursor is, so
    // only those are offered: a variable inside a process, a signal outside one.
    for (const diagnostic of underCursor) {
      const name = document.getText(diagnostic.range);
      if (!/^[A-Za-z]\w*$/.test(name)) continue;
      // A name a package exports is that package's, and the use clause above is the fix.
      // Declaring a local object of the same name would shadow it, which nobody asks for by
      // accident: `clamp` is a function and `m_idle` an enumeration literal, not a signal.
      if (exported.has(diagnostic)) continue;
      // Where a type goes, `x : t` or `array (...) of t`, the name is a type, and no object
      // declaration can stand in for one.
      const before = document
        .lineAt(diagnostic.range.start.line)
        .text.slice(0, diagnostic.range.start.character)
        .replace(/--.*$/, "");
      if (
        /(:\s*(in|out|inout|buffer|linkage)?|\bof|\bsubtype\s+\w+\s+is)\s*$/i.test(
          before,
        )
      )
        continue;
      // Before `=>` in a map it is the formal, the other entity's port or generic. A local
      // object of that name changes nothing; the spelling is what is wrong.
      const after = document
        .lineAt(diagnostic.range.end.line)
        .text.slice(diagnostic.range.end.character);
      if (/^\s*=>/.test(after)) continue;
      // Connected to a port it is a signal, to a generic a constant, and nothing else is
      // offered: a constant on a port or a signal on a generic is not a choice, it is an error.
      // A sensitivity list takes signals and nothing else.
      const actual = await actualOf(document, name, diagnostic.range.start);
      const sensitivity = /\bprocess\s*\([^)]*$/i.test(before);
      const kinds: ObjectKind[] = actual
        ? [actual.role === "port" ? "signal" : "constant"]
        : sensitivity
          ? ["signal"]
          : declarableKinds(
              sequentialHome(document, diagnostic.range.start) !== null,
              assignmentKind(
                document.lineAt(diagnostic.range.start.line).text,
                name,
              ),
            );
      const type =
        actual?.type ??
        (await inferredType(document, name, diagnostic.range.start));
      // A signal used inside a generate or a block can belong to it or to the architecture, and
      // only the author knows which. Both are offered, the nearer scope first.
      const scope =
        kinds.includes("variable") && kinds.length === 1
          ? null
          : concurrentScope(document, diagnostic.range.start);
      for (const kind of kinds) {
        const places: [boolean, string][] =
          scope && kind !== "variable"
            ? [
                [true, ` in ${scope.label}`],
                [false, " in the architecture"],
              ]
            : [[false, ""]];
        for (const [local, where] of places) {
          if (!declarationSite(document, diagnostic.range.start, kind, local))
            continue;
          const action = new vscode.CodeAction(
            `Declare ${kind} ${name}${where}`,
            vscode.CodeActionKind.QuickFix,
          );
          action.command = {
            command: "speja.declareObject",
            title: action.title,
            arguments: [
              document.uri,
              kind,
              name,
              diagnostic.range.start,
              local,
              type,
            ],
          };
          action.diagnostics = [diagnostic];
          actions.push(action);
        }
      }
    }

    const inst = quickFixes ? await instanceAt(document, range.start) : null;
    if (inst) {
      const resolved = await resolveInstance(document, inst);
      const text = document.getText(inst.range);
      const shape = resolved && portMapShape(text);
      if (resolved && shape) {
        const associated = readAssociations(
          text,
          resolved.entity.ports.map((p) => p.name),
        ).map((a) => a.formal);
        const missing = missingFormals(resolved.entity.ports, associated);
        if (missing.length) {
          const action = new vscode.CodeAction(
            `Map ${missing.length} missing port${missing.length > 1 ? "s" : ""}`,
            vscode.CodeActionKind.QuickFix,
          );
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            document.uri,
            document.positionAt(
              document.offsetAt(inst.range.start) + shape.insertAt,
            ),
            renderMissingAssociations(missing, shape.indent, shape.hasEntries),
          );
          action.edit = edit;
          actions.push(action);
        }

        // The actuals of a port map are the signals that wire this instance to the next one,
        // and typing them out by hand is the part of instantiating an entity that is pure
        // transcription. Only the ones not already declared are counted.
        const declared = await declaredNear(document, inst.range.start);
        const undeclared = renderSignals(resolved.entity.ports, {
          existing: declared,
          actuals: new Map(
            readAssociations(
              text,
              resolved.entity.ports.map((p) => p.name),
            ).map((a) => [a.formal.toLowerCase(), a.actual]),
          ),
        });
        if (undeclared) {
          const count = undeclared.split("\n").length;
          const action = new vscode.CodeAction(
            `Declare ${count} signal${count > 1 ? "s" : ""} for this port map`,
            vscode.CodeActionKind.QuickFix,
          );
          action.command = {
            command: "speja.declareSignals",
            title: action.title,
            arguments: [document.uri, inst.range.start],
          };
          actions.push(action);
        }
      }
    }

    // A `case` is where a state machine starts. Which action helps depends on whether the thing
    // being selected on exists yet: fill in the states it can be in, or make it exist at all.
    const sel = quickFixes ? caseAt(document, range.start) : null;
    if (sel) {
      const header = document.lineAt(sel.line);
      const at = new vscode.Position(
        sel.line,
        header.text.indexOf(sel.selector),
      );
      const literals = /^[a-z]\w*$/i.test(sel.selector)
        ? await enumOfSelector(document, at, sel.selector)
        : null;
      const body = caseBody(document, sel.line);
      const missing = literals
        ? missingChoices(body?.text ?? "", literals.literals)
        : [];

      if (literals && missing.length) {
        const indent = indentOf(header.text);
        const arms = renderWhenChoices(missing, indent + "  ");
        const edit = new vscode.WorkspaceEdit();
        if (body) {
          // `others` has to stay the last choice, so the new arms go above it.
          const at = body.othersLine ?? body.endLine;
          edit.insert(
            document.uri,
            new vscode.Position(at, 0),
            body.othersLine === undefined ? arms : `${arms}\n`,
          );
        } else {
          // Nothing written after the selector yet, so the statement is finished as well as
          // filled: `is` if it is missing, the arms, and the `end case` to close it. The text is
          // put after the code on the line rather than after a trailing comment.
          const code = header.text.replace(/--.*$/, "").trimEnd();
          const needsIs = !/\bis$/i.test(code);
          edit.insert(
            document.uri,
            new vscode.Position(sel.line, code.length),
            `${needsIs ? " is" : ""}\n${arms}${indent}end case;`,
          );
        }
        const action = new vscode.CodeAction(
          body
            ? `Add ${missing.length} missing when choice${missing.length > 1 ? "s" : ""}`
            : `Write the ${missing.length} states of ${sel.selector}`,
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = edit;
        actions.push(action);
      }
      // Nothing is offered for a selector that does not exist, or is not an enumeration. There
      // are no states to infer from a name: an author who has not declared it has not decided
      // what its states are either, and guessing three would be putting words in their mouth.
    }

    // Only when refactorings are wanted: asked for quick fixes, VS Code drops these and logs a
    // warning for every one, which filled the extension host log on every lightbulb.
    if (!range.isEmpty && extract) {
      for (const kind of ["constant", "signal"] as const) {
        const action = new vscode.CodeAction(
          `Extract to ${kind}`,
          vscode.CodeActionKind.RefactorExtract,
        );
        action.command = {
          command: "speja.extractObject",
          title: `Extract to ${kind}`,
          arguments: [document.uri, range, kind],
        };
        actions.push(action);
      }
    }
    const titles = new Set<string>();
    return actions.filter((a) => !titles.has(a.title) && titles.add(a.title));
  },
};

/** How many places refer to each entity declared in the file. */
const entityLenses: vscode.CodeLensProvider = {
  async provideCodeLenses(document) {
    const entities = flatten(await documentSymbols(document.uri)).filter(
      isEntitySymbol,
    );
    const lenses: vscode.CodeLens[] = [];

    for (const e of entities) {
      const position = e.selectionRange.start;
      const locations =
        (await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          document.uri,
          position,
        )) ?? [];
      const others = locations.filter(
        (l) =>
          l.uri.toString() !== document.uri.toString() ||
          !e.selectionRange.contains(l.range.start),
      );
      lenses.push(
        new vscode.CodeLens(e.selectionRange, {
          title:
            others.length === 1 ? "1 reference" : `${others.length} references`,
          command: "editor.action.showReferences",
          arguments: [document.uri, position, others],
        }),
      );
    }
    return lenses;
  },
};

/** The port list of the entity being instantiated, while the map is typed. */
const portMapSignatures: vscode.SignatureHelpProvider = {
  async provideSignatureHelp(document, position) {
    const inst = await instanceAt(document, position);
    if (!inst) return undefined;
    const resolved = await resolveInstance(document, inst);
    if (!resolved || !resolved.entity.ports.length) return undefined;

    const e = resolved.entity;
    const signature = new vscode.SignatureInformation(
      `${e.library}.${e.name} port map (${e.ports.map((p) => p.name).join(", ")})`,
    );
    signature.parameters = e.ports.map(
      (p) =>
        new vscode.ParameterInformation(
          p.name,
          new vscode.MarkdownString(`\`${p.name} : ${p.dir ?? ""} ${p.type}\``),
        ),
    );

    const typed = document.getText(
      new vscode.Range(inst.range.start, position),
    );
    const lastFormal = [...typed.matchAll(/(\w+)\s*=>/g)].pop()?.[1];
    const active = lastFormal
      ? e.ports.findIndex(
          (p) => p.name.toLowerCase() === lastFormal.toLowerCase(),
        )
      : -1;

    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = active >= 0 ? active : 0;
    return help;
  },
};

// --- design hierarchy ------------------------------------------------------

interface HierarchyNode {
  label: string;
  description: string;
  uri: vscode.Uri;
  position: vscode.Position;
  /** Entity node; instance nodes carry the entity they resolve to. */
  entity: boolean;
}

/**
 * ponytail: the roots are every entity in the workspace, not only the ones
 * nothing instantiates. Filtering to true top levels costs a references request
 * per entity on every refresh, which is not worth it until someone asks.
 */
export class DesignHierarchy implements vscode.TreeDataProvider<HierarchyNode> {
  private changed = new vscode.EventEmitter<HierarchyNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    resolvedInstances.clear();
    this.changed.fire(undefined);
  }

  getTreeItem(node: HierarchyNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(
      node.entity ? "symbol-module" : "circuit-board",
    );
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        node.uri,
        { selection: new vscode.Range(node.position, node.position) },
      ],
    };
    return item;
  }

  async getChildren(node?: HierarchyNode): Promise<HierarchyNode[]> {
    if (!node) {
      const entities = await projectEntities();
      return entities
        .map((s) => ({
          label: identOf(s.name),
          description: libraryOf(s),
          uri: s.location.uri,
          position: s.location.range.start,
          entity: true,
        }))
        .sort((a, b) =>
          compareCandidates(
            { library: a.description, pkg: a.label },
            { library: b.description, pkg: b.label },
          ),
        );
    }

    // Architectures of this entity, then the instances each one contains.
    const architectures =
      (await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeImplementationProvider",
        node.uri,
        node.position,
      )) ?? [];

    const children: HierarchyNode[] = [];
    for (const arch of architectures) {
      const doc = await vscode.workspace.openTextDocument(arch.uri);
      const symbols = flatten(await documentSymbols(arch.uri));
      const body = symbols.find(
        (s) => isArchitecture(s) && s.range.contains(arch.range.start),
      );
      if (!body) continue;

      for (const inst of body.children.filter(isInstance)) {
        const resolved = await resolveInstance(doc, inst);
        children.push({
          label: identOf(inst.name),
          description: resolved
            ? `${resolved.entity.library}.${resolved.entity.name}`
            : "unresolved",
          uri: resolved?.uri ?? arch.uri,
          position: resolved?.position ?? inst.range.start,
          entity: false,
        });
      }
    }
    return children;
  }
}

/**
 * The editing features: commands, providers and the design hierarchy.
 *
 * Every one of them asks the VHDL language server what a name means, so all of them are quiet
 * when no such server is running. The lint and format features of this extension do not depend
 * on any of it and keep working either way.
 */
export function registerEditingFeatures(
  context: vscode.ExtensionContext,
): void {
  const hierarchy = new DesignHierarchy();
  // The view only makes sense once the workspace actually holds VHDL.
  vscode.workspace
    .findFiles("**/*.{vhd,vhdl}", "**/node_modules/**", 1)
    .then((found) =>
      vscode.commands.executeCommand(
        "setContext",
        "speja.hasVhdl",
        found.length > 0,
      ),
    );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "speja.instantiateEntity",
      instantiateEntity,
    ),
    vscode.commands.registerCommand("speja.declareSignals", declareSignals),
    vscode.commands.registerCommand("speja.fsmFromEnum", fsmFromEnum),
    vscode.commands.registerCommand("speja.addUseClause", addUseClause),
    vscode.commands.registerCommand(
      "speja.componentDeclaration",
      componentDeclaration,
    ),
    vscode.commands.registerCommand("speja.extractObject", extractObject),
    vscode.commands.registerCommand("speja.declareObject", declareObject),
    vscode.commands.registerCommand(
      "speja.internal.editingActions",
      async (
        uri: vscode.Uri,
        range: vscode.Range,
        diagnostics: vscode.Diagnostic[],
      ) => {
        const document = await vscode.workspace.openTextDocument(uri);
        return vhdlCodeActions.provideCodeActions(
          document,
          range,
          {
            diagnostics,
            only: undefined,
            triggerKind: vscode.CodeActionTriggerKind.Invoke,
          },
          new vscode.CancellationTokenSource().token,
        );
      },
    ),
    vscode.commands.registerCommand("speja.declare", () =>
      actionsAtCursor(
        /^Declare (signal|variable|constant) /,
        "Nothing to declare here: put the cursor on a name the language server reports as undeclared.",
      ),
    ),
    vscode.commands.registerCommand("speja.mapMissingPorts", () =>
      actionsAtCursor(
        /^Map \d+ missing ports?$/,
        "No missing ports: put the cursor in an instantiation.",
      ),
    ),
    vscode.commands.registerCommand("speja.completeCase", () =>
      actionsAtCursor(
        /^(Add \d+ missing when choices?|Write the \d+ states of )/,
        "Put the cursor on a case whose selector is an enumeration.",
      ),
    ),
    vscode.commands.registerCommand(
      "speja.removeUnusedUseClauses",
      removeUnusedUseClauses,
    ),
    vscode.commands.registerCommand("speja.refreshHierarchy", () =>
      hierarchy.refresh(),
    ),

    // `:` and `.` open the list where an instantiation is being typed; the space after the
    // colon is the moment the author expects it, so it is a trigger too. Anything else typed
    // reaches the provider as ordinary completion.
    vscode.languages.registerCompletionItemProvider(
      "vhdl",
      vhdlCompletions,
      ":",
      ".",
      " ",
    ),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.languageId === "vhdl") forgetDesignIndex();
    }),
    vscode.languages.registerInlayHintsProvider("vhdl", portMapHints),
    vscode.languages.registerCodeActionsProvider("vhdl", vhdlCodeActions, {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorExtract,
      ],
    }),
    vscode.languages.registerCodeLensProvider("vhdl", entityLenses),
    vscode.languages.registerSignatureHelpProvider(
      "vhdl",
      portMapSignatures,
      "(",
      ",",
    ),
    vscode.window.registerTreeDataProvider("speja.hierarchy", hierarchy),
  );
}
