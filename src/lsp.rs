//! `vsg-rs lsp`: a single-threaded Language Server on stdin/stdout.
//!
//! Documents are kept as full text (full sync). Every request re-parses its document; one parse
//! of a VHDL file takes milliseconds.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::process::ExitCode;

use lsp_server::{Connection, ErrorCode, Message, Notification, Request, Response};
use lsp_types::notification::{
    DidChangeTextDocument, DidCloseTextDocument, DidOpenTextDocument, DidSaveTextDocument,
    LogMessage, Notification as _, PublishDiagnostics,
};
use lsp_types::request::{CodeActionRequest, Formatting, RangeFormatting, Request as _};
use lsp_types::{
    CodeAction, CodeActionKind, CodeActionOptions, CodeActionOrCommand, CodeActionParams,
    CodeActionProviderCapability, Diagnostic, DiagnosticSeverity, DocumentFormattingParams,
    DocumentRangeFormattingParams, LogMessageParams, MessageType, NumberOrString, OneOf, Position,
    PublishDiagnosticsParams, Range, ServerCapabilities, TextDocumentSyncCapability,
    TextDocumentSyncKind, TextEdit, Uri, WorkspaceEdit,
};
use vsg_rs::config::{self, Config, Severity};
use vsg_rs::rules::{self, FixSafety, Violation};
use vsg_rs::{FormatError, Parsed};

const SOURCE: &str = "vsg-rs";
const FIX_ALL: &str = "source.fixAll.vsg-rs";

