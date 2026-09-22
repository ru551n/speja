import * as vscode from "vscode";
import {
  ContextEdit,
  EntityIface,
  EnumType,
  ObjectKind,
  caseSelector,
  assignmentKind,
  declarableKinds,
  missingChoices,
  renderDeclaration,
  renderStateDeclarations,
  renderWhenChoices,
  compareCandidates,
  contextClause,
  contextClauseEdit,
  designatorOf,
  missingFormals,
  parseEntityHover,
  parseEnumHover,
  readAssociations,
  renderComponent,
  renderFsmParts,
  renderInstance,
  renderMissingAssociations,
  renderSignals,
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
    "No VHDL language server answered. These editing commands read entity and type information from VHDL-LS (rust_hdl); install it and give this workspace a vhdl_ls.toml. Lint and format do not need it.",
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

  if (found) {
    if (resolvedInstances.size > 400) resolvedInstances.clear();
    resolvedInstances.set(key, found);
  }
  return found;
}

/** The instantiation statement containing `position`, innermost first. */
async function instanceAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.DocumentSymbol | undefined> {
  return flatten(await documentSymbols(doc.uri))
    .filter((s) => isInstance(s) && s.range.contains(position))
    .sort((a, b) => (a.range.contains(b.range) ? 1 : -1))[0];
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

  for (const s of syms) {
    if ((designatorOf(s.name) ?? "").toLowerCase() !== name.toLowerCase())
      continue;
    const parts = (s.containerName ?? "").split(".");
    if (parts.length < 2) continue;
    const [library, pkg] = parts;
    const key = `${library}.${pkg}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ library, pkg, describes: s.name });
  }
  return out.sort(compareCandidates);
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

async function addUseClause(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  const range = doc.getWordRangeAtPosition(editor.selection.active);
  if (!range) {
    vscode.window.showWarningMessage(
      "Put the cursor on a name to make visible.",
    );
    return;
  }
  const name = doc.getText(range);

  const candidates = await findDeclaringPackages(name);
  if (!candidates.length) {
    vscode.window.showInformationMessage(
      `No package known to the language server declares '${name}'.`,
    );
    return;
  }

  const unitLine = await designUnitLine(doc, editor.selection.active);
  const lines = doc.getText().split("\n");

  const usable = candidates
    .map((c) => ({
      c,
      edit: contextClauseEdit(lines, unitLine, c.library, c.pkg),
    }))
    .filter((x) => x.edit !== null) as { c: UseCandidate; edit: ContextEdit }[];

  if (!usable.length) {
    vscode.window.showInformationMessage(`'${name}' is already visible here.`);
    return;
  }

  const chosen =
    usable.length === 1
      ? usable[0]
      : await vscode.window.showQuickPick(
          usable.map((x) => ({
            label: `${x.c.library}.${x.c.pkg}`,
            description: x.c.describes,
            detail: x.edit.text.trim().split("\n").join("  "),
            ...x,
          })),
          {
            placeHolder: `Package declaring '${name}'`,
            matchOnDescription: true,
          },
        );
  if (!chosen) return;

  await vscode.workspace.applyEdit(applyContextEdit(doc, chosen.edit));
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

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "VHDL: checking context clauses",
    },
    async () => {
      for (const unit of units) {
        const clauses = contextClause(lines, unit.range.start.line).filter(
          (c) => c.kind === "use",
        );
        if (!clauses.length) continue;

        // Identifiers written in the unit itself, each looked up once.
        const body = doc.getText(unit.range);
        const words = new Set(
          [...body.matchAll(/[A-Za-z]\w*/g)].map((m) => m[0].toLowerCase()),
        );

        const used = new Set<string>();
        for (const w of words)
          for (const c of await findDeclaringPackages(w))
            used.add(`${c.library}.${c.pkg}`.toLowerCase());

        for (const clause of clauses) {
          if (clause.names.every((n) => used.has(n))) continue;
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
      .map((s) => ({
        label: identOf(s.name),
        description: `${libraryOf(s)}.${identOf(s.name)}`,
        detail: vscode.workspace.asRelativePath(s.location.uri),
        sym: s,
      }))
      .sort((a, b) =>
        compareCandidates(
          { library: libraryOf(a.sym), pkg: a.label },
          { library: libraryOf(b.sym), pkg: b.label },
        ),
      ),
    { placeHolder, matchOnDescription: true },
  );
}

async function instantiateEntity(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

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
  const indent = indentOf(line.text);
  const unit = await designUnitLine(editor.document, editor.selection.active);
  const home = await libraryFor(editor.document, unit, lib);
  const text = renderInstance(e, { label, indent, library: home.name });

  await editor.edit((b) => {
    const at = new vscode.Position(line.lineNumber, indent.length);
    b.replace(
      new vscode.Range(at, editor.selection.active),
      text.trim() + "\n",
    );
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

  const line = editor.document.lineAt(editor.selection.active.line);
  await editor.edit((b) =>
    b.insert(
      new vscode.Position(line.lineNumber, 0),
      renderComponent(e, indentOf(line.text)) + "\n",
    ),
  );
}

/** The line holding the `begin` that opens the enclosing statement part. */
function declarationInsertPoint(
  doc: vscode.TextDocument,
  from: vscode.Position,
): vscode.Position {
  for (let l = from.line; l >= 0; l--)
    if (/^\s*begin\b/i.test(doc.lineAt(l).text))
      return new vscode.Position(l, 0);
  return new vscode.Position(from.line, 0);
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
      "Put the cursor inside an instantiation. It is located through the VHDL language server, so the file must analyze cleanly enough for it to be reported.",
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

  const existing = flatten(await documentSymbols(doc.uri)).map((s) =>
    identOf(s.name),
  );
  const decls = renderSignals(e.ports, {
    existing,
    actuals,
    genericValues,
    indent: indentOf(doc.lineAt(inst.range.start.line).text),
  });

  if (!decls) {
    vscode.window.showInformationMessage(
      "Every actual in this port map is already declared.",
    );
    return;
  }
  await editor.edit((b) =>
    b.insert(declarationInsertPoint(doc, inst.range.start), decls + "\n"),
  );
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

  // The signal is a declaration and the process a concurrent statement, so they go either side
  // of the architecture's `begin`. Written as one block after the type, the process ended up
  // among the declarations, which the server rejects.
  const line = doc.lineAt(editor.selection.active.line);
  const architecture = flatten(await documentSymbols(doc.uri))
    .filter(isArchitecture)
    .find((s) => s.range.contains(editor.selection.active));
  if (!architecture) {
    vscode.window.showWarningMessage(
      "A state machine is generated into an architecture. Put the cursor on an enumeration type declared in one.",
    );
    return;
  }

  // After the whole type, which may span several lines.
  const declaredAt = endOfStatement(doc, line.lineNumber) + 1;

  // The architecture's own `begin` is the one at its indentation: a subprogram declared above
  // it has a `begin` of its own, deeper.
  const architectureIndent = indentOf(
    doc.lineAt(architecture.range.start.line).text,
  );
  const opens = new RegExp(`^${architectureIndent}begin\\b`, "i");
  let begin = -1;
  for (let l = declaredAt; l <= architecture.range.end.line; l++) {
    if (opens.test(doc.lineAt(l).text)) {
      begin = l;
      break;
    }
  }
  if (begin < 0) {
    vscode.window.showWarningMessage(
      "Could not find the `begin` of the architecture this type is declared in.",
    );
    return;
  }

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
  if (range.isEmpty) return;
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

  const at = declarationInsertPoint(doc, range.start);
  const indent = indentOf(doc.lineAt(at.line).text) + "  ";
  await editor.edit((b) => {
    b.replace(range, name);
    b.insert(at, `${indent}${kind} ${name} : ${type} := ${expression};\n`);
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
  for (let l = from.line; l >= 0; l--) {
    const text = doc.lineAt(l).text.replace(/--.*$/, "");
    if (/^\s*end\s+(process|function|procedure)\b/i.test(text)) return null;
    if (/^\s*(\w+\s*:\s*)?process\b/i.test(text)) return l;
    if (
      /^\s*(impure\s+|pure\s+)?(function|procedure)\b/i.test(text) &&
      !/;\s*$/.test(text)
    )
      return l;
  }
  return null;
}

/** The first `begin` at or below `from`. */
function beginAt(doc: vscode.TextDocument, from: number): number | null {
  for (let l = from; l < doc.lineCount; l++)
    if (/^\s*begin\b/i.test(doc.lineAt(l).text)) return l;
  return null;
}

/**
 * The architecture's own `begin`: the least indented one above the cursor.
 *
 * A process or a subprogram has a `begin` of its own, and it is always indented deeper than the
 * architecture's, so the shallowest is the one that closes the declarative part a signal goes in.
 */
function architectureBegin(
  doc: vscode.TextDocument,
  from: vscode.Position,
): number | null {
  let best: number | null = null;
  let shallowest = Number.POSITIVE_INFINITY;
  for (let l = from.line; l >= 0; l--) {
    const text = doc.lineAt(l).text;
    if (!/^\s*begin\b/i.test(text)) continue;
    const width = indentOf(text).length;
    if (width <= shallowest) {
      shallowest = width;
      best = l;
    }
  }
  return best;
}

/** Where a declaration of `kind` belongs, given where the name was used. */
function declarationSite(
  doc: vscode.TextDocument,
  at: vscode.Position,
  kind: ObjectKind,
): { position: vscode.Position; indent: string } | null {
  const home = sequentialHome(doc, at);
  const line =
    kind === "variable"
      ? home === null
        ? null
        : beginAt(doc, home)
      : architectureBegin(doc, at);
  if (line === null) return null;
  return {
    position: new vscode.Position(line, 0),
    indent: indentOf(doc.lineAt(line).text) + "  ",
  };
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
): Promise<void> {
  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(uri),
  );
  const site = declarationSite(editor.document, anchor, kind);
  if (!site) {
    vscode.window.showWarningMessage(
      `Could not find the declarative part a ${kind} would go in.`,
    );
    return;
  }
  await editor.insertSnippet(
    new vscode.SnippetString(renderDeclaration(kind, name, site.indent) + "\n"),
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
): { text: string; endLine: number } | null {
  let depth = 1;
  const lines: string[] = [];
  for (let l = from + 1; l < doc.lineCount; l++) {
    const text = doc.lineAt(l).text.replace(/--.*$/, "");
    if (/\bend\s+case\b/i.test(text)) {
      depth -= 1;
      if (depth === 0) return { text: lines.join("\n"), endLine: l };
    } else if (caseSelector(text)) {
      depth += 1;
    }
    lines.push(text);
  }
  return null;
}

/** The enumeration a case selector has as its type, through the signal's declaration. */
async function enumOfSelector(
  doc: vscode.TextDocument,
  at: vscode.Position,
): Promise<EnumType | null> {
  const direct = parseEnumHover(await hoverText(doc.uri, at));
  if (direct) return direct;

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

/**
 * Turn a `case` over a name that does not exist into a state machine: the enumeration, the
 * state signal and a `when` arm for each state.
 *
 * Someone typing `case state is` before declaring anything has already decided the shape of
 * what they want. The states are the one thing that cannot be guessed, so they are asked for
 * and nothing else is.
 */
async function insertStateMachine(
  uri: vscode.Uri,
  selector: string,
  headerLine: number,
): Promise<void> {
  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(uri),
  );
  const doc = editor.document;

  const answer = await vscode.window.showInputBox({
    prompt: `States of ${selector}`,
    value: "idle, busy, done",
    validateInput: (v) =>
      v.split(",").every((s) => /^\s*[a-z]\w*\s*$/i.test(s))
        ? undefined
        : "A comma separated list of VHDL identifiers",
  });
  if (!answer) return;
  const states = answer.split(",").map((s) => s.trim());

  const site = declarationSite(
    doc,
    new vscode.Position(headerLine, 0),
    "signal",
  );
  if (!site) {
    vscode.window.showWarningMessage(
      "Could not find the architecture's declarative part to declare the states in.",
    );
    return;
  }
  const body = caseBody(doc, headerLine);
  const header = doc.lineAt(headerLine);
  const { type, declaration } = renderStateDeclarations(
    `t_${selector}`,
    selector,
    states,
    site.indent,
  );

  await editor.edit((b) => {
    b.insert(site.position, `${type}\n${declaration}\n`);
    const arms = renderWhenChoices(states, indentOf(header.text) + "  ");
    if (body) {
      b.insert(new vscode.Position(body.endLine, 0), arms);
    } else {
      b.insert(header.range.end, `\n${arms}${indentOf(header.text)}end case;`);
    }
  });
}

// --- providers -------------------------------------------------------------

class InstanceCompletion extends vscode.CompletionItem {
  constructor(
    readonly sym: Sym,
    label: string,
    readonly doc: vscode.TextDocument,
    readonly unitLine: number,
  ) {
    super(label, vscode.CompletionItemKind.Module);
  }
}

class ImportCompletion extends vscode.CompletionItem {
  constructor(
    readonly candidate: UseCandidate,
    readonly doc: vscode.TextDocument,
    readonly unitLine: number,
    label: string,
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
    const wordRange = document.getWordRangeAtPosition(position);
    const prefix = wordRange
      ? document.getText(wordRange.with(undefined, position))
      : "";
    if (prefix.length < 2) return [];
    if (
      /--/.test(
        document.lineAt(position.line).text.slice(0, position.character),
      )
    )
      return [];

    const syms = (await workspaceSymbols(prefix)) ?? [];
    const unitLine = await designUnitLine(document, position);
    const visible = visiblePackages(document.getText().split("\n"), unitLine);
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    for (const s of syms) {
      if (isEntitySymbol(s)) {
        const name = identOf(s.name);
        const item = new InstanceCompletion(s, name, document, unitLine);
        item.detail = `instantiate ${libraryOf(s)}.${name}`;
        item.filterText = name;
        item.sortText = `zzz_${name}`;
        items.push(item);
        continue;
      }

      const designator = designatorOf(s.name);
      const parts = (s.containerName ?? "").split(".");
      if (!designator || parts.length < 2) continue;
      const [library, pkg] = parts;
      if (visible.has(`${library}.${pkg}`.toLowerCase())) continue;
      const key = `${designator}:${library}.${pkg}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const item = new ImportCompletion(
        { library, pkg, describes: s.name },
        document,
        unitLine,
        designator,
        completionKindOf(s.kind),
      );
      item.detail = `${library}.${pkg}`;
      item.documentation = new vscode.MarkdownString(
        `${s.name}\n\nAdds \`use ${library}.${pkg}.all;\``,
      );
      item.sortText = `zzy_${library}_${designator}`;
      items.push(item);
    }
    return items;
  },

  async resolveCompletionItem(item) {
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
      const edit = contextClauseEdit(
        item.doc.getText().split("\n"),
        item.unitLine,
        item.candidate.library,
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
    const instances = flatten(await documentSymbols(document.uri)).filter(
      (s) => isInstance(s) && s.range.intersection(range),
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
    const actions: vscode.CodeAction[] = [];
    const lines = document.getText().split("\n");

    for (const diagnostic of context.diagnostics.filter(
      (d) => d.code === "unresolved",
    )) {
      const name = document.getText(diagnostic.range);
      if (!/^[A-Za-z]\w*$/.test(name)) continue;
      const unitLine = await designUnitLine(document, diagnostic.range.start);

      for (const c of await findDeclaringPackages(name)) {
        const edit = contextClauseEdit(lines, unitLine, c.library, c.pkg);
        if (!edit) continue;
        const action = new vscode.CodeAction(
          `Add use ${c.library}.${c.pkg}.all`,
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = applyContextEdit(document, edit);
        action.diagnostics = [diagnostic];
        actions.push(action);
      }
    }

    // A name the analyser could not resolve is either missing an import, offered above, or
    // missing a declaration. Which declarations are legal depends on where the cursor is, so
    // only those are offered: a variable inside a process, a signal outside one.
    for (const diagnostic of context.diagnostics.filter(
      (d) => d.code === "unresolved",
    )) {
      const name = document.getText(diagnostic.range);
      if (!/^[A-Za-z]\w*$/.test(name)) continue;
      const kinds = declarableKinds(
        sequentialHome(document, diagnostic.range.start) !== null,
        assignmentKind(document.lineAt(diagnostic.range.start.line).text, name),
      );
      for (const kind of kinds) {
        if (!declarationSite(document, diagnostic.range.start, kind)) continue;
        const action = new vscode.CodeAction(
          `Declare ${kind} ${name}`,
          vscode.CodeActionKind.QuickFix,
        );
        action.command = {
          command: "speja.declareObject",
          title: action.title,
          arguments: [document.uri, kind, name, diagnostic.range.start],
        };
        action.diagnostics = [diagnostic];
        actions.push(action);
      }
    }

    const inst = await instanceAt(document, range.start);
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
        const declared = flatten(await documentSymbols(document.uri)).map(
          (sy) => identOf(sy.name),
        );
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
    const sel = caseAt(document, range.start);
    if (sel) {
      const header = document.lineAt(sel.line);
      const at = new vscode.Position(
        sel.line,
        header.text.indexOf(sel.selector),
      );
      const en = /^[a-z]\w*$/i.test(sel.selector)
        ? await enumOfSelector(document, at)
        : null;
      const body = caseBody(document, sel.line);
      const missing = en ? missingChoices(body?.text ?? "", en.literals) : [];

      if (en && missing.length && body) {
        const action = new vscode.CodeAction(
          `Add ${missing.length} missing when choice${missing.length > 1 ? "s" : ""}`,
          vscode.CodeActionKind.QuickFix,
        );
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          document.uri,
          new vscode.Position(body.endLine, 0),
          renderWhenChoices(missing, indentOf(header.text) + "  "),
        );
        action.edit = edit;
        actions.push(action);
      }
      if (!en && /^[a-z]\w*$/i.test(sel.selector)) {
        const action = new vscode.CodeAction(
          `Insert state machine over ${sel.selector}`,
          vscode.CodeActionKind.QuickFix,
        );
        action.command = {
          command: "speja.insertStateMachine",
          title: action.title,
          arguments: [document.uri, sel.selector, sel.line],
        };
        actions.push(action);
      }
    }

    if (!range.isEmpty) {
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
    return actions;
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
      "speja.insertStateMachine",
      insertStateMachine,
    ),
    vscode.commands.registerCommand(
      "speja.removeUnusedUseClauses",
      removeUnusedUseClauses,
    ),
    vscode.commands.registerCommand("speja.refreshHierarchy", () =>
      hierarchy.refresh(),
    ),

    vscode.languages.registerCompletionItemProvider("vhdl", vhdlCompletions),
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
