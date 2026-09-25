// The speja VS Code client.
//
// This extension launches `speja lsp` and speaks LSP to it. That is all it does: there is no
// VHDL parsing here, no formatter, no rules and no configuration of them. Everything a user sees
// is decided by speja itself, so an editor and the command line cannot disagree.
//
// Rules and formatting are configured in the project's own `speja.yaml`, not in VS Code
// settings. The settings here are only about which executable to run.

import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  CodeAction,
  CodeActionKind,
  ExtensionContext,
  OutputChannel,
  Range,
  StatusBarAlignment,
  TextDocument,
  Uri,
  WorkspaceEdit,
  commands,
  languages,
  window,
  workspace,
} from "vscode";
import {
  applicableCommands,
  editingActionsAt,
  registerEditingFeatures,
  runAction,
} from "./editing";
import {
  CodeActionRequest,
  DocumentFormattingRequest,
  DocumentRangeFormattingRequest,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let output: OutputChannel | undefined;

/**
 * The server bundled with this extension, if this platform has one.
 *
 * A VSIX is built per platform and carries one binary, so a missing file means the user installed
 * an extension that was not built for the machine it is running on. Saying so is more use than
 * failing to spawn something that was never there.
 */
function embeddedServer(context: ExtensionContext): string | undefined {
  const name = process.platform === "win32" ? "speja.exe" : "speja";
  const path = join(context.extensionPath, "server", name);
  return existsSync(path) ? path : undefined;
}

/** The executable to run, from the settings. */
function serverPath(context: ExtensionContext): string | undefined {
  const settings = workspace.getConfiguration("speja");
  const mode = settings.get<string>("server.mode", "embedded");
  if (mode === "userPath") {
    const configured = settings.get<string>("server.path", "").trim();
    if (configured.length > 0) {
      return configured;
    }
    output?.appendLine(
      "speja.server.mode is userPath but speja.server.path is empty; using PATH instead.",
    );
    return "speja";
  }
  if (mode === "systemPath") {
    return "speja";
  }
  const embedded = embeddedServer(context);
  if (embedded === undefined) {
    output?.appendLine(
      `No server is bundled for ${process.platform}-${process.arch}. ` +
        "Install speja and set speja.server.mode to systemPath.",
    );
  }
  return embedded;
}

async function start(context: ExtensionContext): Promise<void> {
  const command = serverPath(context);
  if (command === undefined) {
    void window
      .showErrorMessage(
        `speja: no server is bundled for ${process.platform}-${process.arch}.`,
        "Show Output",
      )
      .then((choice) => {
        if (choice === "Show Output") {
          output?.show();
        }
      });
    return;
  }
  // A VSIX does not always preserve the executable bit, so the bundled server may arrive
  // unrunnable. Setting it is cheap and does nothing when it is already right.
  if (process.platform !== "win32" && command !== "speja") {
    await chmod(command, 0o755).catch(() => undefined);
  }
  const server: ServerOptions = {
    run: { command, args: ["lsp"], transport: TransportKind.stdio },
    debug: { command, args: ["lsp"], transport: TransportKind.stdio },
  };
  const options: LanguageClientOptions = {
    // Only VHDL, and only speja's own diagnostics: another server can serve the same files.
    documentSelector: [{ scheme: "file", language: "vhdl" }],
    outputChannel: output,
    // The project's own files decide the rules. Nothing is sent, but an edit to one of them
    // tells the server to analyse the open files again.
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher(
        `**/{speja.yaml,.speja.yaml,speja.json,.speja.json,vhdl_ls.toml,${
          workspace.getConfiguration("speja").get<string>("waiverFile") ?? "speja-waivers.yaml"
        }}`,
      ),
    },
    // What a waiver file is called. The server finds it by walking up from the source file and
    // creates one at the workspace root when a project has none.
    initializationOptions: {
      waiverFile: workspace.getConfiguration("speja").get<string>("waiverFile"),
    },
  };
  client = new LanguageClient("speja", "speja", server, options);
  try {
    await client.start();
    output?.appendLine(`Started ${command}`);
  } catch (error) {
    client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    output?.appendLine(`Could not start ${command}: ${message}`);
    void window
      .showErrorMessage(
        `speja: could not start "${command}". Install speja, or set speja.server.path.`,
        "Show Output",
      )
      .then((choice) => {
        if (choice === "Show Output") {
          output?.show();
        }
      });
  }
}

/** What the extension is, and what the server it just launched reports itself to be. */
async function showVersion(context: ExtensionContext): Promise<void> {
  const extension = context.extension.packageJSON.version as string;
  const command = serverPath(context) ?? "speja";
  let server = "not found";
  try {
    const { stdout } = await promisify(execFile)(command, ["--version"]);
    server = stdout.trim();
  } catch (error) {
    server = error instanceof Error ? error.message : String(error);
  }
  output?.appendLine(`extension: ${extension}`);
  output?.appendLine(`server:    ${server}`);
  output?.appendLine(`from:      ${command}`);
  output?.show();
}