pub fn run() -> ExitCode {
    let (conn, io_threads) = Connection::stdio();
    let caps = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        document_formatting_provider: Some(OneOf::Left(true)),
        document_range_formatting_provider: Some(OneOf::Left(true)),
        code_action_provider: Some(CodeActionProviderCapability::Options(CodeActionOptions {
            code_action_kinds: Some(vec![CodeActionKind::QUICKFIX, CodeActionKind::new(FIX_ALL)]),
            ..CodeActionOptions::default()
        })),
        ..ServerCapabilities::default()
    };
    let caps = serde_json::to_value(caps).expect("capabilities serialize");
    let mut server = Server {
        conn,
        docs: HashMap::new(),
    };
    let status = match server.conn.initialize(caps) {
        Ok(_) => server.main_loop(),
        Err(e) => {
            eprintln!("error: {e}");
            false
        }
    };
    drop(server);
    if io_threads.join().is_err() || !status {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

struct Server {
    conn: Connection,
    docs: HashMap<Uri, Vec<u8>>,
}

impl Server {
    /// Returns whether the session ended with shutdown + exit.
    fn main_loop(&mut self) -> bool {
        while let Ok(msg) = self.conn.receiver.recv() {
            match msg {
                Message::Request(req) => match self.conn.handle_shutdown(&req) {
                    Ok(true) => return true,
                    Ok(false) => {
                        let id = req.id.clone();
                        let method = req.method.clone();
                        let response = catch_unwind(AssertUnwindSafe(|| self.request(req)))
                            .unwrap_or_else(|_| {
                                Response::new_err(
                                    id,
                                    ErrorCode::InternalError as i32,
                                    format!("internal error handling {method}"),
                                )
                            });
                        self.send(response);
                    }
                    Err(e) => {
                        eprintln!("error: {e}");
                        return false;
                    }
                },
                Message::Notification(n) if n.method == "exit" => return false,
                Message::Notification(n) => {
                    let method = n.method.clone();
                    if catch_unwind(AssertUnwindSafe(|| self.notification(n))).is_err() {
                        self.log(
                            MessageType::ERROR,
                            format!("internal error handling {method}"),
                        );
                    }
                }
                Message::Response(_) => {}
            }
        }
        false
    }

    fn send(&self, msg: impl Into<Message>) {
        // The client is gone if this fails; the main loop ends when the receiver closes.
        let _ = self.conn.sender.send(msg.into());
    }

    fn log(&self, typ: MessageType, message: String) {
        self.send(Notification::new(
            LogMessage::METHOD.into(),
            LogMessageParams { typ, message },
        ));
    }

    fn notification(&mut self, n: Notification) {
        let uri = match n.method.as_str() {
            DidOpenTextDocument::METHOD => n
                .extract::<lsp_types::DidOpenTextDocumentParams>(DidOpenTextDocument::METHOD)
                .ok()
                .map(|p| {
                    self.docs
                        .insert(p.text_document.uri.clone(), p.text_document.text.into());
                    p.text_document.uri
                }),
            DidChangeTextDocument::METHOD => n
                .extract::<lsp_types::DidChangeTextDocumentParams>(DidChangeTextDocument::METHOD)
                .ok()
                .map(|p| {
                    // Full sync: the last change carries the whole document.
                    if let Some(change) = p.content_changes.into_iter().last() {
                        self.docs
                            .insert(p.text_document.uri.clone(), change.text.into());
                    }
                    p.text_document.uri
                }),
            DidSaveTextDocument::METHOD => n
                .extract::<lsp_types::DidSaveTextDocumentParams>(DidSaveTextDocument::METHOD)
                .ok()
                .map(|p| p.text_document.uri),
            DidCloseTextDocument::METHOD => {
                if let Ok(p) =
                    n.extract::<lsp_types::DidCloseTextDocumentParams>(DidCloseTextDocument::METHOD)
                {
                    self.docs.remove(&p.text_document.uri);
                    self.publish(p.text_document.uri, Vec::new());
                }
                None
            }
            _ => None,
        };
        if let Some(uri) = uri
            && let Some(text) = self.docs.get(&uri)
        {
            let parsed = Parsed::new(text.clone());
            let diagnostics = self.diagnostics(&uri, &parsed);
            self.publish(uri, diagnostics);
        }
    }

    fn publish(&self, uri: Uri, diagnostics: Vec<Diagnostic>) {
        self.send(Notification::new(
            PublishDiagnostics::METHOD.into(),
            PublishDiagnosticsParams {
                uri,
                diagnostics,
                version: None,
            },
        ));
    }

    fn request(&self, req: Request) -> Response {
        let id = req.id.clone();
        let result = match req.method.as_str() {
            Formatting::METHOD => req
                .extract::<DocumentFormattingParams>(Formatting::METHOD)
                .map(|(_, p)| serde_json::to_value(self.format(&p.text_document.uri, None))),
            RangeFormatting::METHOD => req
                .extract::<DocumentRangeFormattingParams>(RangeFormatting::METHOD)
                .map(|(_, p)| {
                    serde_json::to_value(self.format(&p.text_document.uri, Some(p.range)))
                }),
            CodeActionRequest::METHOD => req
                .extract::<CodeActionParams>(CodeActionRequest::METHOD)
                .map(|(_, p)| serde_json::to_value(self.code_actions(&p))),
            _ => {
                return Response::new_err(
                    id,
                    ErrorCode::MethodNotFound as i32,
                    format!("unsupported request {}", req.method),
                );
            }
        };
        match result {
            Ok(Ok(value)) => Response::new_ok(id, value),
            Ok(Err(e)) => Response::new_err(id, ErrorCode::InternalError as i32, e.to_string()),
            Err(e) => Response::new_err(id, ErrorCode::InvalidParams as i32, format!("{e:?}")),
        }
    }

    /// Configuration for a document: the nearest configuration file, with `file_rules` applied.
    fn config(&self, uri: &Uri) -> Config {
        let Some(path) = file_path(uri) else {
            return Config::default();
        };
        // ponytail: configuration is re-read per request; cache by directory if it shows in profiles.
        let base = match path.parent().and_then(config::discover) {
            None => Config::default(),
            Some(file) => Config::load(std::slice::from_ref(&file)).unwrap_or_else(|e| {
                self.log(MessageType::WARNING, e.to_string());
                Config::default()
            }),
        };
        base.for_path(&path).into_owned()
    }

    fn diagnostics(&self, uri: &Uri, parsed: &Parsed) -> Vec<Diagnostic> {
        let src = parsed.source();
        if !parsed.syntax_errors().is_empty() {
            return parsed
                .syntax_errors()
                .iter()
                .map(|e| Diagnostic {
                    range: Range::new(position(src, e.offset), position(src, e.offset)),
                    severity: Some(DiagnosticSeverity::ERROR),
                    source: Some(SOURCE.into()),
                    message: format!("syntax error: {}", e.message),
                    ..Diagnostic::default()
                })
                .collect();
        }
        rules::check(parsed, &self.config(uri))
            .iter()
            .map(|v| diagnostic(src, v))
            .collect()
    }

    fn format(&self, uri: &Uri, range: Option<Range>) -> Vec<TextEdit> {
        let Some(text) = self.docs.get(uri) else {
            return Vec::new();
        };
        let parsed = Parsed::new(text.clone());
        let cfg = self.config(uri);
        let src = parsed.source();
        let result = match range {
            Some(r) => {
                let bytes = offset(src, r.start)..offset(src, r.end);
                vsg_rs::format_range(&parsed, &cfg.format, bytes)
            }
            None => vsg_rs::format_parsed(&parsed, &cfg.format).map(|out| {
                if out == src {
                    Vec::new()
                } else {
                    vec![vsg_rs::TextEdit {
                        start: 0,
                        end: src.len(),
                        text: out,
                    }]
                }
            }),
        };
        match result {
            Ok(edits) => edits.iter().map(|e| text_edit(src, e)).collect(),
            Err(e) => {
                let message = match &e {
                    FormatError::Syntax(d) => d.first().map_or_else(
                        || e.to_string(),
                        |d| {
                            let p = position(src, d.offset);
                            format!("{e} (first at {}:{})", p.line + 1, p.character + 1)
                        },
                    ),
                    _ => e.to_string(),
                };
                self.log(MessageType::WARNING, format!("{}: {message}", uri.as_str()));
                Vec::new()
            }
        }
    }

    fn code_actions(&self, p: &CodeActionParams) -> Vec<CodeActionOrCommand> {
        let uri = &p.text_document.uri;
        let Some(text) = self.docs.get(uri) else {
            return Vec::new();
        };
        let wanted = |kind: &str| {
            p.context.only.as_ref().is_none_or(|only| {
                only.iter().any(|k| {
                    kind == k.as_str()
                        || kind
                            .strip_prefix(k.as_str())
                            .is_some_and(|rest| rest.starts_with('.'))
                })
            })
        };
        let parsed = Parsed::new(text.clone());
        if !parsed.syntax_errors().is_empty() {
            return Vec::new();
        }
        let src = parsed.source();
        let cfg = self.config(uri);
        let mut actions = Vec::new();
        if wanted(CodeActionKind::QUICKFIX.as_str()) {
            let (start, end) = (offset(src, p.range.start), offset(src, p.range.end));
            for v in rules::check(&parsed, &cfg) {
                let Some(fix) = v.fix.as_ref().filter(|f| f.safety == FixSafety::Safe) else {
                    continue;
                };
                if v.start > end || v.end < start {
                    continue;
                }
                let edits = vsg_rs::fix_edits(src, &fix.edits)
                    .iter()
                    .map(|e| text_edit(src, e))
                    .collect();
                actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                    title: format!("Fix {}: {}", v.rule, v.message),
                    kind: Some(CodeActionKind::QUICKFIX),
                    diagnostics: Some(vec![diagnostic(src, &v)]),
                    edit: Some(workspace_edit(uri, edits)),
                    ..CodeAction::default()
                }));
            }
        }
        if wanted(FIX_ALL)
            && let Ok(outcome) = vsg_rs::fix(&parsed, &cfg)
            && outcome.output != src
        {
            let edit = vsg_rs::TextEdit {
                start: 0,
                end: src.len(),
                text: outcome.output,
            };
            actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                title: "Fix all vsg-rs violations".into(),
                kind: Some(CodeActionKind::new(FIX_ALL)),
                edit: Some(workspace_edit(uri, vec![text_edit(src, &edit)])),
                ..CodeAction::default()
            }));
        }
        actions
    }
}

