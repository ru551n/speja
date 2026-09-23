//! `speja lsp`: a deliberately narrow language server.
//!
//! It offers what speja is: diagnostics, and formatting. It does **not** offer completion,
//! hover, definition, references, rename, symbols or semantic tokens, and it does not advertise
//! them — those belong to a VHDL language server such as `vhdl_ls`, which this is meant to run
//! beside rather than replace.
//!
//! Everything it answers with comes from the same library the command line uses: the same parser,
//! the same formatter, the same analysis, the same configuration. There is no editor-specific
//! implementation of anything, so a diagnostic in an editor is a diagnostic on the command line.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use speja::Config;
use speja::analysis;
use tokio::sync::RwLock;
use tower_lsp_server::jsonrpc::{self, Result};
use tower_lsp_server::ls_types::{
    CodeAction, CodeActionKind, CodeActionOptions, CodeActionOrCommand, CodeActionParams,
    CodeActionProviderCapability, CodeActionResponse, Diagnostic, DiagnosticRelatedInformation,
    DiagnosticSeverity, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, DocumentFormattingParams, DocumentRangeFormattingParams,
    InitializeParams, InitializeResult, InitializedParams, Location, MessageType, NumberOrString,
    OneOf, Position, Range, ServerCapabilities, ServerInfo, TextDocumentSyncCapability,
    TextDocumentSyncKind, TextEdit, Uri, WorkspaceEdit,
};
use tower_lsp_server::{Client, LanguageServer, LspService, Server};

/// One open document, as the editor currently has it.
struct Document {
    text: String,
    version: i32,
}

/// One project's analyser, and the library map it was built from.
struct Analysed {
    analyser: analysis::lint::Analyser,
    /// What the map said when the project was built, so a map that has been edited since is
    /// noticed rather than believed.
    map: Option<(PathBuf, std::time::SystemTime)>,
}

pub(crate) struct Backend {
    client: Client,
    documents: Arc<RwLock<HashMap<Uri, Document>>>,
    /// The analysed projects, kept between edits and keyed by the library map they belong to.
    /// Building one parses every file the map names plus the embedded `ieee` and `std`, which is
    /// most of what an analysis costs and is the same work every time; only the edited buffer
    /// changes.
    ///
    /// Keyed, not single: one server is asked about files from every project the editor has open,
    /// and answering for one project out of another's symbol table is worse than answering
    /// slowly. The key is the library map that governs the file, or `None` for a file with no
    /// map at all.
    analysers: Arc<tokio::sync::Mutex<HashMap<Option<PathBuf>, Analysed>>>,
    /// What a waiver file is called, from the client's initialization options. A project can
    /// call it something else; the editor and the command line then have to be told the same
    /// name, which is why it is a setting rather than a guess.
    waivers: Arc<RwLock<String>>,
    /// The workspace the editor opened, where a waiver file is created when a project has none
    /// yet. Without it the file lands beside the source, which is rarely what anyone wants.
    root: Arc<RwLock<Option<PathBuf>>>,
}

/// What a waiver file is called when the client does not say.
const WAIVERS: &str = "speja-waivers.yaml";

/// The waiver file governing a path: the nearest one in its directory or an ancestor.
///
/// Found by walking up, the way the configuration and the library map are found, so a waiver
/// file written at the root of a repository governs every file under it without being named.
fn waiver_file(path: &Path, name: &str) -> Option<PathBuf> {
    path.parent()?
        .ancestors()
        .map(|at| at.join(name))
        .find(|candidate| candidate.is_file())
}

/// The waivers that apply to a file, or none when there is no waiver file.
///
/// A waiver file that does not parse is ignored here rather than reported: it is not this
/// source file's error, the command line reports it, and refusing to show diagnostics because a
/// *suppression* list is malformed would hide the findings the editor exists to show.
fn waivers_for(path: &Path, name: &str) -> crate::waivers::Waivers {
    waiver_file(path, name)
        .and_then(|file| crate::waivers::Waivers::load(&[file]).ok())
        .unwrap_or_default()
}

/// The configuration that applies to a file, found the way the command line finds it: the
/// nearest `speja.yaml` (or `.json`) in its directory or an ancestor.
fn config_for(path: &Path) -> std::result::Result<Config, String> {
    let Some(file) = path.parent().and_then(speja::config::discover) else {
        return Ok(Config::default().for_path(path).into_owned());
    };
    // Not `.ok()`: a configuration that does not load is not the default configuration. Treating
    // it as one lets format-on-save rewrite a file under settings the project never chose, while
    // the command line refuses to run at all -- the editor and CI would disagree about the same
    // file, which is the one thing this tool must not do.
    let cfg = Config::load(std::slice::from_ref(&file))
        .map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(cfg.for_path(path).into_owned())
}

