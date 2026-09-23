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
  ExtensionContext,
  OutputChannel,
  QuickPickItem,
  QuickPickItemKind,
  Range,
  StatusBarAlignment,
  WorkspaceEdit,
  commands,
  languages,
  window,
  workspace,
} from "vscode";
import {
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
    // The project's own configuration file decides the rules; there is nothing to send.
    synchronize: {},
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

/**
 * Record a waiver for one finding, with a reason.
 *
 * The server offers the action and writes the entry; this asks the one question only a person
 * can answer. A waiver without a reason is a suppression, which is the thing waivers exist not
 * to be, so an empty answer cancels rather than writing `TODO`.
 */
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
      void window.showInformationMessage("speja: already formatted.");
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
      what === "fixAll"
        ? "speja: nothing it can fix safely."
        : "speja: the library and use clauses are already in order.",
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
    const result = await client.sendRequest(CodeActionRequest.type, {
      textDocument: c2p.asTextDocumentIdentifier(editor.document),
      range: c2p.asRange(range),
      context: { diagnostics: await c2p.asDiagnostics(diagnostics) },
    });
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

/** What the speja menu lists, in its groups. Every entry is also a palette command. */
const MENU: [string, [string, string, string][]][] = [
  [
    "At the cursor",
    [
      [
        "speja.quickFix",
        "Quick Fixes at Cursor...",
        "every speja fix for what is under the cursor",
      ],
      [
        "speja.declare",
        "Declare Name Under Cursor...",
        "signal, variable or constant, type inferred",
      ],
      [
        "speja.addUseClause",
        "Add Use Clause...",
        "search every package for a name",
      ],
      [
        "speja.instantiateEntity",
        "Instantiate Entity...",
        "pick an entity, write the instantiation",
      ],
      [
        "speja.declareSignals",
        "Declare Signals for Port Map",
        "every undeclared actual in the map",
      ],
      [
        "speja.mapMissingPorts",
        "Map Missing Ports",
        "add the ports the map leaves out",
      ],
      [
        "speja.completeCase",
        "Complete Case Statement",
        "write the states, or the missing choices",
      ],
      [
        "speja.fsmFromEnum",
        "Create State Machine from Enum Type",
        "on an enumeration type",
      ],
      [
        "speja.componentDeclaration",
        "Declare Entity as Component...",
        "for component instantiation",
      ],
      [
        "speja.extractObject",
        "Extract Selection to Constant or Signal",
        "the selected expression",
      ],
    ],
  ],
  [
    "The file",
    [
      [
        "speja.formatDocument",
        "Format Document",
        "layout and the safe fixes, as speja --fix",
      ],
      ["speja.formatSelection", "Format Selection", "only the selected lines"],
      [
        "speja.sortUseClauses",
        "Sort Library and Use Clauses",
        "ieee first, work last",
      ],
      [
        "speja.removeUnusedUseClauses",
        "Remove Unused Use Clauses...",
        "pick which ones go",
      ],
    ],
  ],
  [
    "The server",
    [
      ["speja.restartServer", "Restart Server", ""],
      ["speja.showOutput", "Show Output", ""],
      ["speja.showVersion", "Show Server Version", ""],
    ],
  ],
];

/** The speja menu: every action in one list, grouped, for when the name of one escapes you. */
async function showMenu(): Promise<void> {
  type Item = QuickPickItem & { command?: string };
  const items: Item[] = MENU.flatMap(([group, entries]) => [
    { label: group, kind: QuickPickItemKind.Separator },
    ...entries.map(([command, label, detail]) => ({
      label,
      description: detail,
      command,
    })),
  ]);
  const chosen = await window.showQuickPick(items, {
    placeHolder: "speja",
    matchOnDescription: true,
  });
  if (chosen?.command) await commands.executeCommand(chosen.command);
}

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
    commands.registerCommand("speja.quickFix", quickFixes),
    commands.registerCommand("speja.formatDocument", () =>
      serverEdit("document"),
    ),
    commands.registerCommand("speja.formatSelection", () =>
      serverEdit("selection"),
    ),
    commands.registerCommand("speja.fixAll", () => serverEdit("fixAll")),
    commands.registerCommand("speja.sortUseClauses", () => serverEdit("sort")),
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