fn workspace_edit(uri: &Uri, edits: Vec<TextEdit>) -> WorkspaceEdit {
    WorkspaceEdit {
        changes: Some(HashMap::from([(uri.clone(), edits)])),
        ..WorkspaceEdit::default()
    }
}

fn diagnostic(src: &[u8], v: &Violation) -> Diagnostic {
    Diagnostic {
        range: Range::new(position(src, v.start), position(src, v.end)),
        severity: Some(match v.severity {
            Severity::Error => DiagnosticSeverity::ERROR,
            Severity::Warning => DiagnosticSeverity::WARNING,
        }),
        code: Some(NumberOrString::String(v.rule.into())),
        source: Some(SOURCE.into()),
        message: v.message.clone(),
        ..Diagnostic::default()
    }
}

fn text_edit(src: &[u8], e: &vsg_rs::TextEdit) -> TextEdit {
    TextEdit {
        range: Range::new(position(src, e.start), position(src, e.end)),
        new_text: String::from_utf8_lossy(&e.text).into_owned(),
    }
}

/// Local path of a `file:` URI (`file:///c%3A/x` is `c:\\x` on Windows).
fn file_path(uri: &Uri) -> Option<PathBuf> {
    let rest = uri.as_str().strip_prefix("file://")?;
    let (host, path) = rest.split_at(rest.find('/')?);
    if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let mut bytes = Vec::with_capacity(path.len());
    let mut it = path.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let hex = [it.next()?, it.next()?];
            bytes.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
        } else {
            bytes.push(b);
        }
    }
    // ponytail: non-UTF-8 paths get the default configuration.
    let path = String::from_utf8(bytes).ok()?;
    if cfg!(windows) {
        let path = path
            .strip_prefix('/')
            .filter(|p| p.as_bytes().get(1) == Some(&b':'))
            .unwrap_or(&path);
        return Some(PathBuf::from(path.replace('/', "\\")));
    }
    Some(PathBuf::from(path))
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Number of UTF-16 code units in `bytes`; each invalid UTF-8 byte counts as one unit.
fn utf16_len(bytes: &[u8]) -> usize {
    bytes
        .utf8_chunks()
        .map(|c| c.valid().encode_utf16().count() + c.invalid().len())
        .sum()
}