/// The path an editor URI stands for. A document that is not a file still needs a name, because
/// the name decides the configuration and the library it is analysed in.
fn path_of(uri: &Uri) -> PathBuf {
    let path = uri.path().as_str();
    // A Windows file URI is `file:///C:/dir/x.vhd`, whose path component is `/C:/dir/x.vhd`.
    // Handed to the filesystem unchanged that is not a path at all, so the document would never
    // be found and no configuration would be discovered for it.
    let path = path
        .strip_prefix('/')
        .filter(|rest| {
            let mut chars = rest.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.next() == Some(':')
                && matches!(chars.next(), Some('/') | None)
        })
        .unwrap_or(path);
    // Percent-encoding is how a space or a `#` survives a URI; the filesystem wants it back.
    percent_decode(path).into()
}

/// `%20` and friends, decoded. Anything that is not a valid escape is left as it was.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let decoded = (bytes[at] == b'%')
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = decoded {
            out.push(byte);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A byte offset in `text`, as an LSP position. LSP counts UTF-16 code units within a line.
fn position_of(text: &str, offset: usize) -> Position {
    let offset = offset.min(text.len());
    let before = &text[..offset];
    let line = before.matches('\n').count();
    let start = before.rfind('\n').map_or(0, |at| at + 1);
    Position {
        line: u32::try_from(line).unwrap_or(u32::MAX),
        character: u32::try_from(text[start..offset].encode_utf16().count()).unwrap_or(u32::MAX),
    }
}

/// A one-based line and column, as an LSP position, for findings that carry no byte offset.
fn position_at(line: usize, column: usize) -> Position {
    Position {
        line: u32::try_from(line.saturating_sub(1)).unwrap_or(0),
        character: u32::try_from(column.saturating_sub(1)).unwrap_or(0),
    }
}

/// The byte range of whole lines `first..=last`, 0-based, clamped to the text.
///
/// Formatting a selection works in whole lines, as `--range` does. A layout is decided for a
/// line, not for the columns someone happened to drag across, and half a line cannot be folded.
/// speja's byte-offset edits as the editor's line/character edits.
fn lsp_edits(text: &str, edits: &[speja::TextEdit]) -> Vec<TextEdit> {
    edits
        .iter()
        .filter_map(|edit| {
            Some(TextEdit {
                range: Range::new(position_of(text, edit.start), position_of(text, edit.end)),
                new_text: String::from_utf8(edit.text.clone()).ok()?,
            })
        })
        .collect()
}

fn line_span(text: &str, first: u32, last: u32) -> std::ops::Range<usize> {
    let starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(at, _)| at + 1))
        .collect();
    let start = starts.get(first as usize).copied().unwrap_or(text.len());
    let end = starts.get(last as usize + 1).copied().unwrap_or(text.len());
    start..end.max(start)
}

/// The lines an LSP range covers, as whole lines.
///
/// A selection dragged to the start of a line stops before it: that is where an editor puts the
/// end when whole lines are selected, and formatting the line below the selection would surprise.
fn selected_lines(range: Range) -> (u32, u32) {
    let last = if range.end.character == 0 && range.end.line > range.start.line {
        range.end.line - 1
    } else {
        range.end.line
    };
    (range.start.line, last)
}

impl Backend {
    /// Analyse one document exactly as `--check style,lint` would, and publish the result.
    async fn publish(&self, uri: Uri, text: String, version: i32) {
        let path = path_of(&uri);
        // One analysis at a time: the project is shared, and two edits analysing it at once
        // would each see the other's buffer half applied.
        let analysers = Arc::clone(&self.analysers);
        let waivers = self.waivers.read().await.clone();
        let diagnostics = tokio::task::spawn_blocking({
            let path = path.clone();
            let text = text.clone();
            move || {
                let mut held = analysers.blocking_lock();
                diagnose(&path, &text, &mut held, &waivers)
            }
        })
        .await
        .unwrap_or_default();
        // Analyses run concurrently and do not finish in the order they started: a small edit can
        // overtake the larger buffer before it. Publishing that late result would leave the editor
        // showing diagnostics for a version the user has already moved past -- or, if the document
        // has since been closed, diagnostics for a file that is no longer open, which `did_close`
        // has already withdrawn. Only the version that is still open is worth publishing.
        if self
            .documents
            .read()
            .await
            .get(&uri)
            .map(|document| document.version)
            != Some(version)
        {
            return;
        }
        self.client
            .publish_diagnostics(uri, diagnostics, Some(version))
            .await;
    }
}

