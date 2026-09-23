// The editing features, run inside a real extension host against a real VHDL-LS.
//
// Everything in `src/editing.ts` talks to a language server through VS Code, so none of it can
// be checked by a unit test: the only honest check is to start the editor and ask. This runs
// there, in the same API scope as the extension under test, which is what lets it answer the
// prompts the commands raise. It is started by `run.mjs`, not by hand.
//
// Each step is time-boxed and reported the moment it finishes, so a step that hangs still leaves
// evidence of how far the run got.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
const out = (line) => {
  lines.push(line);
  fs.writeFileSync(process.env.VSGRS_RESULTS, lines.join("\n") + "\n");
};
const check = (ok, name, detail) =>
  out(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  --  " + detail : ""}`);

const limit = (promise, ms, what) =>
  Promise.race([
    Promise.resolve(promise).catch((error) => {
      throw new Error(`${what}: ${error.message}`);
    }),
    wait(ms).then(() => {
      throw new Error(`timed out after ${ms}ms: ${what}`);
    }),
  ]);

async function until(probe, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await wait(400);
  }
}

exports.run = async function run() {
  try {
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const at = (name) => vscode.Uri.file(path.join(folder, name));
    const top = at("top.vhd");
    const doc = await vscode.workspace.openTextDocument(top);
    const editor = await vscode.window.showTextDocument(doc);

    const symbols = (query) =>
      vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query);
    const documentSymbols = async (uri) =>
      (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)) || [];
    const hintsIn = (uri, document) =>
      vscode.commands.executeCommand(
        "vscode.executeInlayHintProvider",
        uri,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0)),
      );
    const instancesIn = async (uri) =>
      (await documentSymbols(uri))
        .flatMap((symbol) => symbol.children || [])
        .filter((symbol) => /^instance/.test(symbol.name));
    // What must hold of a generated instance is that its references resolve. Actuals naming
    // signals that do not exist yet are expected until they are declared.
    const unresolved = () =>
      vscode.languages
        .getDiagnostics(top)
        .filter((d) => /No declaration of '(mylib|other|work|fifo|leaf)'|No primary unit/i.test(d.message));

    // Gate on the project's own entities. `fifo` also fuzzy-matches library symbols such as
    // find_leftmost, so accepting any result would pass before the project had been read at all.
    const started = Date.now();
    await until(
      async () =>
        (await symbols("fifo")).some((s) => /^entity 'fifo'/i.test(s.name) && s.containerName === "mylib") &&
        (await symbols("leaf")).some((s) => /^entity 'leaf'/i.test(s.name) && s.containerName === "other"),
      90000,
      "VHDL-LS to analyse both libraries",
    );
    out(`server ready after ${Date.now() - started}ms`);

    // The prompts, answered as a user accepting the defaults would.
    const ENTITIES = Number(process.env.VSGRS_ENTITIES);
    let pick = "fifo";
    let offered = 0;
    let offeredLabels = [];
    vscode.window.showQuickPick = async (items, options) => {
      const list = await items;
      offered = list.length;
      offeredLabels = list.map((item) => item.label);
      // A multiple-choice prompt answers with every item that starts ticked.
      if (options && options.canPickMany) return list.filter((item) => item.picked !== false);
      return list.find((item) => item.label === pick) || list[0];
    };
    vscode.window.showInputBox = async (options) => options && options.value;
    // A message box waits for a click that never comes, so a command that raises one would hang
    // the run. Record them instead, and let a step say whether it expected one.
    const messages = [];
    for (const kind of ["showErrorMessage", "showWarningMessage", "showInformationMessage"]) {
      vscode.window[kind] = async (message) => {
        messages.push(`${kind.replace("show", "").replace("Message", "")}: ${message}`);
        return undefined;
      };
    }

    // A blank, indented line before `marker`, as auto-indent leaves one.
    const openLineBefore = async (marker) => {
      const line = doc.getText().split("\n").findIndex((text) => text.startsWith(marker));
      await editor.edit((edit) => edit.insert(new vscode.Position(line, 0), "  \n"));
      const cursor = new vscode.Position(line, 2);
      editor.selection = new vscode.Selection(cursor, cursor);
    };

    // 1. Inlay hints on a port map that was already there.
    const first = await limit(hintsIn(top, doc), 20000, "inlay hints");
    check(
      first.length === 2 && first.every((h) => /in std_logic/.test(String(h.label))),
      "inlay hints on an existing port map",
      `${first.length}: ${first.map((h) => h.label).join(" / ")}`,
    );

    // 2. Instantiate an entity from the library the file is itself analysed in: `work`, and
    // nothing to add. Spelling the library out would need a clause the file does not have.
    await openLineBefore("  u_fifo");
    const before = doc.getText();
    await limit(vscode.commands.executeCommand("speja.instantiateEntity"), 30000, "instantiateEntity");
    const after = doc.getText();
    check(
      /i_fifo : entity work\.fifo/.test(after) &&
        /generic map/.test(after) &&
        /port map/.test(after) &&
        !/library mylib/.test(after),
      "instantiate from the file's own library",
      `${after.length - before.length} chars, spelled work.fifo, no library clause`,
    );
    check(
      offered === ENTITIES,
      "the picker offers every entity, past the server's 200-symbol cap",
      `${offered} of ${ENTITIES}`,
    );

    await until(async () => (await instancesIn(top)).length === 2, 30000, "the server to see the new instance");
    check(
      unresolved().length === 0,
      "the generated instance names a library and entity that resolve",
      unresolved().map((d) => d.message).join(" | ") || "nothing unresolved",
    );

    // 3. Give the generic a value, as a user would, then declare the signals the map needs.
    const generic = doc.getText().indexOf("width => width");
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(doc.positionAt(generic), doc.positionAt(generic + "width => width".length)),
        "width => 16",
      ),
    );
    await until(async () => (await instancesIn(top)).length === 2, 30000, "the server to see the edit");
    const inside = doc.positionAt(doc.getText().indexOf("i_fifo") + 3);
    editor.selection = new vscode.Selection(inside, inside);
    await limit(vscode.commands.executeCommand("speja.declareSignals"), 30000, "declareSignals");
    const declared = doc.getText();
    const names = ["din", "dout", "empty"].filter((n) => new RegExp(`signal\\s+${n}\\s*:`).test(declared));
    check(names.length === 3, "declare signals for a port map", `declared: ${names.join(",")}`);
    check(
      /signal\s+din\s*:\s*std_logic_vector\(16 - 1 downto 0\)/.test(declared),
      "the generic's value is substituted into a declared type",
    );
    check((declared.match(/signal\s+clk\s*:/g) || []).length === 1, "signals that exist are not redeclared");

    // 4. An entity from ANOTHER library is only visible after a library clause.
    pick = "leaf";
    await openLineBefore("end architecture");
    await limit(vscode.commands.executeCommand("speja.instantiateEntity"), 30000, "instantiateEntity (leaf)");
    const crossed = doc.getText();
    check(/i_leaf : entity other\.leaf/.test(crossed), "an entity from another library is named by it");
    check(/^library other;$/m.test(crossed), "and the library clause it needs is added");
    await until(async () => (await instancesIn(top)).length === 3, 30000, "the server to see the third instance");
    await wait(1500);
    check(
      unresolved().length === 0,
      "the cross-library instance resolves",
      unresolved().map((d) => `line ${d.range.start.line + 1}: ${d.message}`).join(" | ") || "nothing unresolved",
    );

    // 5. Inlay hints on every instance.
    const every = await limit(hintsIn(top, doc), 20000, "inlay hints after edits");
    check(every.length >= 2 + 6 + 2, "inlay hints on every instance", `${every.length} hints`);

    // 6. The design hierarchy.
    const { DesignHierarchy } = require(path.join(process.env.VSGRS_EXT, "out", "editing.js"));
    const tree = new DesignHierarchy();
    const roots = await limit(tree.getChildren(), 30000, "hierarchy roots");
    const listed = roots.map((r) => `${r.description}.${r.label}`);
    check(
      listed.includes("mylib.top") && listed.includes("other.leaf") && roots.length === ENTITIES,
      "the hierarchy lists every entity, across libraries",
      `${roots.length} of ${ENTITIES}`,
    );
    const topNode = roots.find((r) => r.label === "top");
    const children = topNode ? await limit(tree.getChildren(topNode), 30000, "children of top") : [];
    const resolved = children.map((c) => `${c.label}:${c.description}`).sort().join(", ");
    check(
      resolved === "i_fifo:mylib.fifo, i_leaf:other.leaf, u_fifo:mylib.fifo",
      "the hierarchy resolves every instance to its entity",
      resolved,
    );
    if (children.length) {
      check(tree.getTreeItem(children[0]).command.command === "vscode.open", "a tree item opens its source");
    }
    await vscode.commands.executeCommand("speja.hierarchy.focus");
    check(true, "the view can be focused");

    // 7. Quick fixes: the one that maps missing ports, and the wiring of the extract commands.
    const onInstance = doc.positionAt(doc.getText().indexOf("u_fifo") + 2);
    const fixes = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      top,
      new vscode.Range(onInstance, onInstance),
    );
    const map = fixes.find((a) => /^Map \d+ missing ports?$/.test(a.title));
    check(!!map, "a quick fix maps the ports an instance leaves out", map ? map.title : "not offered");
    if (map) {
      await vscode.workspace.applyEdit(map.edit);
      const block = doc.getText().slice(doc.getText().indexOf("u_fifo"));
      check(/din\s*=>/.test(block.split("end architecture")[0]), "and writes the missing formals");
    }
    const sixteen = doc.getText().indexOf("width => 16") + "width => ".length;
    const selected = new vscode.Range(doc.positionAt(sixteen), doc.positionAt(sixteen + 2));
    const refactors = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", top, selected);
    const extract = refactors.find((a) => a.title === "Extract to constant");
    check(
      !!extract && extract.command.command === "speja.extractObject" && extract.command.arguments[0].fsPath === top.fsPath,
      "the extract action carries its document, under the speja command name",
    );

    // Extract with ANOTHER document focused. The action names its document, so the edit must
    // land there; falling back to the active editor would rewrite whichever file has focus.
    const fifo = await vscode.workspace.openTextDocument(at("fifo.vhd"));
    await vscode.window.showTextDocument(fifo);
    const fifoBefore = fifo.getText();
    await limit(
      vscode.commands.executeCommand("speja.extractObject", top, selected, "constant"),
      20000,
      "extractObject",
    );
    const extracted = doc.getText();
    check(
      /constant c_value\s*:/.test(extracted) && /width => c_value/.test(extracted),
      "extract edits the document the action came from",
    );
    check(fifo.getText() === fifoBefore && !fifo.isDirty, "and leaves the focused document alone");

    // 9. The rest of the commands, each against a file of its own so they cannot lean on the
    // edits above. What is asserted is the result, and that the server agrees it is sound.
    const errorsIn = (uri) =>
      vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    // Two servers answer for a VHDL file here. "Does this parse and resolve" is VHDL-LS's
    // question; speja's layout opinions are a different one, and mixing them makes a check about
    // generated VHDL fail over an indent.
    const analysisErrorsIn = (uri) => errorsIn(uri).filter((d) => d.source !== "speja");
    const open = async (name) => {
      const document = await vscode.workspace.openTextDocument(at(name));
      const shown = await vscode.window.showTextDocument(document);
      return { document, shown, uri: document.uri };
    };
    const cursorAt = (shown, position) => {
      shown.selection = new vscode.Selection(position, position);
    };
    const settle = async (uri, ms = 15000) => {
      // The server re-analyses after an edit; give it the moment it needs, then read.
      await wait(2500);
      return analysisErrorsIn(uri);
    };

    // 9a. A state machine over an enumeration type. The signal belongs in the declarative part
    // and the process after `begin`: a process cannot sit among declarations.
    {
      const { document, shown, uri } = await open("fsm.vhd");
      await until(async () => (await documentSymbols(uri)).length > 0, 30000, "fsm.vhd to be analysed");
      const line = document.getText().split("\n").findIndex((l) => l.includes("type state_t"));
      cursorAt(shown, new vscode.Position(line, document.lineAt(line).text.indexOf("state_t") + 2));
      pick = "Synchronous reset";
      await limit(vscode.commands.executeCommand("speja.fsmFromEnum"), 30000, "fsmFromEnum");
      const text = document.getText();
      check(
        /signal state : state_t := idle;/.test(text) && /case state is/.test(text) && /when finish =>/.test(text),
        "a state machine is generated from an enumeration type",
      );
      const begin = text.indexOf("\nbegin");
      check(
        text.indexOf("signal state") > text.indexOf("  );") &&
          text.indexOf("signal state") < begin &&
          text.indexOf("process") > begin,
        "the signal follows the whole type, and the process comes after `begin`",
        `type ends at ${text.indexOf("  );")}, signal at ${text.indexOf("signal state")}, begin at ${begin}, process at ${text.indexOf("process")}`,
      );
      check(messages.length === 0, "and no warning was raised", messages.join(" | ") || "none");
      const errors = await settle(uri);
      check(errors.length === 0, "the server accepts the generated state machine",
        errors.map((d) => `line ${d.range.start.line + 1}: ${d.message}`).join(" | ") || "no errors");
    }

    // 9b. Removing unused use clauses: `math_real` is unused, `std_logic_1164` is used by
    // `std_logic`. Naming the second would be a real loss, so this also checks the search
    // finds a declaration the server's 200-symbol cap could hide.
    {
      const { document, shown, uri } = await open("clauses.vhd");
      await until(async () => (await documentSymbols(uri)).length > 0, 30000, "clauses.vhd to be analysed");
      cursorAt(shown, new vscode.Position(0, 0));
      offeredLabels = [];
      await limit(vscode.commands.executeCommand("speja.removeUnusedUseClauses"), 120000, "removeUnusedUseClauses");
      const text = document.getText();
      check(
        offeredLabels.length === 1 && /math_real/i.test(offeredLabels[0]),
        "only the unused use clause is offered for removal",
        offeredLabels.join(" | ") || `nothing offered${messages.length ? "; " + messages.join(" | ") : ""}`,
      );
      check(!/math_real/i.test(text) && /std_logic_1164/.test(text), "and only it is removed");
    }

    // 9c. Add a use clause for a name the file cannot see, as a quick fix and as a command.
    {
      const { document, shown, uri } = await open("usage.vhd");
      await until(async () => vscode.languages.getDiagnostics(uri).some((d) => /unsigned/i.test(d.message)), 30000,
        "the server to report `unsigned` unresolved");
      const at0 = document.positionAt(document.getText().indexOf("unsigned") + 2);
      const fixes = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, new vscode.Range(at0, at0));
      const quick = fixes.find((a) => /^Add use ieee\.numeric_std\.all$/i.test(a.title));
      check(!!quick, "a quick fix offers the package that declares an unresolved name",
        fixes.map((a) => a.title).slice(0, 4).join(" | "));
      // Several packages declare `unsigned`. The one people mean is first and preferred, and
      // the Synopsys one is last: alphabetical put NUMERIC_BIT on top.
      const offers = fixes.filter((a) => /^Add use /.test(a.title));
      check(
        offers.length > 1 && offers[0] === quick && quick.isPreferred === true,
        "and the standard package is ranked first and preferred",
        offers.map((a) => `${a.title}${a.isPreferred ? " *" : ""}`).join(" | "),
      );
      check(
        !offers.length || /std_logic_arith|numeric_bit/i.test(offers[offers.length - 1].title),
        "with the packages nobody means at the bottom",
        offers.map((a) => a.title).join(" | "),
      );

      // Taking the preferred fix adds the clause once. The searchable command is section 25's.
      await vscode.workspace.applyEdit(quick.edit);
      await wait(300);
      const text = document.getText();
      check(/use ieee\.NUMERIC_STD\.all;/i.test(text) && (text.match(/^use ieee\.NUMERIC_STD\.all;$/gim) || []).length === 1,
        "the use clause is added once, for the chosen package",
        `${(text.match(/^library ieee;$/gm) || []).length} library clauses in the file`);
      await until(async () => !vscode.languages.getDiagnostics(uri).some((d) => /unsigned/i.test(d.message)), 30000,
        "the unresolved name to resolve");
      check(true, "and the name resolves once it is added");

      // 9d. A component declaration, in the declarative part, of an entity from the project.
      const declLine = document.getText().split("\n").findIndex((l) => l.startsWith("begin"));
      await shown.edit((edit) => edit.insert(new vscode.Position(declLine, 0), "  \n"));
      cursorAt(shown, new vscode.Position(declLine, 2));
      pick = "fifo";
      await limit(vscode.commands.executeCommand("speja.componentDeclaration"), 30000, "componentDeclaration");
      const withComponent = document.getText();
      check(/component fifo is/.test(withComponent) && /end component/.test(withComponent) && /generic \(/.test(withComponent),
        "an entity is declared as a component");
      const bad = (await settle(uri)).filter((d) => /No declaration|Unexpected|expected/i.test(d.message));
      check(bad.length === 0, "and the server accepts it", bad.map((d) => d.message).join(" | ") || "no errors");
    }

    // 9e. Completion: an entity as a whole instantiation, and a name from a package the file has
    // not made visible, which brings its use clause with it.
    {
      const { document, shown, uri } = await open("fsm.vhd");
      const endLine = document.getText().split("\n").findIndex((l) => l.startsWith("end architecture"));
      await shown.edit((edit) => edit.insert(new vscode.Position(endLine, 0), "  unit3\n  unit35\n  resize\n"));
      await until(async () => (await documentSymbols(uri)).length > 0, 15000, "the server to see the edit");
      // Only the first N items are resolved, in list order, and VHDL-LS contributes hundreds of its
      // own before ours. Resolve them all: the list is not filtered by what was typed.
      const complete = (line, text) => vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider", uri, new vscode.Position(line, text.length), undefined, 1000);
      const entityItems = (await complete(endLine, "  unit3")).items.filter((i) => /^unit3\d$/.test(i.label.label || i.label));
      check(entityItems.length >= 10, "entities are offered as completions", `${entityItems.length} matching unit3x`);
      const exact = (await complete(endLine + 1, "  unit35")).items.filter((i) => (i.label.label || i.label) === "unit35" && /^instantiate/.test(i.detail || ""));
      const one = exact[0];
      const snippet = one && one.insertText && (one.insertText.value || String(one.insertText));
      check(!!snippet && /entity work\.unit35/.test(snippet) && /port map/.test(snippet),
        "an entity completion inserts the whole instantiation", snippet ? snippet.split("\n")[0] : "unresolved");

      const imports = (await complete(endLine + 2, "  resize")).items.filter((i) => /ieee\./i.test(i.detail || ""));
      const withClause = imports.find((i) => (i.additionalTextEdits || []).some((e) => /use ieee\./i.test(e.newText)));
      check(!!withClause, "a name from a package that is not visible is offered with its use clause",
        withClause ? withClause.additionalTextEdits[0].newText.trim() : `${imports.length} import items, none resolved`);
    }

    // 9f. A references CodeLens on an entity, and signature help inside a port map.
    {
      const fifoUri = at("fifo.vhd");
      await vscode.workspace.openTextDocument(fifoUri);
      const lenses = await limit(
        vscode.commands.executeCommand("vscode.executeCodeLensProvider", fifoUri, 10), 30000, "code lenses");
      const references = lenses.map((l) => l.command && l.command.title).filter(Boolean);
      const count = references.length ? Number(/^(\d+)/.exec(references[0])[1]) : -1;
      check(count >= 2, "an entity carries a references CodeLens", references.join(" | ") || "none");

      const text = doc.getText();
      const inMap = doc.positionAt(text.indexOf("clk   => clk,") + "clk   => clk,".length);
      const help = await limit(vscode.commands.executeCommand(
        "vscode.executeSignatureHelpProvider", top, inMap, ","), 30000, "signature help");
      const label = help && help.signatures[0] && help.signatures[0].label;
      check(!!label && /fifo port map \(clk, rst, din, dout, empty\)/.test(label),
        "signature help shows the ports while a map is typed", label || "none");
      check(!!help && help.activeParameter === 0, "with the formal under the cursor active", `${help && help.activeParameter}`);
    }

    // 8. A resolution that failed because the server did not yet know the entity must not be
    // remembered. The document below never changes, so its version never does either: a cached
    // failure would keep it hint-less for good.
    const create = async (name, text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(at(name), { overwrite: true });
      edit.insert(at(name), new vscode.Position(0, 0), text);
      await vscode.workspace.applyEdit(edit);
      const created = await vscode.workspace.openTextDocument(at(name));
      await created.save();
      return created;
    };
    const later = await create(
      "unit98.vhd",
      "library ieee;\nuse ieee.std_logic_1164.all;\n\nentity unit98 is\nend entity unit98;\n\n" +
        "architecture rtl of unit98 is\nbegin\n\n  u : entity work.unit99\n    port map (\n" +
        "      p0 => open\n    );\n\nend architecture rtl;\n",
    );
    await until(async () => (await instancesIn(later.uri)).length === 1, 30000, "the server to read unit98");
    const unknown = await limit(hintsIn(later.uri, later), 20000, "hints before the entity exists");
    check(unknown.length === 0, "no hints while the entity is unknown", `${unknown.length}`);
    await create(
      "unit99.vhd",
      "library ieee;\nuse ieee.std_logic_1164.all;\n\nentity unit99 is\n  port (\n    p0 : in std_logic\n  );\nend entity unit99;\n",
    );
    await until(
      async () => (await symbols("unit99")).some((s) => /^entity 'unit99'/i.test(s.name)),
      30000,
      "the server to read unit99",
    );
    const known = await limit(hintsIn(later.uri, later), 20000, "hints once the entity exists");
    check(
      known.length === 1,
      "hints appear once the entity exists, without the document changing",
      `${known.length}`,
    );

    // 13. Formatting a selection, and the action that offers it from the squiggle. Both go
    // through the speja server rather than VHDL-LS, and both must leave every line the user did
    // not pick byte-identical: that is the whole promise of a range operation.
    {
      const layout = await vscode.workspace.openTextDocument(at("layout.vhd"));
      const before = layout.getText().split("\n");
      const longLine = before.findIndex((l) => l.length > 120);
      const looseLine = before.findIndex((l) => /^signal count/.test(l));
      check(longLine >= 0 && looseLine >= 0, "the layout fixture has a long line and an unindented one",
        `long=${longLine + 1} loose=${looseLine + 1}`);

      // Format Selection over the long line only.
      const range = new vscode.Range(new vscode.Position(longLine, 0), new vscode.Position(longLine + 1, 0));
      const edits = (await limit(
        vscode.commands.executeCommand("vscode.executeFormatRangeProvider", layout.uri, range,
          { tabSize: 2, insertSpaces: true }),
        30000, "range formatting")) || [];
      check(edits.length > 0, "Format Selection returns an edit for the over-long line", `${edits.length} edit(s)`);
      const outside = edits.filter((e) => e.range.start.line < longLine || e.range.end.line > longLine + 1);
      check(outside.length === 0, "and no edit falls outside the selected line",
        outside.map((e) => `${e.range.start.line + 1}..${e.range.end.line + 1}`).join(" | "));

      // Apply them and confirm the file really did change only there.
      const applied = new vscode.WorkspaceEdit();
      for (const edit of edits) applied.replace(layout.uri, edit.range, edit.newText);
      await vscode.workspace.applyEdit(applied);
      const after = layout.getText().split("\n");
      check(after.every((l) => l.length <= 120), "the long line is folded", `longest is now ${Math.max(...after.map((l) => l.length))}`);
      check(after[looseLine] === before[looseLine], "a line outside the selection is untouched",
        JSON.stringify(after[looseLine]));
      const untouched = before.slice(0, longLine).every((l, i) => l === after[i]);
      check(untouched, "and so is everything above it");

      // The lightbulb on the still-unindented line offers to format it.
      const at0 = new vscode.Position(looseLine, 0);
      const actions = (await limit(
        vscode.commands.executeCommand("vscode.executeCodeActionProvider", layout.uri, new vscode.Range(at0, at0)),
        30000, "code actions on a badly laid out line")) || [];
      const format = actions.find((a) => /^speja: format line/.test(a.title));
      check(!!format, "a badly laid out line offers to format itself",
        actions.map((a) => a.title).slice(0, 4).join(" | "));
      if (format && format.edit) {
        await vscode.workspace.applyEdit(format.edit);
        const now = layout.getText().split("\n");
        check(/^  signal count/.test(now[looseLine]), "and applying it indents that line",
          JSON.stringify(now[looseLine]));
      }
    }

    // 14. The declarations an author would otherwise type out: an object that does not exist,
    // every signal a port map wants, and the two halves of a state machine. Each is offered
    // where the cursor already is, and only where it is legal.
    {
      const decl = await vscode.workspace.openTextDocument(at("declare.vhd"));
      await vscode.window.showTextDocument(decl);
      const text = decl.getText().split("\n");
      const lineOf = (pattern) => text.findIndex((l) => pattern.test(l));
      const actionsOn = async (line, column) => {
        const p = new vscode.Position(line, column);
        return (
          (await limit(
            vscode.commands.executeCommand(
              "vscode.executeCodeActionProvider",
              decl.uri,
              new vscode.Range(p, p),
            ),
            30000,
            `code actions on line ${line + 1}`,
          )) || []
        ).map((a) => a.title);
      };

      // Wait for the server to have an opinion about the file at all.
      await until(
        async () => (await symbols("declare_me")).some((s) => /^entity/i.test(s.name)),
        30000,
        "the server to read declare.vhd",
      );

      // A signal assignment in a process: the signal belongs to the architecture, the variable
      // to the process, and both are legal here.
      const held = lineOf(/held <= go;/);
      const onHeld = await actionsOn(held, text[held].indexOf("held") + 1);
      check(
        onHeld.includes("Declare signal held") && onHeld.includes("Declare constant held"),
        "a `<=` inside a process asks for a signal, which is the architecture's",
        onHeld.join(" | "),
      );
      check(
        !onHeld.includes("Declare variable held"),
        "and not for a variable, which `<=` cannot assign to",
      );

      const scratch = lineOf(/scratch := go;/);
      const onScratch = await actionsOn(scratch, text[scratch].indexOf("scratch") + 1);
      check(
        onScratch.includes("Declare variable scratch") &&
          !onScratch.includes("Declare signal scratch"),
        "and `:=` asks for a variable, not a signal",
        onScratch.join(" | "),
      );

      // The squiggle the declare actions hang off is amber, not red: with no declaration in
      // sight, whether to declare the name, import it or fix the typo is the author's call.
      const unresolved = vscode.languages
        .getDiagnostics(decl.uri)
        .filter((d) => d.code === "unresolved");
      check(
        unresolved.length > 0 &&
          unresolved.every((d) => d.severity === vscode.DiagnosticSeverity.Warning),
        "an unresolved name is amber, which is what the declare actions hang off",
        unresolved.map((d) => `${d.source}/${d.severity}`).join(", "),
      );

      // Two unresolved names on one line: the cursor picks one, and the other is left alone.
      const pair = lineOf(/held <= flag_a and flag_b;/);
      const onFlagA = await actionsOn(pair, text[pair].indexOf("flag_a") + 1);
      check(
        onFlagA.includes("Declare signal flag_a") && !onFlagA.some((t) => /flag_b/.test(t)),
        "only the name under the cursor is offered a declaration",
        onFlagA.join(" | "),
      );

      // A generate declares signals of its own, so both scopes are offered, nearest first.
      const lane = lineOf(/lane_out <= lane_valid;/);
      const onLane = await actionsOn(lane, text[lane].indexOf("lane_out") + 1);
      check(
        onLane.indexOf("Declare signal lane_out in g_lanes") >= 0 &&
          onLane.indexOf("Declare signal lane_out in g_lanes") <
            onLane.indexOf("Declare signal lane_out in the architecture"),
        "inside a generate, the generate is offered before the architecture",
        onLane.join(" | "),
      );

      // A block that has no declarative part yet: it still gets the offer.
      const guarded = lineOf(/gate_out <= go;/);
      const onGuarded = await actionsOn(guarded, text[guarded].indexOf("gate_out") + 1);
      check(
        onGuarded.includes("Declare signal gate_out in b_guard") &&
          onGuarded.includes("Declare signal gate_out in the architecture"),
        "and a block with no declarations yet is offered too",
        onGuarded.join(" | "),
      );

      // A variable assigned in a procedure belongs to the procedure, not to the process.
      const tally = lineOf(/tally := tally \+ n;/);
      const onTally = await actionsOn(tally, text[tally].indexOf("tally") + 1);
      check(
        onTally.includes("Declare variable tally"),
        "a variable is offered inside a procedure",
        onTally.join(" | "),
      );

      // The port map's actuals.
      const portMap = lineOf(/rst  => reset_n/);
      const onMap = await actionsOn(portMap, text[portMap].indexOf("reset_n") + 1);
      check(
        onMap.some((t) => /^Declare \d+ signals? for this port map$/.test(t)),
        "a port map offers to declare every actual it names",
        onMap.join(" | "),
      );
      // What an actual is connected to settles what it is: a port actual is a signal and only
      // a signal, a generic actual a constant and only a constant.
      check(
        onMap.includes("Declare signal reset_n") && !onMap.some((t) => /constant reset_n|variable reset_n/.test(t)),
        "a port actual is offered as a signal and nothing else",
        onMap.join(" | "),
      );

      // A case over an enumeration with one arm written: the rest are offered.
      const known = lineOf(/case phase is/);
      const onKnown = await actionsOn(known, text[known].indexOf("phase") + 1);
      check(
        onKnown.some((t) => /^Add 2 missing when choices$/.test(t)),
        "a case over an enum offers the choices it has not covered",
        onKnown.join(" | "),
      );

      // A case over a name that does not exist gets nothing from the case actions. There are no
      // states to infer from a name, and declaring it is what the declare actions are for.
      const unknown = lineOf(/case sequencer is/);
      const onUnknown = await actionsOn(unknown, text[unknown].indexOf("sequencer") + 1);
      check(
        !onUnknown.some((t) => /missing when choices|state machine/.test(t)),
        "a case over an undeclared name is not given states it never had",
        onUnknown.join(" | "),
      );
      check(
        onUnknown.includes("Declare signal sequencer"),
        "and is offered the declaration instead",
        onUnknown.join(" | "),
      );

      // Applying them: a title is not a feature. The arms have to land inside the case and the
      // declaration in the declarative part of the process, not wherever the cursor was.
      const armAction = (
        await limit(
          vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            decl.uri,
            new vscode.Range(
              new vscode.Position(known, text[known].indexOf("phase") + 1),
              new vscode.Position(known, text[known].indexOf("phase") + 1),
            ),
          ),
          30000,
          "the when-choices action",
        )
      ).find((a) => /missing when choices/.test(a.title));
      await vscode.workspace.applyEdit(armAction.edit);
      const filled = decl.getText().split("\n");
      const endCase = filled.findIndex((l, i) => i > known && /end case;/.test(l));
      const arms = filled.slice(known, endCase).join("\n");
      check(
        /when fire =>/.test(arms) && /when wait_ack =>/.test(arms),
        "the missing choices are written inside the case",
        JSON.stringify(arms.slice(0, 80)),
      );

      const declaredLine = filled.findIndex((l) => /held <= go;/.test(l));
      const heldAction = (
        await limit(
          vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            decl.uri,
            new vscode.Range(
              new vscode.Position(declaredLine, filled[declaredLine].indexOf("held") + 1),
              new vscode.Position(declaredLine, filled[declaredLine].indexOf("held") + 1),
            ),
          ),
          30000,
          "the declare-variable action",
        )
      ).find((a) => a.title === "Declare signal held");
      await vscode.commands.executeCommand(
        heldAction.command.command,
        ...heldAction.command.arguments,
      );
      await wait(500);
      const declared = decl.getText().split("\n");
      const architecture = declared.findIndex((l) => /^architecture rtl/.test(l));
      const architectureBegin = declared.findIndex(
        (l, i) => i > architecture && /^begin\b/.test(l),
      );
      const between = declared.slice(architecture + 1, architectureBegin).join("\n");
      check(
        /signal held :/.test(between),
        "the signal is declared in the architecture, not in the process that assigns it",
        JSON.stringify(between.split("\n").slice(-3).join("\n")),
      );
    }

    // 15. The same actions applied rather than counted. A title is a promise; this is whether it
    // is kept. Each runs on its own fixture so one edit cannot flatter the next, and the file is
    // handed back to the servers afterwards to say whether what was written is VHDL.
    {
      const apply = await vscode.workspace.openTextDocument(at("apply.vhd"));
      await vscode.window.showTextDocument(apply);
      await until(
        async () => (await symbols("apply_me")).some((s) => /^entity/i.test(s.name)),
        30000,
        "the server to read apply.vhd",
      );

      const lineWith = (pattern) =>
        apply.getText().split("\n").findIndex((l) => pattern.test(l));
      const actionFor = async (pattern, word, title) => {
        const line = lineWith(pattern);
        const column = apply.lineAt(line).text.indexOf(word) + 1;
        const at0 = new vscode.Position(line, column);
        const found = (
          (await limit(
            vscode.commands.executeCommand(
              "vscode.executeCodeActionProvider",
              apply.uri,
              new vscode.Range(at0, at0),
            ),
            30000,
            `code actions for ${title}`,
          )) || []
        ).find((a) => a.title === title);
        if (!found) return null;
        if (found.edit) await vscode.workspace.applyEdit(found.edit);
        else
          await vscode.commands.executeCommand(
            found.command.command,
            ...found.command.arguments,
          );
        await wait(400);
        return found;
      };
      const between = (openPattern, closePattern) => {
        const lines = apply.getText().split("\n");
        const from = lines.findIndex((l) => openPattern.test(l));
        const to = lines.findIndex((l, i) => i > from && closePattern.test(l));
        return lines.slice(from + 1, to).join("\n");
      };

      // A variable assigned in a process, declared above that process's own begin.
      check(
        !!(await actionFor(/scratch := go;/, "scratch", "Declare variable scratch")),
        "the variable action is there to apply",
      );
      check(
        /variable scratch :/.test(between(/p_main : process/, /^\s*begin\b/)),
        "and puts the variable in the process, above its begin",
        JSON.stringify(between(/p_main : process/, /^\s*begin\b/)),
      );

      // The type is inferred, not asked for: `reset_n` feeds the `rst` port, so it is whatever
      // that port is, and `busy <= go` is whatever `go` is.
      check(
        /variable scratch : std_logic;/.test(apply.getText()),
        "the variable takes the type of what is assigned to it",
        JSON.stringify(
          apply.getText().split("\n").find((l) => /variable scratch/.test(l)) ?? "missing",
        ),
      );

      // A signal used in a generate, declared in the generate rather than the architecture.
      check(
        !!(await actionFor(/lane_out <= lane_valid;/, "lane_out", "Declare signal lane_out in g_lanes")),
        "the generate-scoped action is there to apply",
      );
      check(
        /signal lane_out :/.test(between(/g_lanes : for/, /^\s{2}begin\b/)),
        "and puts the signal in the generate's own declarative part",
        JSON.stringify(between(/g_lanes : for/, /^\s{2}begin\b/)),
      );

      // A block with no declarative part at all: the `begin` has to be written too.
      check(
        !!(await actionFor(/gate_out <= go;/, "gate_out", "Declare signal gate_out in b_guard")),
        "the block-scoped action is there to apply",
      );
      const block = between(/b_guard : block/, /end block/);
      check(
        /signal gate_out :/.test(block) && /^\s*begin\b/m.test(block),
        "and opens the block's declarative part with a begin of its own",
        JSON.stringify(block),
      );

      // On the right of an assignment, the target says what the name is: `tally <= step`
      // makes `step` whatever `tally` is.
      check(
        !!(await actionFor(/tally <= step;/, "step", "Declare signal step")),
        "a name on the right of an assignment can be declared",
      );
      check(
        /signal step : std_logic_vector\(3 downto 0\);/.test(apply.getText()),
        "and takes the type of the target on the left",
        JSON.stringify(
          apply.getText().split("\n").find((l) => /signal step/.test(l)) ?? "missing",
        ),
      );

      // A generic actual is a constant and only a constant, with the generic's type.
      {
        const line = lineWith(/width => c_width/);
        const p = new vscode.Position(line, apply.lineAt(line).text.indexOf("c_width") + 1);
        const titles = (
          (await limit(
            vscode.commands.executeCommand(
              "vscode.executeCodeActionProvider",
              apply.uri,
              new vscode.Range(p, p),
            ),
            30000,
            "code actions on a generic actual",
          )) || []
        ).map((a) => a.title);
        check(
          titles.includes("Declare constant c_width") &&
            !titles.some((t) => /signal c_width|variable c_width/.test(t)),
          "a generic actual is offered as a constant and nothing else",
          titles.join(" | "),
        );
      }
      check(
        !!(await actionFor(/width => c_width/, "c_width", "Declare constant c_width")),
        "the constant action is there to apply",
      );
      check(
        /constant c_width : positive/.test(between(/^architecture rtl/, /^begin\b/)),
        "and takes the generic's type",
        JSON.stringify(
          apply.getText().split("\n").find((l) => /constant c_width/.test(l)) ?? "missing",
        ),
      );

      // One actual on its own takes the type of the port it feeds, not a placeholder.
      check(
        !!(await actionFor(/rst  => reset_n/, "reset_n", "Declare signal reset_n")),
        "a single actual can be declared on its own",
      );
      check(
        /signal reset_n : std_logic;/.test(apply.getText()),
        "and takes the type of the port it feeds",
        JSON.stringify(
          apply.getText().split("\n").find((l) => /signal reset_n/.test(l)) ?? "missing",
        ),
      );

      // Every actual of a port map at once.
      check(
        !!(await actionFor(/rst  => reset_n/, "reset_n", "Declare 2 signals for this port map")),
        "the port-map action counts only the undeclared actuals the map names",
      );
      const declarations = between(/^architecture rtl/, /^begin\b/);
      check(
        ["data_in", "data_out"].every((n) => new RegExp(`signal ${n} `).test(declarations)) &&
          !/signal empty\b/.test(declarations),
        "and declares them with the port's type, not the port the map leaves out",
        JSON.stringify(declarations.trim()),
      );

      // The verdict that matters: everything written above has to be VHDL. Both servers answer
      // about the open buffer rather than the file on disk, which is what makes this a check on
      // what the actions wrote and not on what the fixture started as.
      await wait(2500);
      const left = vscode.languages.getDiagnostics(apply.uri);
      check(
        left.filter((d) => d.source === "speja" && d.code === "syntax_error").length === 0,
        "speja can still parse what the actions wrote",
        left.filter((d) => d.source === "speja").map((d) => d.code).join(", ") || "nothing",
      );
      const unresolvedLeft = left.filter((d) => d.code === "unresolved").map((d) =>
        apply.getText(d.range),
      );
      check(
        unresolvedLeft.join(",") === "sequencer",
        "and every name a declare action was applied to now resolves",
        `still unresolved: ${unresolvedLeft.join(", ") || "none"}`,
      );

      // Whether speja writes code speja is happy with. The lines the actions produced are
      // compared against what its own formatter would do to them: if formatting moves them, the
      // generators and the formatter disagree, and the author is the one who finds out.
      const generated = [
        "    signal gate_out :",
        "  signal data_in ",
      ];
      // Inner runs of spaces are alignment, which the formatter owns and two separate actions
      // cannot agree on between them; the indent and the words are what the generators own.
      const settle = (l) => l.replace(/(\S)\s+/g, "$1 ");
      const linesFor = (text) =>
        generated.map(
          (g) => settle(text.split("\n").find((l) => settle(l).startsWith(settle(g))) ?? `MISSING ${g}`),
        );
      const was = linesFor(apply.getText());
      const formatting =
        (await limit(
          vscode.commands.executeCommand(
            "vscode.executeFormatDocumentProvider",
            apply.uri,
            { tabSize: 2, insertSpaces: true },
          ),
          30000,
          "formatting the applied file",
        )) || [];
      const formatted = new vscode.WorkspaceEdit();
      for (const e of formatting) formatted.replace(apply.uri, e.range, e.newText);
      await vscode.workspace.applyEdit(formatted);
      const now = linesFor(apply.getText());
      const moved = was.filter((l, i) => l !== now[i]);
      check(
        moved.length === 0,
        "speja's formatter leaves the lines the actions wrote alone",
        moved.map((l, i) => `${JSON.stringify(l)} -> ${JSON.stringify(now[i])}`).join(" ; "),
      );

      // A file under `speja: exclude` gets nothing from speja, however it is written.
      const excluded = await vscode.workspace.openTextDocument(at("generated/excluded.vhd"));
      await vscode.window.showTextDocument(excluded);
      await wait(2500);
      const fromSpeja = vscode.languages
        .getDiagnostics(excluded.uri)
        .filter((d) => d.source === "speja");
      check(
        fromSpeja.length === 0,
        "an excluded file gets no diagnostics from speja",
        fromSpeja.map((d) => d.code).join(", ") || "none",
      );
    }

    // 16. The case statement as it is actually typed: half written, file not parsing. And a case
    // over something that is declared but is not a state: offering to make it one would declare
    // it a second time.
    {
      const half = await vscode.workspace.openTextDocument(at("halfcase.vhd"));
      await vscode.window.showTextDocument(half);
      await wait(2500);
      const lineOfHalf = (pattern) =>
        half.getText().split("\n").findIndex((l) => pattern.test(l));
      const titlesAt = async (line, word) => {
        const p = new vscode.Position(line, half.lineAt(line).text.indexOf(word) + 1);
        return (
          (await limit(
            vscode.commands.executeCommand(
              "vscode.executeCodeActionProvider",
              half.uri,
              new vscode.Range(p, p),
            ),
            30000,
            `code actions on line ${line + 1}`,
          )) || []
        ).map((a) => a.title);
      };

      const typed = lineOfHalf(/case walker is/);
      const onTyped = await titlesAt(typed, "walker");
      check(
        !onTyped.some((t) => /state machine|missing when choices/.test(t)),
        "a half-typed case over an undeclared name is offered no states",
        onTyped.join(" | ") || "nothing",
      );

      const declared = lineOfHalf(/case counter is/);
      const onDeclared = await titlesAt(declared, "counter");
      check(
        !onDeclared.some((t) => /state machine|missing when choices/.test(t)),
        "and neither is a case over something declared that is not an enumeration",
        onDeclared.join(" | ") || "nothing",
      );

    }

    // 17. A process does not go inside a process. The enum command writes one, so what it does
    // when the type it is pointed at lives in a process's own declarative part is worth knowing.
    {
      const inner = await vscode.workspace.openTextDocument(at("innerfsm.vhd"));
      const innerEditor = await vscode.window.showTextDocument(inner);
      await until(
        async () => (await symbols("innerfsm")).some((s) => /^entity/i.test(s.name)),
        30000,
        "the server to read innerfsm.vhd",
      );
      const typeLine = inner.getText().split("\n").findIndex((l) => /type t_inner is/.test(l));
      innerEditor.selection = new vscode.Selection(
        new vscode.Position(typeLine, inner.lineAt(typeLine).text.indexOf("t_inner") + 1),
        new vscode.Position(typeLine, inner.lineAt(typeLine).text.indexOf("t_inner") + 1),
      );
      const before = inner.getText();
      messages.length = 0;
      await limit(
        vscode.commands.executeCommand("speja.fsmFromEnum"),
        30000,
        "the state machine command on a type inside a process",
      );
      await wait(500);
      const processes = (inner.getText().match(/\bprocess\b/g) ?? []).length;
      check(
        inner.getText() === before && processes === 2,
        "a type declared inside a process gets no state machine written into it",
        `${processes} process keywords`,
      );
      check(
        messages.some((m) => /cannot go inside another one/.test(m)),
        "and the refusal says why, rather than blaming a missing begin",
        messages.join(" | ") || "none",
      );
    }

    // 18. `case mode` and nothing more: no `is`, no arms, no `end case`. The file does not parse,
    // so the server says nothing about `mode` at all (measured: zero hovers, zero definitions).
    // The declaration is in the file, and that is where the states come from.
    {
      const typing = await vscode.workspace.openTextDocument(at("typing.vhd"));
      await vscode.window.showTextDocument(typing);
      await wait(3000);
      const line = typing.getText().split("\n").findIndex((l) => /case mode\s*$/.test(l));
      const at0 = new vscode.Position(line, typing.lineAt(line).text.indexOf("mode") + 1);
      const hovers =
        (await vscode.commands.executeCommand("vscode.executeHoverProvider", typing.uri, at0)) ??
        [];
      check(
        hovers.length === 0,
        "the server has nothing to say about a selector in an unfinished case",
        `${hovers.length} hover(s)`,
      );

      const found = (
        (await limit(
          vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            typing.uri,
            new vscode.Range(at0, at0),
          ),
          30000,
          "code actions on `case mode`",
        )) || []
      ).find((a) => /Write the 3 states of mode/.test(a.title));
      check(!!found, "and `case mode` alone still offers its three states");
      if (found) {
        await vscode.workspace.applyEdit(found.edit);
        await wait(2500);
        const written = typing.getText();
        check(
          /case mode is\n/.test(written) &&
            /when boot =>/.test(written) &&
            /when idle =>/.test(written) &&
            /when active =>/.test(written) &&
            /end case;/.test(written),
          "and writes `is`, an arm per state and the `end case` to close it",
          JSON.stringify(written.split("\n").slice(line, line + 4).join("\n")),
        );
        const bad = vscode.languages
          .getDiagnostics(typing.uri)
          .filter((d) => d.source === "speja" && d.code === "syntax_error");
        check(bad.length === 0, "and the statement now parses", bad.length ? "syntax errors" : "clean");
      }
    }

    // 19. The use-clause fix for a package of the project, not of ieee. The library clause is
    // not there either, so both have to be written, and in the order the file already uses.
    {
      const needs = await vscode.workspace.openTextDocument(at("other/needs_pkg.vhd"));
      await vscode.window.showTextDocument(needs);
      await until(
        async () => (await symbols("counter_pkg")).some((s) => /counter_pkg/i.test(s.name)),
        30000,
        "the server to read counter_pkg",
      );
      await wait(2000);
      const line = needs.getText().split("\n").findIndex((l) => /c_counter_width/.test(l));
      const at0 = new vscode.Position(
        line,
        needs.lineAt(line).text.indexOf("c_counter_width") + 1,
      );
      const offers = (
        (await limit(
          vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            needs.uri,
            new vscode.Range(at0, at0),
          ),
          30000,
          "code actions on a name from a project package",
        )) || []
      ).filter((a) => /^Add use /.test(a.title));
      check(
        offers.some((a) => /counter_pkg/.test(a.title)),
        "a name from a project package is offered its own use clause",
        offers.map((a) => a.title).join(" | ") || "nothing",
      );
      const chosen = offers.find((a) => /counter_pkg/.test(a.title));
      if (chosen) {
        await vscode.workspace.applyEdit(chosen.edit);
        await wait(2500);
        const text = needs.getText();
        const libraryAt = text.indexOf("library mylib;");
        check(
          libraryAt > 0 && text.includes("use mylib.counter_pkg.all;"),
          "and the library clause is written with it",
          JSON.stringify(text.split("\n").slice(0, 6).join("\n")),
        );
        check(
          text.indexOf("library ieee;") < libraryAt &&
            /use ieee\.std_logic_1164\.all;\n\nlibrary mylib;/.test(text),
          "after ieee, with a blank line so the two libraries stay two groups",
          JSON.stringify(text.split("\n").slice(0, 5).join("\n")),
        );
        // The name is used in the architecture, which has no context clause of its own. The
        // clause belongs in the entity's, which the architecture inherits, not in a second one
        // wedged between `end entity` and `architecture`.
        check(
          libraryAt < text.indexOf("entity needs_pkg"),
          "and above the entity, not between it and the architecture that used the name",
          JSON.stringify(text.slice(0, 120)),
        );
        const unresolved = vscode.languages
          .getDiagnostics(needs.uri)
          .filter((d) => d.code === "unresolved");
        check(
          unresolved.length === 0,
          "and the name resolves once it is added",
          unresolved.map((d) => needs.getText(d.range)).join(", ") || "none left",
        );
      }
    }

    // 20. The testbed's own files, verbatim. The same actions that pass above do not appear
    // there, so the difference is in the file rather than in the feature.
    {
      const demo = await vscode.workspace.openTextDocument(at("tb_demo.vhd"));
      await vscode.window.showTextDocument(demo);
      await until(
        async () => (await symbols("declare_demo")).some((s) => /^entity/i.test(s.name)),
        30000,
        "the server to read the testbed demo",
      );
      await wait(2500);
      const text = demo.getText().split("\n");
      const mapLine = text.findIndex((l) => /rst\s*=> sys_rst/.test(l));
      const p = new vscode.Position(mapLine, text[mapLine].indexOf("sys_rst") + 1);
      const titles = (
        (await limit(
          vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            demo.uri,
            new vscode.Range(p, p),
          ),
          30000,
          "code actions in the testbed port map",
        )) || []
      ).map((a) => a.title);
      out("INFO  testbed port map offers: " + (titles.join(" | ") || "nothing"));
      const syms = await documentSymbols(demo.uri);
      const flat = [];
      const walk = (list) => list.forEach((x) => { flat.push(x.name); walk(x.children || []); });
      walk(syms);
      out("INFO  testbed symbols: " + flat.join(", "));
      const instSym = (function find(list) {
        for (const x of list) {
          if (/^instance/i.test(x.name)) return x;
          const inner = find(x.children || []);
          if (inner) return inner;
        }
        return null;
      })(syms);
      out(
        "INFO  instance symbol range: " +
          (instSym
            ? `${instSym.range.start.line + 1}:${instSym.range.start.character}..${instSym.range.end.line + 1}:${instSym.range.end.character}  selection ${instSym.selectionRange.start.line + 1}..${instSym.selectionRange.end.line + 1}`
            : "no instance symbol"),
      );
      check(
        titles.some((t) => /signals? for this port map/.test(t)),
        "the testbed's own port map offers to declare its actuals",
        titles.join(" | ") || "nothing",
      );
    }

    // 21. Instantiation the way it is typed: a label and a colon, a library and a dot, a bare
    // word, a component. Each is offered above everything VHDL-LS puts in the list, and what
    // is accepted lands as VHDL the server accepts.
    {
      const { document, shown, uri } = await open("inst.vhd");
      await until(
        async () => (await symbols("inst_here")).some((s) => /^entity/i.test(s.name)),
        30000,
        "the server to read inst.vhd",
      );
      const endLine = () => document.getText().split("\n").findIndex((l) => l.startsWith("end architecture"));
      const typeLine = async (text) => {
        const line = endLine();
        await shown.edit((e) => e.insert(new vscode.Position(line, 0), text + "\n"));
        return line;
      };
      const itemsAt = async (line, column) =>
        (
          (await limit(
            vscode.commands.executeCommand(
              "vscode.executeCompletionItemProvider",
              uri,
              new vscode.Position(line, column),
              undefined,
              2000,
            ),
            30000,
            `completion on line ${line + 1}`,
          )) || { items: [] }
        ).items;
      const name = (i) => i.label.label || i.label;
      const ours = (items) => items.filter((i) => /^instantiate/.test(i.detail || ""));
      const text = (i) => (i.insertText && (i.insertText.value || String(i.insertText))) || "";

      // `i_a : ` and the list opens on entities from every library, above VHDL-LS's rows.
      const a = await typeLine("  i_a : ");
      const onLabel = ours(await itemsAt(a, 8));
      check(
        onLabel.some((i) => name(i) === "fifo") && onLabel.some((i) => name(i) === "leaf"),
        "a label and a colon offer entities from every library",
        onLabel.map((i) => `${name(i)}[${i.detail}]`).slice(0, 6).join(" | "),
      );
      check(
        onLabel.every((i) => /^0_/.test(i.sortText || "")),
        "and they sort above everything VHDL-LS offers",
      );
      const fifoEntity = onLabel.find((i) => name(i) === "fifo" && /instantiate \w+\.fifo/.test(i.detail));
      check(
        !!fifoEntity && fifoEntity.range.start.character === 8 && /entity work\.fifo/.test(text(fifoEntity)) && !/i_fifo/.test(text(fifoEntity)),
        "an entity accepted after a label starts at `entity`, the label is not written twice",
        fifoEntity ? JSON.stringify(text(fifoEntity).split("\n")[0]) : "no entity item",
      );
      // The editor ranks by how well the typed text matches the match text, before any sort
      // key, so the match text follows the form being typed and the list is re-asked for.
      check(
        !!fifoEntity && fifoEntity.filterText === "fifo",
        "with nothing typed after the colon, the entity matches on its bare name",
        fifoEntity && fifoEntity.filterText,
      );
      if (fifoEntity) {
        await shown.insertSnippet(new vscode.SnippetString(text(fifoEntity)), fifoEntity.range);
        const written = document.getText();
        check(
          /i_a : entity work\.fifo\n\s+generic map/.test(written),
          "and accepting it writes the instantiation after the label",
          JSON.stringify(written.split("\n").find((l) => /i_a :/.test(l))),
        );
      }

      // Accepting an item, as the editor does: the snippet over the item's range, and the
      // context clause it carries. Each probe is accepted before the next line is typed, so
      // nothing half-written is left for the parse check at the end to trip on.
      const accept = async (item) => {
        await shown.insertSnippet(new vscode.SnippetString(text(item)), item.range);
        for (const e of item.additionalTextEdits || [])
          await shown.edit((b) => b.insert(e.range.start, e.newText));
      };

      // The component declared in this file, by bare name, with no `entity` and no library.
      const c = await typeLine("  i_c : ");
      const component = ours(await itemsAt(c, 8)).find((i) => /component/.test(i.detail || ""));
      check(
        !!component && /^fifo\n\s+generic map/.test(text(component)) && !/entity/.test(text(component)),
        "a component declaration is offered and instantiated by bare name",
        component ? JSON.stringify(text(component).split("\n").slice(0, 2).join(" ")) : "no component item",
      );
      if (component) await accept(component);

      // `i_b : other.` narrows to that library, and brings its library clause.
      const b = await typeLine("  i_b : other.");
      const onLibrary = ours(await itemsAt(b, 14));
      // Every entity is returned and the editor's fuzzy matcher narrows them, so `myl.fi` finds
      // mylib.fifo as well as `mylib.fi` does; what matters is that the match text now carries
      // the library, so `other.` matches only other's.
      check(
        onLibrary.some((i) => name(i) === "leaf") &&
          onLibrary.every((i) => /^\w+\.\w+$/.test(i.filterText || "")) &&
          onLibrary.filter((i) => /^other\./.test(i.filterText)).every((i) => /other\./.test(i.detail)),
        "after a library and a dot, the entities match on library and name",
        onLibrary.map((i) => i.filterText).slice(0, 5).join(" | ") || "nothing",
      );
      const leaf = onLibrary.find((i) => name(i) === "leaf");
      check(
        !!leaf && /^entity other\.leaf/.test(text(leaf)) && (leaf.additionalTextEdits || []).some((e) => /library other;/.test(e.newText)),
        "and the accepted one replaces what was typed and adds `library other;`",
        leaf ? JSON.stringify(text(leaf).split("\n")[0]) : "no leaf",
      );
      if (leaf) await accept(leaf);

      // A bare word still supplies the label, and a library and a dot alone list that library.
      const w = await typeLine("  other.");
      const onWord = ours(await itemsAt(w, 8));
      const wordLeaf = onWord.find((i) => name(i) === "leaf" && /\$\{1:i_leaf\} : entity other\.leaf/.test(text(i)));
      check(
        !!wordLeaf,
        "a bare `library.` supplies the label and the entity",
        onWord.map((i) => JSON.stringify(text(i).split("\n")[0])).join(" | ") || "nothing",
      );
      if (wordLeaf) await accept(wordLeaf);

      // Nothing of this inside a port clause or a process, where `x : ` is a declaration.
      const port = document.getText().split("\n").findIndex((l) => /clk : in std_logic/.test(l));
      const inPort = ours(await itemsAt(port, document.lineAt(port).text.indexOf(":") + 2));
      check(inPort.length === 0, "a `name :` in a port clause is left to the server", `${inPort.length} offered`);

      // What was written is VHDL, the actuals aside.
      const bad = (await settle(uri)).filter((d) => /Unexpected|expected/i.test(d.message));
      check(bad.length === 0, "and the server parses what was written", bad.map((d) => d.message).join(" | ") || "clean");
    }

    // 22. The lightbulb on every unresolved name in a file built to have one of each kind, with
    // the whole menu written out for review and checked against what it should say.
    {
      const doc = await vscode.workspace.openTextDocument(at("audit.vhd"));
      await vscode.window.showTextDocument(doc);
      await until(async () => (await symbols("audit")).some((x) => /^entity 'audit'/i.test(x.name)), 30000, "audit.vhd");
      await wait(3000);
      const menus = new Map();
      for (const d of vscode.languages.getDiagnostics(doc.uri).filter((x) => x.code === "unresolved")) {
        const nm = doc.getText(d.range);
        const p = new vscode.Position(d.range.start.line, d.range.start.character + 1);
        const acts = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, new vscode.Range(p, p))) || [];
        const titles = acts.map((a) => `${a.title}${a.isPreferred ? "*" : ""}`).filter((t) => !/^(Fix|Explain)$/.test(t));
        menus.set(nm, titles);
        out(`AUDIT menu L${d.range.start.line + 1} ${nm}: ${titles.join(" | ")}`);
      }
      const menu = (nm) => menus.get(nm) || [];
      const ours = (nm) => menu(nm).filter((t) => /^(Add use|Declare)/.test(t));
      const exactly = (nm, want, why) =>
        check(JSON.stringify(ours(nm)) === JSON.stringify(want), why, ours(nm).join(" | ") || "nothing");

      exactly("c_depth", ["Add use work.audit_pkg.all*"], "a package constant: the use clause, from `work`, preferred, and nothing else");
      exactly("t_mode", ["Add use work.audit_pkg.all*"], "a package type: the use clause only");
      exactly("clamp", ["Add use work.audit_pkg.all*"], "a package function: the use clause, not a signal called `clamp`");
      exactly("m_idle", ["Add use work.audit_pkg.all*"], "a package enumeration literal: the use clause only");
      exactly("t_nowhere", [], "a type nobody declares, in a type position: no object declaration stands in for it");
      exactly("value", ["Declare signal value", "Declare constant value"],
        "a name that is only another entity's port is declared, never `use`d from that entity");
      exactly("field_a", ["Declare signal field_a", "Declare constant field_a"], "a record field name is not importable on its own");
      exactly("limit", ["Declare signal limit", "Declare constant limit"], "a parameter name of a package function is not importable");
      exactly("rst_x", ["Declare signal rst_x"], "a name in a sensitivity list can only be a signal");
      exactly("clkk", [], "a formal that is not a port of the entity is a typo, not a signal to declare");
      const busy = menu("busy_x");
      check(new Set(busy).size === busy.length, "a name used twice on a line gets one menu without repeats", busy.join(" | "));
      check([...menus.values()].flat().every((t) => t.trim().length > 0 && !/undefined|null|NaN/.test(t)),
        "no menu entry is empty or carries a placeholder");
    }

    // 24. Where declarations land, and when the port-map action appears.
    {
      const doc = await vscode.workspace.openTextDocument(at("sites.vhd"));
      await vscode.window.showTextDocument(doc);
      await until(async () => (await symbols("sites")).some((x) => /^entity 'sites'/i.test(x.name)), 30000, "sites.vhd");
      await wait(3000);
      const titlesAt = async (d, line, col) => {
        const p = new vscode.Position(line, col);
        return ((await vscode.commands.executeCommand("vscode.executeCodeActionProvider", d.uri, new vscode.Range(p, p))) || [])
          .map((a) => a.title);
      };
      const lineOf = (d, re) => d.getText().split("\n").findIndex((l) => re.test(l));
      const apply = async (d, line, col, title) => {
        const p = new vscode.Position(line, col);
        const a = ((await vscode.commands.executeCommand("vscode.executeCodeActionProvider", d.uri, new vscode.Range(p, p))) || [])
          .find((x) => x.title === title);
        if (!a) return false;
        if (a.edit) await vscode.workspace.applyEdit(a.edit);
        else await vscode.commands.executeCommand(a.command.command, ...a.command.arguments);
        await wait(700);
        return true;
      };

      // The cursor at column 0 of the label line, and in a commented map.
      const label = lineOf(doc, /u_fifo : entity/);
      const atZero = await titlesAt(doc, label, 0);
      check(atZero.some((t) => /^Declare \d+ signals? for this port map$/.test(t)),
        "the port-map action is offered with the cursor in the indentation", atZero.join(" | "));
      const commented = await titlesAt(doc, lineOf(doc, /rst => rst_b/), 30);
      const count = Number((commented.find((t) => /for this port map/.test(t)) || "").replace(/\D+/g, " ").trim().split(" ")[0] || 0);
      // rst_b and data_in: data_in is declared only in the first architecture, and a comment on
      // every line must not hide either.
      check(count === 2, "a map with a comment on every line offers both its undeclared actuals", commented.join(" | "));
      out(`INFO sites port-map offer: ${commented.find((t) => /for this port map/.test(t))}`);

      // Declared through the action, the signals land in the second architecture, after the
      // function body, before its begin: not in the first architecture, not in the function.
      check(await apply(doc, label, 0, commented.find((t) => /for this port map/.test(t))), "and applies");
      const text = doc.getText().split("\n");
      const rstLine = text.findIndex((l) => /signal rst_b\b/.test(l));
      const secondHeader = text.findIndex((l) => /^architecture second/.test(l));
      const secondBegin = text.findIndex((l, i) => i > secondHeader && /^begin\b/.test(l));
      const fnEnd = text.findIndex((l) => /end function twice/.test(l));
      check(rstLine > fnEnd && rstLine < secondBegin,
        "a signal for the second architecture is declared in it, after the function body",
        `rst_b at ${rstLine + 1}, function ends ${fnEnd + 1}, begin ${secondBegin + 1}`);

      // A variable in a process that declares a procedure goes in the process, not the procedure.
      const tmp = lineOf(doc, /tmp_v := 1/);
      check(await apply(doc, tmp, doc.lineAt(tmp).text.indexOf("tmp_v") + 1, "Declare variable tmp_v"), "the variable action applies");
      const after = doc.getText().split("\n");
      const vLine = after.findIndex((l) => /variable tmp_v\b/.test(l));
      const procEnd = after.findIndex((l) => /end procedure bump/.test(l));
      const pBegin = after.findIndex((l, i) => i > procEnd && /^\s*begin\b/.test(l));
      check(vLine > procEnd && vLine < pBegin,
        "a variable is declared in the process, after the procedure it declares",
        `tmp_v at ${vLine + 1}, procedure ends ${procEnd + 1}, process begin ${pBegin + 1}`);

      // An instance below a process: its signals go to the architecture, not into the process
      // whose `begin` is the nearest one above the instance.
      const late = lineOf(doc, /rst => rst_late/);
      check(await apply(doc, late, 10, "Declare 1 signal for this port map"), "the port-map action applies below a process");
      const now = doc.getText().split("\n");
      const lateLine = now.findIndex((l) => /signal rst_late\b/.test(l));
      const archBegin = now.findIndex((l, i) => i > now.findIndex((x) => /^architecture second/.test(x)) && /^begin\b/.test(l));
      check(lateLine > 0 && lateLine < archBegin && /^  signal/.test(now[lateLine]),
        "and declares it before the architecture's begin, indented as a declaration",
        `rst_late at ${lateLine + 1} ${JSON.stringify(now[lateLine] || "")}, architecture begin ${archBegin + 1}`);

      // A file that does not analyse still offers the port-map action.
      const broken = await vscode.workspace.openTextDocument(at("broken.vhd"));
      await vscode.window.showTextDocument(broken);
      await wait(3000);
      const onBroken = await titlesAt(broken, lineOf(broken, /rst => rst_c/), 10);
      check(onBroken.some((t) => /for this port map/.test(t)),
        "an instance in a file that does not analyse still offers its actuals", onBroken.join(" | ") || "nothing");
    }

    // 25. Every action as a command: registered, named once under `speja`, and doing what its
    // name says from the palette, the menu and a key.
    {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.env.VSGRS_EXT, "package.json"), "utf8"));
      const contributed = pkg.contributes.commands;
      const registered = new Set(await vscode.commands.getCommands(true));
      const unregistered = contributed.filter((c) => !registered.has(c.command)).map((c) => c.command);
      check(unregistered.length === 0, "every contributed command is registered", unregistered.join(", ") || "all");
      check(contributed.every((c) => c.category === "speja" && !/^(VHDL|speja):/i.test(c.title)),
        "every command sits under `speja` once, not `VHDL: VHDL:`",
        contributed.filter((c) => c.category !== "speja" || /:/.test(c.title)).map((c) => c.title).join(" | ") || "all");
      const inMenu = new Set(pkg.contributes.menus["speja.context"].map((m) => m.command));
      const missingFromMenu = contributed.filter((c) => !["speja.restartServer", "speja.showOutput", "speja.showVersion", "speja.refreshHierarchy", "speja.fixAll"].includes(c.command) && !inMenu.has(c.command));
      check(missingFromMenu.length === 0, "the right-click speja menu carries every editing command",
        missingFromMenu.map((c) => c.command).join(", ") || "all");

      // Format Document through speja's own server.
      const lay = await vscode.workspace.openTextDocument(at("audit.vhd"));
      const layEd = await vscode.window.showTextDocument(lay);
      const beforeFormat = lay.getText();
      // Put the file back by content, not by `undo`, which needs the window to hold focus.
      const restore = async () => {
        const all = new vscode.WorkspaceEdit();
        all.replace(lay.uri, new vscode.Range(lay.positionAt(0), lay.positionAt(lay.getText().length)), beforeFormat);
        await vscode.workspace.applyEdit(all);
        await wait(1500);
      };
      await vscode.commands.executeCommand("speja.formatDocument");
      await wait(1500);
      check(lay.getText() !== beforeFormat, "speja: Format Document formats the file");
      await restore();

      // The menu runs what is picked.
      pick = "Format Document";
      const beforeMenu = lay.getText();
      await vscode.commands.executeCommand("speja.showMenu");
      await wait(1500);
      check(offeredLabels.includes("Format Selection") && offeredLabels.includes("Instantiate Entity...") && !offeredLabels.includes("Fix All Findings"),
        "the speja menu lists the actions", offeredLabels.slice(0, 6).join(" | "));
      check(lay.getText() !== beforeMenu, "and picking one runs it");
      await restore();
      pick = "fifo";

      // Quick Fixes at Cursor: the server's fixes and the editing actions in one list.
      const typoLine = lay.getText().split("\n").findIndex((l) => /some_out <= typo_sig/.test(l));
      const typoCol = lay.lineAt(typoLine).text.indexOf("typo_sig") + 1;
      layEd.selection = new vscode.Selection(typoLine, typoCol, typoLine, typoCol);
      pick = "Declare signal typo_sig";
      await vscode.commands.executeCommand("speja.quickFix");
      await wait(1200);
      check(offeredLabels.includes("Declare signal typo_sig") && offeredLabels.some((l) => /^Fix all speja findings$|^speja: format line/.test(l)),
        "Quick Fixes at Cursor lists the editing actions and the server's fixes together", offeredLabels.join(" | "));
      check(/signal typo_sig\b/.test(lay.getText()), "and runs the one picked");
      pick = "fifo";

      // Declare Name Under Cursor, from a key.
      const busyLine = lay.getText().split("\n").findIndex((l) => /busy_x <= busy_x and go/.test(l));
      layEd.selection = new vscode.Selection(busyLine, 7, busyLine, 7);
      pick = "Declare signal busy_x";
      await vscode.commands.executeCommand("speja.declare");
      await wait(1200);
      check(/signal busy_x\b/.test(lay.getText()), "speja: Declare Name Under Cursor declares it");
      pick = "fifo";

      // Add Use Clause, searching every package.
      let picker = null;
      const realCreate = vscode.window.createQuickPick;
      vscode.window.createQuickPick = () => {
        const on = {};
        let value = "";
        picker = {
          items: [], selectedItems: [], busy: false, title: "", placeholder: "", matchOnDescription: false,
          onDidChangeValue: (h) => (on.change = h), onDidAccept: (h) => (on.accept = h), onDidHide: (h) => (on.hide = h),
          show() {}, hide() { if (on.hide) on.hide(); }, dispose() {},
          get value() { return value; },
          set value(v) { value = v; if (on.change) on.change(v); },
          type(v) { this.value = v; },
          accept(item) { this.selectedItems = [item]; on.accept(); },
        };
        return picker;
      };
      const clampLine = lay.getText().split("\n").findIndex((l) => /count <= clamp/.test(l));
      layEd.selection = new vscode.Selection(clampLine, lay.lineAt(clampLine).text.indexOf("clamp") + 1, clampLine, lay.lineAt(clampLine).text.indexOf("clamp") + 1);
      const running = vscode.commands.executeCommand("speja.addUseClause");
      await until(async () => picker && picker.items.length > 0, 20000, "the use-clause list to fill");
      const opened = picker.items.map((i) => `${i.label}:${i.description}`);
      check(picker.value === "clamp" && opened.some((r) => /^clamp:work\.audit_pkg/.test(r)),
        "Add Use Clause opens on the name under the cursor, from work", opened.join(" | "));
      picker.type("numeric_s");
      await until(async () => picker.items.some((i) => /numeric_std/i.test(i.label)), 20000, "packages by name");
      check(picker.items.some((i) => /^numeric_std$/i.test(i.label) && /the package itself/.test(i.detail)),
        "a package can be found by its own name", picker.items.slice(0, 4).map((i) => `${i.label}:${i.description}`).join(" | "));
      picker.type("clamp");
      await until(async () => picker.items.some((i) => i.label === "clamp"), 20000, "back to clamp");
      picker.accept(picker.items.find((i) => i.label === "clamp"));
      await running;
      await wait(500);
      vscode.window.createQuickPick = realCreate;
      check(/^use work\.audit_pkg\.all;$/m.test(lay.getText()), "and picking a row adds its package's use clause");
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }

    // 26. Asked for one kind of action, only that kind comes back: VS Code drops the rest and logs
    // a warning for each, which filled the extension host log on every lightbulb.
    {
      const d = await vscode.workspace.openTextDocument(at("audit.vhd"));
      await vscode.window.showTextDocument(d);
      const l = d.getText().split("\n").findIndex((x) => /count <= clamp/.test(x));
      const sel = new vscode.Range(l, 15, l, 27);
      const fixesOnly = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", d.uri, sel, "quickfix")) || [];
      const refactors = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", d.uri, sel, "refactor.extract")) || [];
      check(!fixesOnly.some((a) => /^Extract to/.test(a.title)) && refactors.some((a) => /^Extract to/.test(a.title)),
        "quick fixes asked for, no refactoring is returned; refactorings asked for, they are",
        `${fixesOnly.filter((a) => /^Extract/.test(a.title)).length} extract in quickfix, ${refactors.length} refactorings`);
    }

    // 26. Asked for one kind of action, only that kind comes back: VS Code drops the rest and logs
    // a warning for each, which filled the extension host log on every lightbulb.
    {
      const d = await vscode.workspace.openTextDocument(at("audit.vhd"));
      await vscode.window.showTextDocument(d);
      const l = d.getText().split("\n").findIndex((x) => /count <= clamp/.test(x));
      const sel = new vscode.Range(l, 15, l, 27);
      const fixesOnly = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", d.uri, sel, "quickfix")) || [];
      const refactors = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", d.uri, sel, "refactor.extract")) || [];
      check(!fixesOnly.some((a) => /^Extract to/.test(a.title)) && refactors.some((a) => /^Extract to/.test(a.title)),
        "quick fixes asked for, no refactoring is returned; refactorings asked for, they are",
        `${fixesOnly.filter((a) => /^Extract/.test(a.title)).length} extract in quickfix, ${refactors.length} refactorings`);
    }

    // 23. What typing offers. Every row every provider returns, VHDL-LS's included, is written
    // out for each case, to be ranked the way the editor ranks them: VS Code's own fuzzy scorer,
    // then its comparator. A real keystroke test needs the window to hold keyboard focus, which a
    // desktop session does not promise, so the ranking is reproduced rather than observed. What
    // is checked here is the invariant that makes our row rank first: its match text starts with
    // what was typed, and its sort key wins a tie.
    {
      const cases = [
        ["audit.vhd", /count <= clamp/, "      cou"],
        ["audit.vhd", /some_out <= typo_sig/, "  p_x : pro"],
        ["audit.vhd", /some_out <= typo_sig/, "  g_x : fo"],
        ["audit.vhd", /some_out <= typo_sig/, "  i_x : fif"],
        ["audit.vhd", /some_out <= typo_sig/, "  i_x : myl.fi"],
        ["audit.vhd", /some_out <= typo_sig/, "  i_x : other.le"],
        ["audit.vhd", /some_out <= typo_sig/, "  i_x : entity other.le"],
        ["audit.vhd", /some_out <= typo_sig/, "  fif"],
        ["audit.vhd", /some_out <= typo_sig/, "  som"],
        ["inst.vhd", /^end architecture/, "  i_c : fif"],
        ["audit.vhd", /some_out <= typo_sig/, "  i_c : fif"],
        ["audit.vhd", /count <= clamp/, "      count <= to_uns"],
        ["audit.vhd", /^  port \($/, "    cl"],
      ];
      const dump = [];
      for (const [file, anchor, text] of cases) {
        const doc = await vscode.workspace.openTextDocument(at(file));
        const ed = await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const line = original.split("\n").findIndex((l) => anchor.test(l));
        await ed.edit((e) => e.insert(new vscode.Position(line + (/port \(/.test(original.split("\n")[line]) ? 1 : 0), 0), text + "\n"));
        const row = line + (/port \(/.test(original.split("\n")[line]) ? 1 : 0);
        const pos = new vscode.Position(row, text.length);
        const list = (await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", doc.uri, pos, undefined, 400)) || { items: [] };
        const items = list.items.map((c) => {
          const r = c.range && (c.range.inserting || c.range);
          return {
            label: typeof c.label === "string" ? c.label : c.label.label,
            filterText: c.filterText,
            sortText: c.sortText,
            kind: c.kind,
            start: r ? r.start.character : undefined,
            detail: c.detail,
            insert: (c.insertText && (c.insertText.value || String(c.insertText)) || "").split("\n")[0],
            ours: /^instantiate|\./.test(c.detail || "") && (/^instantiate/.test(c.detail || "") || c.kind === vscode.CompletionItemKind.Function || c.kind === vscode.CompletionItemKind.Constant),
          };
        });
        dump.push({ file, text, column: text.length, incomplete: !!list.isIncomplete, items });
        const whole = new vscode.WorkspaceEdit();
        whole.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
        await vscode.workspace.applyEdit(whole);
      }
      fs.writeFileSync(process.env.VSGRS_RESULTS.replace(/results\.txt$/, "completions.json"), JSON.stringify(dump, null, 1));
      const caseOf = (file, text) => dump.find((d) => d.file === file && d.text === text);
      // The typed text VS Code matches our row against: from the row's range start to the cursor.
      const wordFor = (c, it) => c.text.slice(it.start ?? c.column, c.column).trimStart().toLowerCase();
      const leads = (c, pred) => {
        const it = c.items.find(pred);
        return !!it && (it.filterText || it.label).toLowerCase().startsWith(wordFor(c, it)) && /^0_/.test(it.sortText || "");
      };
      const inst = (lib, n) => (i) => i.detail === `instantiate ${lib}.${n}`;
      for (const [text, lib, n] of [
        ["  i_x : fif", "mylib", "fifo"],
        ["  i_x : myl.fi", "mylib", "fifo"],
        ["  i_x : other.le", "other", "leaf"],
        ["  i_x : entity other.le", "other", "leaf"],
        ["  fif", "mylib", "fifo"],
      ]) {
        const c = caseOf("audit.vhd", text);
        check(
          !!c && (text.includes("myl.") ? !!c.items.find(inst(lib, n)) : leads(c, inst(lib, n))),
          `typing ${JSON.stringify(text.trim())} puts ${lib}.${n} in the top tier`,
          c && JSON.stringify((c.items.find(inst(lib, n)) || {}).filterText),
        );
      }
      const inFile = caseOf("inst.vhd", "  i_c : fif");
      check(
        !!inFile && inFile.items.some((i) => i.detail === "instantiate component fifo" && /^0_0_/.test(i.sortText)),
        "a component declared in the file sorts ahead of the entity of the same name",
      );
      const foreign = caseOf("audit.vhd", "  i_c : fif");
      check(!!foreign && !foreign.items.some((i) => /instantiate component/.test(i.detail || "")),
        "a component declared in another file is never offered");
      const inProc = caseOf("audit.vhd", "      cou");
      check(!!inProc && !inProc.items.some((i) => /^instantiate/.test(i.detail || "")),
        "inside a process nothing offers to instantiate");
      const imp = caseOf("audit.vhd", "      count <= to_uns");
      const importRows = imp ? imp.items.filter((i) => /^ieee\./i.test(i.detail || "")) : [];
      const best = [...importRows].sort((a, b) => (a.sortText < b.sortText ? -1 : 1))[0];
      check(
        importRows.length > 0 &&
          importRows.every((i) => !/generic_pkg/i.test(i.detail) && i.label === "to_unsigned") &&
          /numeric_std/i.test(best.detail),
        "an import typed in lower case is offered in lower case, numeric_std first, no generic packages",
        importRows.map((i) => `${i.label}:${i.detail}`).join(" | "),
      );
      const port = caseOf("audit.vhd", "    cl");
      check(!!port && !port.items.some((i) => /\.\w+_pkg$|^work\./i.test(i.detail || "")),
        "a new port's name is not offered an import",
        port && port.items.filter((i) => /_pkg/i.test(i.detail || "")).map((i) => i.detail).join(" | "));
    }

    out("done");
  } catch (error) {
    out("HARNESS ERROR: " + (error && error.stack ? error.stack : error));
    out("done");
  }
};