/// LSP position (line, UTF-16 column) of a byte offset.
fn position(src: &[u8], offset: usize) -> Position {
    let before = &src[..offset.min(src.len())];
    let line_start = before
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1);
    let line = before.iter().filter(|&&b| b == b'\n').count();
    Position::new(to_u32(line), to_u32(utf16_len(&before[line_start..])))
}

/// Byte offset of an LSP position. Positions past the end of a line or the document are
/// clamped, and a position inside a character resolves to the character's end.
fn offset(src: &[u8], pos: Position) -> usize {
    let start = match (pos.line as usize).checked_sub(1) {
        None => 0,
        Some(k) => match src.iter().enumerate().filter(|&(_, &b)| b == b'\n').nth(k) {
            Some((i, _)) => i + 1,
            None => return src.len(),
        },
    };
    let rest = &src[start..];
    let mut line = &rest[..rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len())];
    if let Some(stripped) = line.strip_suffix(b"\r") {
        line = stripped;
    }
    let want = pos.character as usize;
    let (mut units, mut at) = (0, start);
    for chunk in line.utf8_chunks() {
        let chars = chunk.valid().chars().map(|c| (c.len_utf16(), c.len_utf8()));
        let invalid = chunk.invalid().iter().map(|_| (1, 1));
        for (u, b) in chars.chain(invalid) {
            if units >= want {
                return at;
            }
            units += u;
            at += b;
        }
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris_become_paths() {
        let path = |s: &str| file_path(&s.parse().unwrap());
        assert_eq!(path("untitled:x.vhd"), None);
        assert_eq!(path("file://server/share/x.vhd"), None);
        if cfg!(windows) {
            assert_eq!(
                path("file:///c%3A/a%20b/x.vhd"),
                Some(PathBuf::from(r"c:\a b\x.vhd"))
            );
        } else {
            assert_eq!(
                path("file:///a%20b/%C3%A9.vhd"),
                Some(PathBuf::from("/a b/é.vhd"))
            );
            assert_eq!(
                path("file://localhost/x.vhd"),
                Some(PathBuf::from("/x.vhd"))
            );
        }
    }

    #[test]
    fn positions_count_utf16_units() {
        // "é" is 2 bytes / 1 unit, "😀" is 4 bytes / 2 units.
        let src = "ab\né😀x\r\ny".as_bytes();
        let x = src.iter().position(|&b| b == b'x').unwrap();
        assert_eq!(position(src, x), Position::new(1, 3));
        assert_eq!(offset(src, Position::new(1, 3)), x);
        assert_eq!(offset(src, Position::new(1, 0)), 3);
        // Past the end of a line: before its line break (and its CR).
        assert_eq!(offset(src, Position::new(1, 99)), x + 1);
        assert_eq!(offset(src, Position::new(9, 0)), src.len());
        assert_eq!(position(src, src.len()), Position::new(2, 1));
        // Inside the surrogate pair: end of the character.
        assert_eq!(offset(src, Position::new(1, 2)), x);
        for i in [0, 2, 3, 5, x, x + 1, src.len()] {
            assert_eq!(offset(src, position(src, i)), i, "offset {i}");
        }
    }

    #[test]
    fn invalid_utf8_bytes_are_one_unit_each() {
        // Latin-1 "é" (0xE9) and "ü" (0xFC) are invalid UTF-8.
        let src = b"-- \xe9\xfc\nx <= y;";
        assert_eq!(position(src, 5), Position::new(0, 5));
        assert_eq!(offset(src, Position::new(0, 4)), 4);
        assert_eq!(offset(src, Position::new(1, 2)), 8);
        assert_eq!(position(src, 8), Position::new(1, 2));
    }
}