/// Everything speja reports about one buffer: the style rules and the lint layer, from the same
/// entry points the command line calls.
fn diagnose(
    path: &Path,
    text: &str,
    analysers: &mut HashMap<Option<PathBuf>, Analysed>,
    waivers: &str,
) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    // A configuration that does not load stops everything: every rule below, and the severity of
    // every finding, comes from it. Saying so once, where the editor shows problems, is the whole
    // report -- findings computed under settings the project did not choose would be fiction.
    let cfg = match config_for(path) {
        Ok(cfg) => cfg,
        Err(message) => {
            out.push(Diagnostic {
                range: Range::new(Position::new(0, 0), Position::new(0, 0)),
                severity: Some(DiagnosticSeverity::ERROR),
                source: Some("speja".to_owned()),
                message: format!(
                    "speja is not running on this file: its configuration could not be read. \
                     {message}"
                ),
                ..Diagnostic::default()
            });
            return out;
        }
    };
    // `speja: exclude` means speja is not running on this file. Silence here and refusal in the
    // three actions below are the same decision: a generated or vendored file gets no squiggles,
    // and nothing in the editor rewrites it. Only naming it on the command line still does.
    if cfg.excluded(path) {
        return out;
    }
    let parsed = speja::Parsed::new(text.as_bytes().to_vec());

    // A file that does not parse gets its syntax errors and nothing else: every rule below would
    // be reasoning about a tree that does not represent the source.
    if !parsed.syntax_errors().is_empty() && !parsed.is_blank() {
        for error in parsed.syntax_errors() {
            out.push(Diagnostic {
                range: Range::new(
                    position_of(text, error.offset),
                    position_of(text, error.offset),
                ),
                severity: Some(DiagnosticSeverity::ERROR),
                source: Some("speja".to_owned()),
                message: error.message.clone(),
                ..Diagnostic::default()
            });
        }
        return out;
    }

    // Both halves of what the command line reports: the rule violations, and the layout findings
    // that come from comparing the source with what the formatter would write. Only the rules
    // were published before, so an editor never underlined a misindented line even though
    // `speja` on the command line reported it and `--fix` changed it.
    let (violations, formatted) = speja::rules::check_and_format_with(&parsed, &cfg, None);
    if let Ok(formatted) = formatted
        && formatted != parsed.source()
    {
        let after = speja::Parsed::new(formatted);
        let mut seen: std::collections::HashSet<(usize, String)> = std::collections::HashSet::new();
        // The command line's fallback, the same here: when every change belongs to a disabled
        // rule the formatter still applies, one finding on the first line that will change says
        // so, rather than the editor showing nothing while format-on-save rewrites the line.
        let mut unreported: Option<(usize, String)> = None;
        for change in speja::layout::layout_changes(&parsed, &after) {
            let rule = speja::layout::rule_for(&change);
            // A disabled VSG rule does not report, though the formatter still applies its policy.
            if rule != "format" && cfg.rule_by_id(rule).is_some_and(|set| !set.enabled) {
                unreported.get_or_insert_with(|| {
                    (
                        change.line,
                        format!(
                            "File is not formatted: {} ({rule} is disabled, but the formatter \
                             still applies it)",
                            speja::layout::message(&change, cfg.format.indent)
                        ),
                    )
                });
                continue;
            }
            if !seen.insert((change.line, rule.to_owned())) {
                continue;
            }
            // Layout findings carry a line, not a span. Underlining the whole line is what the
            // finding is about: everything on it is in the wrong place.
            let line = u32::try_from(change.line.saturating_sub(1)).unwrap_or(0);
            let end = text
                .lines()
                .nth(line as usize)
                .map_or(0, |l| u32::try_from(l.chars().count()).unwrap_or(0));
            out.push(Diagnostic {
                range: Range::new(Position::new(line, 0), Position::new(line, end)),
                severity: Some(DiagnosticSeverity::ERROR),
                code: Some(NumberOrString::String(rule.to_owned())),
                source: Some("speja".to_owned()),
                message: speja::layout::message(&change, cfg.format.indent),
                ..Diagnostic::default()
            });
        }
        if seen.is_empty()
            && let Some((line, message)) = unreported
        {
            let line = u32::try_from(line.saturating_sub(1)).unwrap_or(0);
            let end = text
                .lines()
                .nth(line as usize)
                .map_or(0, |l| u32::try_from(l.chars().count()).unwrap_or(0));
            out.push(Diagnostic {
                range: Range::new(Position::new(line, 0), Position::new(line, end)),
                severity: Some(DiagnosticSeverity::ERROR),
                code: Some(NumberOrString::String("format".to_owned())),
                source: Some("speja".to_owned()),
                message,
                ..Diagnostic::default()
            });
        }
    }

    for violation in violations {
        out.push(Diagnostic {
            range: Range::new(
                position_of(text, violation.start),
                position_of(text, violation.end),
            ),
            // Red for what is wrong or what speja can put right itself; amber for what it will
            // not decide. A fix classified unsafe is one that can change what the design does,
            // so speja never applies it: `signal_007` deletes a signal's initial value, which is
            // its power-on state. Colouring that the same red as a missing keyword says "this is
            // wrong" about a judgement that belongs to whoever wrote it. Only the editor changes;
            // the command line keeps VSG's severities, because that report is VSG's.
            severity: Some(
                if violation.severity.to_string() == "warning"
                    || violation
                        .fix
                        .as_ref()
                        .is_some_and(|fix| fix.safety == speja::rules::FixSafety::Unsafe)
                {
                    DiagnosticSeverity::WARNING
                } else {
                    DiagnosticSeverity::ERROR
                },
            ),
            code: Some(NumberOrString::String(violation.rule.to_owned())),
            source: Some("speja".to_owned()),
            message: violation.message.clone(),
            ..Diagnostic::default()
        });
    }

    // The front end's rules too, so an editor sees what `--check style,lint` sees. They need the
    // project's library map; without one only a few of them report, exactly as on the command
    // line. The buffer stands in for the file, so an unsaved edit is what gets analysed.
    let sources = [analysis::lint::Source::buffer(
        path.to_path_buf(),
        text.as_bytes().to_vec(),
    )];
    // Which project this file belongs to, and what its map said a moment ago.
    let map = path
        .parent()
        .and_then(analysis::lint::project_config_for)
        .map(|at| {
            let stamp = std::fs::metadata(&at)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            (at, stamp)
        });
    let key = map.as_ref().map(|(at, _)| at.clone());
    // A map that has been edited since the project was built describes a different project.
    if analysers
        .get(&key)
        .is_some_and(|held| held.map.as_ref().map(|(_, was)| *was) != map.as_ref().map(|(_, m)| *m))
    {
        analysers.remove(&key);
    }

    let mut project_error = None;
    if !analysers.contains_key(&key) {
        match analysis::lint::Analyser::for_project(&sources, key.as_deref()) {
            Ok(analyser) => {
                analysers.insert(
                    key.clone(),
                    Analysed {
                        analyser,
                        map: map.clone(),
                    },
                );
            }
            // Not silence: an unreadable `vhdl_ls.toml` switches off most of the lint layer, and
            // a report that is quietly missing 53 rules looks exactly like a clean one.
            Err(message) => project_error = Some(message),
        }
    }
    let resolved = analysers
        .get_mut(&key)
        .map(|held| held.analyser.analyse(&sources));
    let front_end = match resolved {
        Some(analysis) => analysis.reportable(),
        // The project could not be built at all; the rules that need it simply do not report.
        None => Vec::new(),
    };
    if let Some(message) = project_error {
        out.push(Diagnostic {
            range: Range::new(Position::new(0, 0), Position::new(0, 0)),
            severity: Some(DiagnosticSeverity::WARNING),
            source: Some("speja".to_owned()),
            message: format!(
                "The rules that resolve names across files are not running: the project's \
                 library map could not be read. {message}"
            ),
            ..Diagnostic::default()
        });
    }

    // The two halves count columns differently, and only one of them is what an editor wants.
    // A rule working from the syntax tree reports a display column: tabs expanded to tab stops,
    // one per character. LSP wants UTF-16 code units, so a finding after a tab would be pointed
    // at several characters too far right, and one after a non-BMP character one too few. The
    // front end already answers in UTF-16 (`vhdl_lang`'s `Position::character` is defined that
    // way), so its findings are taken as they are.
    let native: Vec<(analysis::lint::Finding, bool)> = analysis::findings_for(&parsed, path, &cfg)
        .into_iter()
        .map(|f| (f, true))
        .chain(front_end.into_iter().map(|f| (f, false)))
        .collect();
    let place = |line: usize, column: usize, from_the_tree: bool| {
        if from_the_tree {
            position_of(text, parsed.offset_of(line, column))
        } else {
            position_at(line, column)
        }
    };

    for (finding, from_the_tree) in native {
        if cfg.rule_by_id(finding.rule).is_some_and(|s| !s.enabled) {
            continue;
        }
        let at = place(finding.line, finding.column, from_the_tree);
        // Structured, not flattened into the message: an editor can jump to each one.
        let related: Vec<DiagnosticRelatedInformation> = finding
            .related
            .iter()
            .filter_map(|other| {
                // Not `format!("file://{path}")`: a space, a `#` or a Windows drive letter makes
                // that not a URI, and the `?` below would drop the location rather than say so.
                let uri = Uri::from_file_path(&other.file)?;
                // Only this buffer's own columns can be converted: another file's text is not
                // here to measure. Every native rule that carries related locations puts them
                // in the same file, so that is the case worth getting right.
                let here = from_the_tree && other.file == path;
                let at = place(other.line, other.column, here);
                Some(DiagnosticRelatedInformation {
                    location: Location {
                        uri,
                        range: Range::new(at, at),
                    },
                    message: other.message.clone(),
                })
            })
            .collect();
        out.push(Diagnostic {
            range: Range::new(at, at),
            severity: Some(DiagnosticSeverity::ERROR),
            code: Some(NumberOrString::String(finding.rule.to_owned())),
            source: Some("speja".to_owned()),
            message: finding.message.clone(),
            related_information: (!related.is_empty()).then_some(related),
            ..Diagnostic::default()
        });
    }
    waived(path, waivers, out)
}