/**
 * Ask speja's own server for an edit to the active VHDL file and apply it: formatting the
 * document or the selection, or the fix-all or organize-imports source action.
 *
 * Going to the server rather than through `editor.action.formatDocument` means the command does
 * what its name says even where another extension is the default VHDL formatter.
 */
async function serverEdit(
  what: "document" | "selection" | "fixAll" | "sort",
): Promise<void> {
  try {
    await askServer(what);
  } catch (error) {
    // A file the server cannot parse is refused, and saying why beats a generic command failure.
    void window.showErrorMessage(
      `speja: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The server changes nothing in a file it cannot parse, which is not the same as nothing to do:
 * the message for that case, or undefined when the file parses.
 */
function unparsed(uri: Uri): string | undefined {
  return languages
    .getDiagnostics(uri)
    .some((d) => d.source === "speja" && d.code === "syntax")
    ? "speja: the file has syntax errors, see Problems."
    : undefined;
}

async function askServer(
  what: "document" | "selection" | "fixAll" | "sort",
): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vhdl") return;
  if (!client) {
    void window.showErrorMessage("speja: the server is not running.");
    return;
  }
  const document = editor.document;
  const c2p = client.code2ProtocolConverter;
  const p2c = client.protocol2CodeConverter;
  const textDocument = c2p.asTextDocumentIdentifier(document);
  const options = {
    tabSize: Number(editor.options.tabSize) || 2,
    insertSpaces: editor.options.insertSpaces !== false,
  };
  if (what === "selection" && editor.selection.isEmpty) {
    void window.showInformationMessage("speja: select the lines to format.");
    return;
  }
  const edit = new WorkspaceEdit();
  if (what === "document" || what === "selection") {
    const edits =
      what === "document"
        ? await client.sendRequest(DocumentFormattingRequest.type, {
            textDocument,
            options,
          })
        : await client.sendRequest(DocumentRangeFormattingRequest.type, {
            textDocument,
            range: c2p.asRange(editor.selection),
            options,
          });
    if (!edits?.length) {
      void window.showInformationMessage(
        unparsed(document.uri) ?? "speja: already formatted.",
      );
      return;
    }
    edit.set(document.uri, await p2c.asTextEdits(edits));
    await workspace.applyEdit(edit);
    return;
  }
  const kind = what === "fixAll" ? "source.fixAll" : "source.organizeImports";
  const whole = new Range(0, 0, document.lineCount, 0);
  const result = await client.sendRequest(CodeActionRequest.type, {
    textDocument,
    range: c2p.asRange(whole),
    context: { diagnostics: [], only: [kind] },
  });
  const found = result?.find((a) => "edit" in a && a.edit);
  if (!found || !("edit" in found) || !found.edit) {
    void window.showInformationMessage(
      unparsed(document.uri) ??
        (what === "fixAll"
          ? "speja: nothing it can fix safely."
          : "speja: the library and use clauses are already in order."),
    );
    return;
  }
  await workspace.applyEdit(await p2c.asWorkspaceEdit(found.edit));
}

/**
 * Every quick fix at the cursor, speja's server's and the editing actions together, as a list:
 * the lightbulb's speja entries, reachable from a key.
 */
async function quickFixes(): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vhdl") return;
  const range = new Range(editor.selection.start, editor.selection.end);
  const actions: CodeAction[] = [
    ...(await editingActionsAt(editor.document, range)),
  ];
  if (client) {
    const c2p = client.code2ProtocolConverter;
    const diagnostics = languages
      .getDiagnostics(editor.document.uri)
      .filter((d) => d.source === "speja" && d.range.intersection(range));
    // The editing actions stand on their own, so a server that refuses still leaves them listed.
    const result = await client
      .sendRequest(CodeActionRequest.type, {
        textDocument: c2p.asTextDocumentIdentifier(editor.document),
        range: c2p.asRange(range),
        context: { diagnostics: await c2p.asDiagnostics(diagnostics) },
      })
      .catch(() => null);
    for (const a of (await client.protocol2CodeConverter.asCodeActionResult(
      result ?? [],
    )) ?? [])
      if (a instanceof CodeAction) actions.push(a);
  }
  if (!actions.length) {
    void window.showInformationMessage("speja: nothing to fix at the cursor.");
    return;
  }
  const chosen = await window.showQuickPick(
    actions.map((a) => ({ label: a.title, action: a })),
    { placeHolder: "speja quick fixes at the cursor" },
  );
  if (chosen) await runAction(chosen.action);
}

/**
 * Move the signal declared on the cursor's line into the block or generate that uses it.
 *
 * The server offers the move as a refactoring, or as the quick fix of `lint_790` when that rule
 * is on, so both kinds are asked for and only the moves kept.
 */
async function moveSignal(): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vhdl") return;
  const range = new Range(editor.selection.start, editor.selection.end);
  const moves: CodeAction[] = [];
  for (const kind of ["refactor.move", "quickfix"])
    for (const a of (await commands.executeCommand<CodeAction[]>(
      "vscode.executeCodeActionProvider",
      editor.document.uri,
      range,
      kind,
    )) ?? [])
      if (/^Move signal /.test(a.title)) moves.push(a);
  if (!moves.length) {
    void window.showInformationMessage(
      "speja: no signal to move here. Put the cursor on the declaration of a signal that only one block or generate uses.",
    );
    return;
  }
  const chosen =
    moves.length === 1
      ? moves[0]
      : (
          await window.showQuickPick(
            moves.map((a) => ({ label: a.title, action: a })),
            { placeHolder: "Which signal?" },
          )
        )?.action;
  if (chosen) await runAction(chosen);
}

/** What the speja menu lists, in order. Every entry is also a palette command. */
const MENU: [string, string][] = [
  ["speja.quickFix", "Quick Fixes at Cursor..."],
  ["speja.declare", "Declare Name Under Cursor..."],
  ["speja.addUseClause", "Add Use Clause..."],
  ["speja.instantiateEntity", "Instantiate Entity..."],
  ["speja.declareSignals", "Declare Signals for Port Map"],
  ["speja.mapMissingPorts", "Map Missing Ports"],
  ["speja.completeCase", "Complete Case Statement"],
  ["speja.fsmFromEnum", "Create State Machine from Enum Type"],
  ["speja.componentDeclaration", "Declare Entity as Component..."],
  ["speja.extractObject", "Extract Selection to Constant or Signal"],
  ["speja.moveSignal", "Move Signal Into the Scope That Uses It"],
  ["speja.formatDocument", "Format Document"],
  ["speja.formatSelection", "Format Selection"],
  ["speja.sortUseClauses", "Sort Library and Use Clauses"],
  ["speja.removeUnusedUseClauses", "Remove Unused Use Clauses..."],
  ["speja.restartServer", "Restart Server"],
  ["speja.showOutput", "Show Output"],
  ["speja.showVersion", "Show Server Version"],
];

/**
 * The kind the speja menu's entries carry. Not quick fixes and not refactorings, so the ordinary
 * lightbulb never shows them: they come back only when this kind is asked for by name.
 */
const MENU_KIND = CodeActionKind.Empty.append("speja");

/**
 * The speja menu, at the cursor. The editor's list pickers always open at the top of the window
 * and an extension cannot move them; the code action widget is the one menu that opens where the
 * cursor is, so the menu is that widget, asked for speja's entries and nothing else.
 */
async function showMenu(): Promise<void> {
  // From the status bar or a keybinding outside the editor, the widget needs the editor focused.
  await commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await commands.executeCommand("editor.action.codeAction", {
    kind: MENU_KIND.value,
    apply: "never",
  });
}

/** The entries of the menu at the cursor: the actions that apply there, each running its command. */
const menuActions = {
  async provideCodeActions(
    document: TextDocument,
    range: Range,
    context: { only?: CodeActionKind },
  ): Promise<CodeAction[]> {
    if (!context.only || !MENU_KIND.contains(context.only)) return [];
    const applicable = await applicableCommands(document, range);
    return MENU.filter(([command]) => applicable.has(command)).map(([command, label]) => {
      const action = new CodeAction(label, MENU_KIND);
      action.command = { command, title: label };
      return action;
    });
  },
};

async function stop(): Promise<void> {
  const running = client;
  client = undefined;
  await running?.stop();
}

export async function activate(context: ExtensionContext): Promise<void> {
  output = window.createOutputChannel("speja");
  context.subscriptions.push(output);
  context.subscriptions.push(
    commands.registerCommand("speja.restartServer", async () => {
      await stop();
      await start(context);
    }),
    commands.registerCommand("speja.showOutput", () => output?.show()),
    commands.registerCommand("speja.showVersion", () => showVersion(context)),
    commands.registerCommand("speja.showMenu", showMenu),
    languages.registerCodeActionsProvider("vhdl", menuActions, {
      providedCodeActionKinds: [MENU_KIND],
    }),
    commands.registerCommand("speja.quickFix", quickFixes),
    commands.registerCommand("speja.formatDocument", () =>
      serverEdit("document"),
    ),
    commands.registerCommand("speja.formatSelection", () =>
      serverEdit("selection"),
    ),
    commands.registerCommand("speja.fixAll", () => serverEdit("fixAll")),
    commands.registerCommand("speja.sortUseClauses", () => serverEdit("sort")),
    commands.registerCommand("speja.moveSignal", moveSignal),
    // Which executable to run is decided at startup, so a change to it needs a restart.
    workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration("speja.server") ||
        event.affectsConfiguration("speja.waiverFile")
      ) {
        await stop();
        await start(context);
      }
    }),
  );
  // The editing half: commands and providers built on whatever VHDL language server is
  // running. It registers its own subscriptions and does not need the speja server.
  registerEditingFeatures(context);

  // The menu, one click away while a VHDL file is open.
  const menu = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  menu.text = "$(tools) speja";
  menu.tooltip = "speja actions";
  menu.command = "speja.showMenu";
  const showFor = () =>
    window.activeTextEditor?.document.languageId === "vhdl"
      ? menu.show()
      : menu.hide();
  showFor();
  context.subscriptions.push(menu, window.onDidChangeActiveTextEditor(showFor));
  await start(context);
}

export async function deactivate(): Promise<void> {
  await stop();
}