/// Drop what the project has already decided to accept.
///
/// A waiver is the answer to "yes, we know": the command line stops counting the finding, so an
/// editor that kept underlining it would be the one place still arguing. Matched exactly as the
/// command line matches, by rule, file glob and line.
fn waived(path: &Path, name: &str, diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
    let waivers = waivers_for(path, name);
    if waivers.is_empty() {
        return diagnostics;
    }
    let file = path.to_string_lossy().into_owned();
    diagnostics
        .into_iter()
        .filter(|d| {
            let Some(NumberOrString::String(rule)) = &d.code else {
                // A diagnostic with no rule id is speja speaking about itself, such as a
                // configuration that would not load. Nothing waives that.
                return true;
            };
            waivers
                .waives(&file, rule, d.range.start.line as usize + 1)
                .is_none()
        })
        .collect()
}

/// Whether two ranges touch. An editor asks for the actions of a selection, which is usually a
/// cursor: a zero-width range on the line of the diagnostic.
fn overlaps(a: &Range, b: &Range) -> bool {
    a.start <= b.end && b.start <= a.end
}

/// The edits of a safe fix, as the document sees them.
///
/// `--fix` applies edits in (start, rank, end) order and two of them can insert at one offset, so
/// the order is settled here and same-offset insertions are merged. An editor applies a
/// `WorkspaceEdit`'s edits as a set, and would otherwise be free to reverse them.
fn edits_of(text: &str, fix: &speja::rules::Fix) -> Vec<TextEdit> {
    let mut edits: Vec<&speja::rules::Edit> = fix.edits.iter().collect();
    edits.sort_by_key(|e| (e.start, e.rank, e.end));
    let mut merged: Vec<speja::rules::Edit> = Vec::new();
    for edit in edits {
        match merged.last_mut() {
            Some(last) if last.start == edit.start && last.end == edit.end => {
                last.text.push_str(&edit.text);
            }
            _ => merged.push(edit.clone()),
        }
    }
    merged
        .iter()
        .map(|edit| TextEdit {
            range: Range::new(position_of(text, edit.start), position_of(text, edit.end)),
            new_text: edit.text.clone(),
        })
        .collect()
}

/// One document's edits, as a workspace edit.
fn workspace_edit(uri: &Uri, edits: Vec<TextEdit>) -> WorkspaceEdit {
    WorkspaceEdit {
        changes: Some(std::iter::once((uri.clone(), edits)).collect()),
        ..WorkspaceEdit::default()
    }
}

impl LanguageServer for Backend {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        // A server can be initialized again; nothing from a previous session should survive it.
        self.documents.write().await.clear();
        // `initializationOptions: { "waiverFile": "..." }`. A project that calls its waiver file
        // something else says so once, here, rather than in every editor that opens it.
        if let Some(name) = params
            .initialization_options
            .as_ref()
            .and_then(|options| options.get("waiverFile"))
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
        {
            *self.waivers.write().await = name.to_owned();
        }
        *self.root.write().await = params
            .workspace_folders
            .as_ref()
            .and_then(|folders| folders.first())
            .map(|folder| path_of(&folder.uri));
        Ok(InitializeResult {
            server_info: Some(ServerInfo {
                name: "speja".to_owned(),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            }),
            offset_encoding: None,
            capabilities: ServerCapabilities {
                // Whole documents: correctness first. An incremental sync is an optimisation
                // this has no measurement to justify.
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                document_formatting_provider: Some(OneOf::Left(true)),
                document_range_formatting_provider: Some(OneOf::Left(true)),
                code_action_provider: Some(CodeActionProviderCapability::Options(
                    CodeActionOptions {
                        code_action_kinds: Some(vec![
                            CodeActionKind::QUICKFIX,
                            CodeActionKind::SOURCE_FIX_ALL,
                            CodeActionKind::SOURCE_ORGANIZE_IMPORTS,
                        ]),
                        ..CodeActionOptions::default()
                    },
                )),
                // Everything else is deliberately absent. speja is not a VHDL language server:
                // completion, hover, definition, references, rename and symbols belong to one,
                // and advertising them would make editors ask speja instead of asking it.
                ..ServerCapabilities::default()
            },
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "speja: diagnostics and formatting")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        // Documents live only in memory; dropping them is all there is to wind down.
        self.documents.write().await.clear();
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let document = params.text_document;
        self.documents.write().await.insert(
            document.uri.clone(),
            Document {
                text: document.text.clone(),
                version: document.version,
            },
        );
        self.publish(document.uri, document.text, document.version)
            .await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let Some(change) = params.content_changes.into_iter().next_back() else {
            return;
        };
        let uri = params.text_document.uri;
        let version = params.text_document.version;
        {
            let mut documents = self.documents.write().await;
            let document = documents.entry(uri.clone()).or_insert_with(|| Document {
                text: String::new(),
                version,
            });
            // An edit that arrives out of order is not what the editor has; publishing from it
            // would leave diagnostics describing a buffer that no longer exists.
            if version < document.version {
                return;
            }
            document.text.clone_from(&change.text);
            document.version = version;
        }
        self.publish(uri, change.text, version).await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri;
        self.documents.write().await.remove(&uri);
        // The editor stops showing a closed file's diagnostics only if they are withdrawn.
        self.client.publish_diagnostics(uri, Vec::new(), None).await;
    }

    async fn code_action(&self, params: CodeActionParams) -> Result<Option<CodeActionResponse>> {
        let uri = params.text_document.uri;
        let Some(text) = self
            .documents
            .read()
            .await
            .get(&uri)
            .map(|d| d.text.clone())
        else {
            return Ok(None);
        };
        let range = params.range;
        let wanted = params.context.only.clone();
        let path = path_of(&uri);
        let actions = tokio::task::spawn_blocking({
            let uri = uri.clone();
            move || {
                // An editor asking for one kind of action should not be given the others.
                let allows = |kind: &CodeActionKind| {
                    wanted
                        .as_ref()
                        .is_none_or(|only| only.iter().any(|k| k == kind))
                };
                // No configuration, no actions: a fix computed under the default settings is
                // not the fix `--fix` would apply, and applying it would be a silent edit.
                let Ok(cfg) = config_for(&path) else {
                    return Vec::new();
                };
                if cfg.excluded(&path) {
                    return Vec::new();
                }
                let parsed = speja::Parsed::new(text.as_bytes().to_vec());
                let mut actions: Vec<CodeActionOrCommand> = Vec::new();

                // One action per violation the cursor is on, from the fix it already carries.
                // Only a fix speja would apply itself is offered: the same test `--fix` uses, so
                // an editor never offers something the command line would refuse.
                if allows(&CodeActionKind::QUICKFIX) {
                    for violation in speja::rules::check_with(&parsed, &cfg, None) {
                        let Some(fix) = violation.fix.as_ref() else {
                            continue;
                        };
                        // An unsafe fix is offered, and says so. speja will not apply one itself,
                        // so it stays out of fix-all and out of format-on-save, which are built
                        // from `fix_with` and never ask for unsafe fixes. But refusing to offer
                        // it at all left the finding with no way to act on it: an underline
                        // saying "this is your call" and no means of making the call.
                        let risky = fix.safety != speja::rules::FixSafety::Safe;
                        let at = Range::new(
                            position_of(&text, violation.start),
                            position_of(&text, violation.end),
                        );
                        if !overlaps(&at, &range) {
                            continue;
                        }
                        let title = if risky {
                            format!(
                                "{}: {} (may change behaviour)",
                                violation.rule, violation.message
                            )
                        } else {
                            format!("{}: {}", violation.rule, violation.message)
                        };
                        actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                            title,
                            kind: Some(CodeActionKind::QUICKFIX),
                            // Never the default action an editor would apply on its own.
                            is_preferred: (!risky).then_some(true),
                            edit: Some(workspace_edit(&uri, edits_of(&text, fix))),
                            ..CodeAction::default()
                        }));
                    }
                }

                // Formatting for the lines the request covers, offered whenever the formatter
                // would change them. The per-violation fixes above are one rule each; a badly
                // laid out line usually trips several at once (indent, a blank line, a fold),
                // and picking them off individually is not what someone looking at the squiggle
                // wants. This is the same edit `--fix` would make, restricted to those lines.
                if allows(&CodeActionKind::QUICKFIX) {
                    let (first, last) = selected_lines(range);
                    let span = line_span(&text, first, last);
                    if !span.is_empty()
                        && let Ok(edits) =
                            speja::fix_range(&parsed, &cfg, &speja::FixOptions::default(), span)
                        && !edits.is_empty()
                    {
                        let title = if first == last {
                            format!("speja: format line {}", first + 1)
                        } else {
                            format!("speja: format lines {}-{}", first + 1, last + 1)
                        };
                        actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                            title,
                            kind: Some(CodeActionKind::QUICKFIX),
                            edit: Some(workspace_edit(&uri, lsp_edits(&text, &edits))),
                            ..CodeAction::default()
                        }));
                    }
                }

                // Sorting the context clauses is not a rule and not a fix: no order is wrong,
                // so nothing reports it and `--fix` does not do it. It is offered where an
                // editor offers the same thing for other languages, and run on save by anyone
                // who adds `source.organizeImports` to `editor.codeActionsOnSave`.
                if allows(&CodeActionKind::SOURCE_ORGANIZE_IMPORTS)
                    && let Some(organized) = speja::organize::sort_context_clauses(&parsed)
                {
                    actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                        title: "Sort library and use clauses".to_owned(),
                        kind: Some(CodeActionKind::SOURCE_ORGANIZE_IMPORTS),
                        edit: Some(workspace_edit(
                            &uri,
                            vec![TextEdit {
                                range: Range::new(
                                    Position::new(0, 0),
                                    position_of(&text, text.len()),
                                ),
                                new_text: organized,
                            }],
                        )),
                        ..CodeAction::default()
                    }));
                }

                // Fix all: the whole document as `--fix` would write it, which applies the safe
                // fixes and formats. Unsafe fixes are not part of it, here or there.
                if allows(&CodeActionKind::SOURCE_FIX_ALL) {
                    let fixed = speja::fix_with(&parsed, &cfg, &speja::FixOptions::default())
                        .ok()
                        .map(|out| out.output)
                        .and_then(|out| String::from_utf8(out).ok());
                    if let Some(fixed) = fixed.filter(|fixed| *fixed != text) {
                        let whole = Range::new(Position::new(0, 0), position_of(&text, text.len()));
                        actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                            title: "Fix all speja findings".to_owned(),
                            kind: Some(CodeActionKind::SOURCE_FIX_ALL),
                            edit: Some(workspace_edit(
                                &uri,
                                vec![TextEdit {
                                    range: whole,
                                    new_text: fixed,
                                }],
                            )),
                            ..CodeAction::default()
                        }));
                    }
                }
                actions
            }
        })
        .await
        .unwrap_or_default();
        Ok(Some(actions))
    }

    async fn formatting(&self, params: DocumentFormattingParams) -> Result<Option<Vec<TextEdit>>> {
        let uri = params.text_document.uri;
        let Some(text) = self
            .documents
            .read()
            .await
            .get(&uri)
            .map(|d| d.text.clone())
        else {
            return Ok(None);
        };
        let path = path_of(&uri);
        // The same entry point `--fix` uses, so formatting on save leaves a file that the
        // command line then reports nothing about. Formatting alone would leave the safe rule
        // fixes unapplied and CI would disagree with the editor.
        let formatted = tokio::task::spawn_blocking({
            let source = text.as_bytes().to_vec();
            move || {
                let cfg = config_for(&path)?;
                if cfg.excluded(&path) {
                    return Ok(None);
                }
                let parsed = speja::Parsed::new(source);
                Ok(
                    speja::fix_with(&parsed, &cfg, &speja::FixOptions::default())
                        .ok()
                        .map(|out| out.output),
                )
            }
        })
        .await
        .map_err(|_| jsonrpc::Error::internal_error())?;
        // Refusing is the point: formatting under the default settings would rewrite the file
        // the project's own configuration does not describe, and the editor would disagree with
        // what the command line does to the same file.
        let formatted = formatted.map_err(|message: String| jsonrpc::Error {
            code: jsonrpc::ErrorCode::InvalidParams,
            message: format!("speja did not format this file: {message}").into(),
            data: None,
        })?;
        // A file that does not parse is left alone, as `--fix` leaves it alone.
        let Some(formatted) = formatted else {
            return Ok(None);
        };
        let Ok(formatted) = String::from_utf8(formatted) else {
            return Ok(None);
        };
        if formatted == text {
            return Ok(Some(Vec::new()));
        }
        // One edit for the whole document: the formatter decides a canonical layout for the file,
        // not a set of local changes, and a minimal diff would be an invention on top of it.
        Ok(Some(vec![TextEdit {
            range: Range::new(Position::new(0, 0), position_of(&text, text.len())),
            new_text: formatted,
        }]))
    }

    /// Format the selected lines, leaving the rest of the file untouched.
    ///
    /// `fix_range` formats the whole document and then keeps only the edits that fall in the
    /// range, re-parsing to confirm the partial result still has no syntax error. A selection
    /// cutting through a construct therefore yields the part that can be applied safely rather
    /// than half a fold.
    async fn range_formatting(
        &self,
        params: DocumentRangeFormattingParams,
    ) -> Result<Option<Vec<TextEdit>>> {
        let uri = params.text_document.uri;
        let Some(text) = self
            .documents
            .read()
            .await
            .get(&uri)
            .map(|d| d.text.clone())
        else {
            return Ok(None);
        };
        let path = path_of(&uri);
        let (first, last) = selected_lines(params.range);
        let span = line_span(&text, first, last);
        if span.is_empty() {
            return Ok(Some(Vec::new()));
        }
        let edits = tokio::task::spawn_blocking({
            let source = text.as_bytes().to_vec();
            move || -> std::result::Result<Vec<speja::TextEdit>, String> {
                let cfg = config_for(&path)?;
                if cfg.excluded(&path) {
                    return Ok(Vec::new());
                }
                let parsed = speja::Parsed::new(source);
                speja::fix_range(&parsed, &cfg, &speja::FixOptions::default(), span)
                    .map_err(|error| error.to_string())
            }
        })
        .await
        .map_err(|_| jsonrpc::Error::internal_error())?;
        // Same refusal as whole-document formatting: without the project's own configuration the
        // edit would not be the one `--fix` makes, and the editor would disagree with CI.
        let edits = edits.map_err(|message| jsonrpc::Error {
            code: jsonrpc::ErrorCode::InvalidParams,
            message: format!("speja did not format this selection: {message}").into(),
            data: None,
        })?;
        Ok(Some(lsp_edits(&text, &edits)))
    }
}

/// Serve on stdin and stdout until the client disconnects.
pub(crate) fn serve() -> std::process::ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("ERROR: {e}");
            return std::process::ExitCode::from(1);
        }
    };
    runtime.block_on(async {
        let (service, socket) = LspService::new(|client| Backend {
            client,
            documents: Arc::new(RwLock::new(HashMap::new())),
            analysers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            waivers: Arc::new(RwLock::new(WAIVERS.to_owned())),
            root: Arc::new(RwLock::new(None)),
        });
        Server::new(tokio::io::stdin(), tokio::io::stdout(), socket)
            .serve(service)
            .await;
    });
    std::process::ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(text: &str) -> Uri {
        text.parse().expect("a URI")
    }

    #[test]
    fn a_windows_uri_becomes_a_windows_path() {
        // The path component of `file:///C:/dir/x.vhd` starts with a slash the filesystem has
        // no use for; leaving it on means no document is ever found on Windows.
        assert_eq!(
            path_of(&uri("file:///C:/dir/x.vhd")),
            PathBuf::from("C:/dir/x.vhd")
        );
        // A leading slash that is not a drive letter is part of the path.
        assert_eq!(
            path_of(&uri("file:///home/me/x.vhd")),
            PathBuf::from("/home/me/x.vhd")
        );
    }

    #[test]
    fn an_escaped_path_is_decoded() {
        assert_eq!(
            path_of(&uri("file:///home/my%20designs/x.vhd")),
            PathBuf::from("/home/my designs/x.vhd")
        );
        // Something that is not an escape is left alone rather than eaten.
        assert_eq!(percent_decode("100%"), "100%");
    }
}
