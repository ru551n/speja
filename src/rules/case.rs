//! Identifier and label case (`case::name`, `case::label`) and consistent capitalization of
//! names after their declaration.
//!
//! VHDL identifiers are case-insensitive, so every fix here is a meaning-preserving rename of a
//! single token. Extended identifiers (`\Name\`) are case-sensitive and never touched.

use std::collections::HashMap;

use regex::Regex;
use vhdl_syntax::syntax::{NodeKind as N, SyntaxNode, SyntaxToken};
use vhdl_syntax::tokens::TokenKind as T;

use super::select::{
    bodies, child, children, clause_idents, declared, designators, end_ident, enum_literals,
    formals, generate_end_labels, generate_labels, ident, idents_of, interface_idents,
    interface_list, is_declaration_position, is_qualified_position, labels_of, name_idents,
    parameters, specs, subprogram_spec, tokens,
};
use super::{Check, Context, Edit, Fix, FixSafety, Rule, RuleInfo, Violation, violation};
use crate::config::{RuleSettings, Severity};

type Select = fn(&Context<'_>) -> Vec<SyntaxToken>;

fn text(t: &SyntaxToken) -> String {
    String::from_utf8_lossy(t.text().as_bytes()).into_owned()
}

fn is_extended(t: &SyntaxToken) -> bool {
    t.text().as_bytes().first() == Some(&b'\\')
}

/// The spelling a case policy requires for `name`: `Ok(None)` if it complies, `Ok(Some(fixed))`
/// with the fixed spelling, or `Err(())` if it does not comply and cannot be fixed mechanically.
fn required(settings: &RuleSettings, name: &str) -> Result<Option<String>, ()> {
    let lower = name.to_ascii_lowercase();
    if let Some(exact) = settings
        .option_list("case_exceptions")
        .into_iter()
        .find(|e| e.eq_ignore_ascii_case(name))
    {
        return Ok((exact != name).then(|| exact.to_owned()));
    }
    let prefix = settings
        .option_list("prefix_exceptions")
        .into_iter()
        .filter(|p| p.len() < name.len() && lower.starts_with(&p.to_ascii_lowercase()))
        .max_by_key(|p| p.len())
        .unwrap_or("");
    let suffix = settings
        .option_list("suffix_exceptions")
        .into_iter()
        .filter(|s| {
            prefix.len() + s.len() < name.len() && lower.ends_with(&s.to_ascii_lowercase())
        })
        .max_by_key(|s| s.len())
        .unwrap_or("");
    let core = &name[prefix.len()..name.len() - suffix.len()];
    let fixed_core = match settings.option_str("case").unwrap_or("lower") {
        "lower" => core.to_ascii_lowercase(),
        "upper" => core.to_ascii_uppercase(),
        policy => {
            let pattern = match policy {
                "camelCase" => "^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$",
                "PascalCase" => "^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$",
                "regex" => settings.option_str("regex").unwrap_or(""),
                _ => return Ok(None),
            };
            // An invalid user regex is reported by nothing else; treat it as matching.
            let ok = Regex::new(pattern).map_or(true, |re| re.is_match(core));
            let affixes_ok = name.starts_with(prefix) && name.ends_with(suffix);
            return match (ok, affixes_ok) {
                (true, true) => Ok(None),
                (true, false) => Ok(Some(format!("{prefix}{core}{suffix}"))),
                (false, _) => Err(()),
            };
        }
    };
    let fixed = format!("{prefix}{fixed_core}{suffix}");
    Ok((fixed != name).then_some(fixed))
}

/// `name` as the case rule `rule` requires it (unchanged if that rule is disabled or cannot fix).
pub(super) fn spelling(cx: &Context<'_>, rule: &str, name: String) -> String {
    super::info(rule)
        .map(|info| cx.config.rule(info))
        .filter(|s| s.enabled)
        .and_then(|s| required(&s, &name).ok().flatten())
        .unwrap_or(name)
}

fn rename(t: &SyntaxToken, to: String) -> Fix {
    let r = t.text_range();
    Fix {
        safety: FixSafety::Safe,
        edits: vec![Edit {
            start: r.start,
            end: r.end,
            text: to,
            rank: 0,
        }],
    }
}

fn check_case(
    cx: &Context<'_>,
    settings: &RuleSettings,
    out: &mut Vec<Violation>,
    rule: &'static str,
    select: Select,
) {
    let policy = settings.option_str("case").unwrap_or("lower");
    for t in select(cx) {
        if t.kind() != T::Identifier || is_extended(&t) {
            continue;
        }
        let name = text(&t);
        let fix = match required(settings, &name) {
            Ok(None) => continue,
            Ok(Some(fixed)) => Some(rename(&t, fixed)),
            Err(()) => None,
        };
        let mut v = violation(settings, rule, &t, format!("`{name}` is not {policy} case"));
        v.fix = fix;
        out.push(v);
    }
}

fn case_rule(id: &'static str, label: bool, description: &'static str, check: Check) -> Rule {
    Rule {
        info: RuleInfo {
            id,
            groups: if label {
                &["case", "case::label"]
            } else {
                &["case", "case::name"]
            },
            severity: Severity::Warning,
            enabled_by_default: true,
            description,
        },
        check,
    }
}

macro_rules! case_rules {
    ($label:literal; $($id:literal, $desc:literal, $select:expr;)*) => {
        vec![$(case_rule($id, $label, $desc, |cx, s, out| check_case(cx, s, out, $id, $select)),)*]
    };
}

fn end_of(cx: &Context<'_>, kind: N, epilogue: N) -> Vec<SyntaxToken> {
    cx.nodes(kind)
        .iter()
        .filter_map(|n| end_ident(n, epilogue))
        .collect()
}

fn name_parts(n: &SyntaxNode) -> Vec<SyntaxToken> {
    child(n, N::Name)
        .map(|name| name_idents(&name))
        .unwrap_or_default()
}

/// Prefix and selected words of every name in a use clause or context reference.
fn selected_names(cx: &Context<'_>, kind: N) -> Vec<Vec<SyntaxToken>> {
    cx.nodes(kind)
        .iter()
        .filter_map(|n| child(n, N::NameList))
        .flat_map(|l| children(&l, N::Name).map(|n| name_words(&n)).collect::<Vec<_>>())
        .collect()
}

/// The prefix and selected suffixes of a name, including `all`.
fn name_words(name: &SyntaxNode) -> Vec<SyntaxToken> {
    name.children()
        .filter(|p| matches!(p.kind(), N::NameDesignatorPrefix | N::SelectedName))
        .flat_map(|p| tokens(&p).filter(|t| t.kind() != T::Dot).collect::<Vec<_>>())
        .collect()
}

/// `use lib.pkg.item`: parts 0, 1, 2; `use lib.item`: parts 0 and 2.
fn use_part(cx: &Context<'_>, part: usize) -> Vec<SyntaxToken> {
    selected_names(cx, N::UseClause)
        .into_iter()
        .filter_map(|mut parts| match (part, parts.len()) {
            (0, _) => parts.first().cloned(),
            (1, 3..) => Some(parts.swap_remove(1)),
            (2, 2..) => parts.pop(),
            _ => None,
        })
        .collect()
}

fn context_part(cx: &Context<'_>, first: bool) -> Vec<SyntaxToken> {
    selected_names(cx, N::ContextReference)
        .into_iter()
        .filter(|p| p.len() >= 2)
        .filter_map(|p| if first { p.first().cloned() } else { p.last().cloned() })
        .collect()
}

fn entity_instances(cx: &Context<'_>, library: bool) -> Vec<SyntaxToken> {
    cx.nodes(N::InstantiatedEntity)
        .iter()
        .filter_map(|n| {
            let parts = name_parts(n);
            match (library, parts.len()) {
                (true, 2..) => parts.first().cloned(),
                (false, 1..) => parts.last().cloned(),
                _ => None,
            }
        })
        .collect()
}

fn instantiated_names(cx: &Context<'_>, kind: N) -> Vec<SyntaxToken> {
    cx.nodes(kind).iter().flat_map(name_parts).collect()
}

fn procedure_call_formals(cx: &Context<'_>) -> Vec<SyntaxToken> {
    cx.nodes(N::ProcedureCallStatement)
        .iter()
        .filter_map(|n| child(n, N::Name))
        .filter_map(|n| child(&n, N::ParenthesizedName))
        .flat_map(|p| formals(&p))
        .collect()
}

fn map_formals(cx: &Context<'_>, kind: N) -> Vec<SyntaxToken> {
    cx.nodes(kind).iter().flat_map(formals).collect()
}

fn type_names(cx: &Context<'_>) -> Vec<SyntaxToken> {
    let mut v = idents_of(cx, N::FullTypeDeclaration);
    v.extend(idents_of(cx, N::IncompleteTypeDeclaration));
    v.sort_by_key(SyntaxToken::text_offset);
    v
}

/// Type marks of subtype indications and return types whose type is not declared in this file.
fn type_marks(cx: &Context<'_>) -> Vec<SyntaxToken> {
    let local: std::collections::HashSet<String> = type_names(cx)
        .iter()
        .chain(&idents_of(cx, N::SubtypeDeclaration))
        .map(|t| text(t).to_ascii_lowercase())
        .collect();
    let returns = specs(cx, N::FunctionSpecification);
    cx.nodes(N::SubtypeIndication)
        .iter()
        .chain(&returns)
        .filter_map(|n| name_parts(n).pop())
        .filter(|t| !local.contains(&text(t).to_ascii_lowercase()))
        .collect()
}

fn subprogram_ends(cx: &Context<'_>, kind: N) -> Vec<SyntaxToken> {
    bodies(cx, kind)
        .iter()
        .filter_map(|b| end_ident(b, N::SubprogramBodyEpilogue))
        .collect()
}

fn spec_parameters(cx: &Context<'_>, kind: N) -> Vec<SyntaxToken> {
    specs(cx, kind).iter().flat_map(parameters).collect()
}

fn logical_names(cx: &Context<'_>) -> Vec<SyntaxToken> {
    cx.nodes(N::LogicalNameList)
        .iter()
        .flat_map(|l| {
            tokens(l)
                .filter(|t| t.kind() == T::Identifier)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn interface_names(cx: &Context<'_>, clause: N) -> Vec<SyntaxToken> {
    clause_idents(cx, clause)
        .into_iter()
        .map(|(t, _)| t)
        .collect()
}

fn case_name_rules() -> Vec<Rule> {
    case_rules! { false;
        "alias_declaration_502", "Alias designators are in the configured case.",
            |cx| idents_of(cx, N::AliasDeclaration);
        "architecture_011", "The name after `end architecture` is in the configured case.",
            |cx| end_of(cx, N::ArchitectureBody, N::ArchitectureEpilogue);
        "architecture_013", "Architecture names are in the configured case.",
            |cx| idents_of(cx, N::ArchitecturePreamble);
        "architecture_014", "The entity name of an architecture is in the configured case.",
            |cx| instantiated_names(cx, N::ArchitecturePreamble);
        "attribute_declaration_501", "Attribute names are in the configured case.",
            |cx| idents_of(cx, N::AttributeDeclaration);
        "attribute_declaration_502", "Attribute type marks are in the configured case.",
            |cx| instantiated_names(cx, N::AttributeDeclaration);
        "attribute_specification_501", "Attribute designators are in the configured case.",
            |cx| idents_of(cx, N::AttributeSpecification);
        "component_008", "Component names are in the configured case.",
            |cx| idents_of(cx, N::ComponentDeclarationPreamble);
        "component_012", "The name after `end component` is in the configured case.",
            |cx| end_of(cx, N::ComponentDeclaration, N::ComponentDeclarationEpilogue);
        "constant_004", "Constant names are in the configured case.",
            |cx| declared(cx, N::ConstantDeclaration);
        "context_012", "Context names are in the configured case.",
            |cx| idents_of(cx, N::ContextDeclarationPreamble);
        "context_016", "The name after `end context` is in the configured case.",
            |cx| end_of(cx, N::ContextDeclaration, N::ContextDeclarationEpilogue);
        "context_ref_500", "Library names in context references are in the configured case.",
            |cx| context_part(cx, true);
        "context_ref_501", "Context names in context references are in the configured case.",
            |cx| context_part(cx, false);
        "entity_008", "Entity names are in the configured case.",
            |cx| idents_of(cx, N::EntityDeclarationPreamble);
        "entity_012", "The name after `end entity` is in the configured case.",
            |cx| end_of(cx, N::EntityDeclaration, N::EntityDeclarationEpilogue);
        "file_500", "File object names are in the configured case.",
            |cx| declared(cx, N::FileDeclaration);
        "function_017", "Function designators are in the configured case.",
            |cx| designators(cx, N::FunctionSpecification);
        "function_506", "The designator after `end function` is in the configured case.",
            |cx| subprogram_ends(cx, N::FunctionSpecification);
        "function_507", "Function parameter names are in the configured case.",
            |cx| spec_parameters(cx, N::FunctionSpecification);
        "generic_007", "Generic names are in the configured case.",
            |cx| interface_names(cx, N::GenericClause);
        "generic_map_002", "Generic names in generic maps are in the configured case.",
            |cx| map_formals(cx, N::GenericMapAspect);
        "instantiation_009", "Component names in instantiations are in the configured case.",
            |cx| instantiated_names(cx, N::InstantiatedComponent);
        "instantiation_028", "Entity names in direct instantiations are in the configured case.",
            |cx| entity_instances(cx, false);
        "instantiation_500", "Library names in direct instantiations are in the configured case.",
            |cx| entity_instances(cx, true);
        "interface_incomplete_type_declaration_501",
            "Generic type names are in the configured case.",
            |cx| idents_of(cx, N::InterfaceIncompleteTypeDeclaration);
        "library_500", "Library names in library clauses are in the configured case.",
            logical_names;
        "package_008", "The name after `end package` is in the configured case.",
            |cx| end_of(cx, N::PackageDeclaration, N::PackageEpilogue);
        "package_010", "Package names are in the configured case.",
            |cx| idents_of(cx, N::PackagePreamble);
        "package_body_502", "Package body names are in the configured case.",
            |cx| idents_of(cx, N::PackageBodyPreamble);
        "package_body_507", "The name after `end package body` is in the configured case.",
            |cx| end_of(cx, N::PackageBody, N::PackageBodyEpilogue);
        "package_instantiation_501", "Instantiated package names are in the configured case.",
            |cx| idents_of(cx, N::PackageInstantiationPreamble);
        "package_instantiation_504",
            "Uninstantiated package names are in the configured case.",
            |cx| instantiated_names(cx, N::PackageInstantiationPreamble);
        "parameter_specification_500",
            "Loop and generate parameters are in the configured case.",
            |cx| idents_of(cx, N::ParameterSpecification);
        "port_010", "Port names are in the configured case.",
            |cx| interface_names(cx, N::PortClause);
        "port_map_002", "Port names in port maps are in the configured case.",
            |cx| map_formals(cx, N::PortMapAspect);
        "procedure_501", "Procedure designators are in the configured case.",
            |cx| designators(cx, N::ProcedureSpecification);
        "procedure_506", "The designator after `end procedure` is in the configured case.",
            |cx| subprogram_ends(cx, N::ProcedureSpecification);
        "procedure_508", "Procedure parameter names are in the configured case.",
            |cx| spec_parameters(cx, N::ProcedureSpecification);
        "procedure_call_502",
            "Formal parameter names in procedure calls are in the configured case.",
            procedure_call_formals;
        "signal_004", "Signal names are in the configured case.",
            |cx| declared(cx, N::SignalDeclaration);
        "subprogram_instantiation_500",
            "Instantiated subprogram names are in the configured case.",
            |cx| idents_of(cx, N::SubprogramInstantiationDeclarationPreamble);
        "subprogram_instantiation_503",
            "Uninstantiated subprogram names are in the configured case.",
            |cx| instantiated_names(cx, N::SubprogramInstantiationDeclarationPreamble);
        "subtype_501", "Subtype names are in the configured case.",
            |cx| idents_of(cx, N::SubtypeDeclaration);
        "type_004", "Type names are in the configured case.",
            type_names;
        "type_500", "Enumeration literals are in the configured case.",
            enum_literals;
        "type_mark_500",
            "Type marks of types not declared in the file are in the configured case.",
            type_marks;
        "use_clause_500", "Library names in use clauses are in the configured case.",
            |cx| use_part(cx, 0);
        "use_clause_501", "Package names in use clauses are in the configured case.",
            |cx| use_part(cx, 1);
        "use_clause_502", "Item names in use clauses are in the configured case.",
            |cx| use_part(cx, 2);
        "variable_004", "Variable names are in the configured case.",
            |cx| declared(cx, N::VariableDeclaration);
    }
}

fn case_label_rules() -> Vec<Rule> {
    case_rules! { true;
        "block_500", "Block labels are in the configured case.",
            |cx| labels_of(cx, N::BlockStatement);
        "block_506", "The label after `end block` is in the configured case.",
            |cx| end_of(cx, N::BlockStatement, N::BlockEpilogue);
        "generate_005", "Generate labels are in the configured case.",
            generate_labels;
        "generate_012", "The label after `end generate` is in the configured case.",
            generate_end_labels;
        "instantiation_008", "Instance labels are in the configured case.",
            |cx| labels_of(cx, N::ComponentInstantiationStatement);
        "loop_statement_503", "Loop labels are in the configured case.",
            |cx| labels_of(cx, N::LoopStatement);
        "loop_statement_504", "The label after `end loop` is in the configured case.",
            |cx| end_of(cx, N::LoopStatement, N::LoopStatementEpilogue);
        "procedure_call_500", "Procedure call labels are in the configured case.",
            |cx| labels_of(cx, N::ProcedureCallStatement);
        "process_017", "Process labels are in the configured case.",
            |cx| labels_of(cx, N::ProcessStatement);
        "process_019", "The label after `end process` is in the configured case.",
            |cx| end_of(cx, N::ProcessStatement, N::ProcessEpilogue);
    }
}

/// Declarations and the region in which their uses must repeat the declared spelling.
struct Scope {
    decls: Vec<SyntaxToken>,
    region: SyntaxNode,
}

type Scopes = fn(&Context<'_>) -> Vec<Scope>;

fn file_scope(cx: &Context<'_>, decls: Vec<SyntaxToken>) -> Vec<Scope> {
    vec![Scope {
        decls,
        region: cx.parsed.root().clone(),
    }]
}

fn lower_text(t: &SyntaxToken) -> String {
    text(t).to_ascii_lowercase()
}

/// Interface names of each entity, used in the entity itself (`in_entity`) or in the
/// architectures of that entity in the same file.
fn entity_scopes(cx: &Context<'_>, clause: N, in_entity: bool) -> Vec<Scope> {
    let mut out = Vec::new();
    for entity in cx.nodes(N::EntityDeclaration) {
        let decls: Vec<SyntaxToken> = child(entity, N::EntityHeader)
            .and_then(|h| child(&h, clause))
            .and_then(|c| interface_list(&c))
            .map(|l| interface_idents(&l).into_iter().map(|(t, _)| t).collect())
            .unwrap_or_default();
        if decls.is_empty() {
            continue;
        }
        if in_entity {
            out.push(Scope {
                decls,
                region: entity.clone(),
            });
            continue;
        }
        let name = child(entity, N::EntityDeclarationPreamble)
            .and_then(|p| ident(&p))
            .map(|t| lower_text(&t));
        for arch in cx.nodes(N::ArchitectureBody) {
            let of = child(arch, N::ArchitecturePreamble)
                .and_then(|p| name_parts(&p).pop())
                .map(|t| lower_text(&t));
            if of.is_some() && of == name {
                out.push(Scope {
                    decls: decls.clone(),
                    region: arch.clone(),
                });
            }
        }
    }
    out
}

fn body_scopes(cx: &Context<'_>, kind: N) -> Vec<Scope> {
    bodies(cx, kind)
        .into_iter()
        .filter_map(|b| {
            let spec = subprogram_spec(&b)?;
            Some(Scope {
                decls: parameters(&spec),
                region: b,
            })
        })
        .collect()
}

fn check_consistency(
    cx: &Context<'_>,
    settings: &RuleSettings,
    out: &mut Vec<Violation>,
    rule: &'static str,
    declaration_rule: &str,
    scopes: Scopes,
) {
    // The declaration's own case rule decides the target spelling, so one fix run suffices.
    let all = cx.parsed.tokens();
    for scope in scopes(cx) {
        let mut target: HashMap<String, Option<String>> = HashMap::new();
        for d in scope.decls.iter().filter(|d| !is_extended(d)) {
            let name = text(d);
            let spelled = spelling(cx, declaration_rule, name);
            target
                .entry(spelled.to_ascii_lowercase())
                .and_modify(|t| {
                    if t.as_deref() != Some(spelled.as_str()) {
                        *t = None; // Declared with different spellings: ambiguous.
                    }
                })
                .or_insert(Some(spelled));
        }
        let range = scope.region.text_range();
        let first = all.partition_point(|t| t.text_offset() < range.start);
        let last = all.partition_point(|t| t.text_offset() < range.end);
        for t in &all[first..last] {
            if t.kind() != T::Identifier
                || is_extended(t)
                || is_declaration_position(t)
                || is_qualified_position(t)
            {
                continue;
            }
            let name = text(t);
            let Some(Some(want)) = target.get(&name.to_ascii_lowercase()) else {
                continue;
            };
            if *want != name && !scope.decls.contains(t) {
                let mut v = violation(
                    settings,
                    rule,
                    t,
                    format!("`{name}` differs from its declaration `{want}`"),
                );
                v.fix = Some(rename(t, want.clone()));
                out.push(v);
            }
        }
    }
}

macro_rules! consistency_rules {
    ($($id:literal, $decl:literal, $desc:literal, $scopes:expr;)*) => {
        vec![$(Rule {
            info: RuleInfo {
                id: $id,
                groups: &[],
                severity: Severity::Warning,
                enabled_by_default: true,
                description: $desc,
            },
            check: |cx, s, out| check_consistency(cx, s, out, $id, $decl, $scopes),
        },)*]
    };
}

fn consistency() -> Vec<Rule> {
    consistency_rules! {
        "alias_declaration_503", "alias_declaration_502",
            "Uses of an alias repeat the declared spelling.",
            |cx| file_scope(cx, idents_of(cx, N::AliasDeclaration));
        "architecture_600", "generic_007",
            "Uses of generics in an architecture repeat the declared spelling.",
            |cx| entity_scopes(cx, N::GenericClause, false);
        "architecture_601", "port_010",
            "Uses of ports in an architecture repeat the declared spelling.",
            |cx| entity_scopes(cx, N::PortClause, false);
        "constant_013", "constant_004", "Uses of a constant repeat the declared spelling.",
            |cx| file_scope(cx, declared(cx, N::ConstantDeclaration));
        "entity_600", "generic_007",
            "Uses of generics in an entity repeat the declared spelling.",
            |cx| entity_scopes(cx, N::GenericClause, true);
        "function_010", "function_017", "Calls of a function repeat the declared spelling.",
            |cx| file_scope(cx, designators(cx, N::FunctionSpecification));
        "function_508", "function_507",
            "Uses of parameters in a function body repeat the declared spelling.",
            |cx| body_scopes(cx, N::FunctionSpecification);
        "procedure_507", "procedure_501", "Calls of a procedure repeat the declared spelling.",
            |cx| file_scope(cx, designators(cx, N::ProcedureSpecification));
        "procedure_509", "procedure_508",
            "Uses of parameters in a procedure body repeat the declared spelling.",
            |cx| body_scopes(cx, N::ProcedureSpecification);
        "signal_014", "signal_004", "Uses of a signal repeat the declared spelling.",
            |cx| file_scope(cx, declared(cx, N::SignalDeclaration));
        "subtype_002", "subtype_501", "Uses of a subtype repeat the declared spelling.",
            |cx| file_scope(cx, idents_of(cx, N::SubtypeDeclaration));
        "type_014", "type_004", "Uses of a type repeat the declared spelling.",
            |cx| file_scope(cx, type_names(cx));
        "type_501", "type_500", "Uses of enumeration literals repeat the declared spelling.",
            |cx| file_scope(cx, enum_literals(cx));
        "variable_011", "variable_004", "Uses of a variable repeat the declared spelling.",
            |cx| file_scope(cx, declared(cx, N::VariableDeclaration));
    }
}

pub(super) fn rules() -> Vec<Rule> {
    let mut all = case_name_rules();
    all.extend(case_label_rules());
    all.extend(consistency());
    all
}

#[cfg(test)]
mod tests {
    use crate::Parsed;
    use crate::config::Config;

    fn found(src: &str, yaml: &str) -> Vec<(&'static str, String)> {
        let config = Config::parse(yaml).unwrap();
        crate::rules::check(&Parsed::new(src.as_bytes().to_vec()), &config)
            .into_iter()
            .map(|v| (v.rule, src[v.start..v.end].to_owned()))
            .collect()
    }

    fn has(found: &[(&str, String)], rule: &str, text: &str) -> bool {
        found.iter().any(|(r, t)| *r == rule && t == text)
    }

    const SRC: &str = "library IEEE;\nuse IEEE.Numeric_Std.all;\nentity E is\n  generic (G_W : natural);\n  port (Clk : in STD_LOGIC);\nend entity e;\narchitecture rtl of e is\n  signal sig : unsigned(g_w - 1 downto 0);\nbegin\n  SIG <= (others => CLK);\nend architecture rtl;\n";

    #[test]
    fn names_and_uses() {
        let f = found(SRC, "");
        for (rule, text) in [
            ("library_500", "IEEE"),
            ("use_clause_500", "IEEE"),
            ("use_clause_501", "Numeric_Std"),
            ("entity_008", "E"),
            ("generic_007", "G_W"),
            ("port_010", "Clk"),
            ("type_mark_500", "STD_LOGIC"),
            ("signal_014", "SIG"),
            ("architecture_601", "CLK"),
        ] {
            assert!(has(&f, rule, text), "{rule} {text} missing in {f:?}");
        }
        // `g_w` already matches the lower-case target of `G_W`.
        assert!(!f.iter().any(|(r, _)| *r == "architecture_600"), "{f:?}");
    }

    #[test]
    fn upper_case_and_exceptions() {
        let yaml = "rule:\n  global:\n    case: upper\n  generic_007:\n    prefix_exceptions: ['g_']\n";
        let f = found(SRC, yaml);
        assert!(has(&f, "generic_007", "G_W"), "{f:?}");
        assert!(has(&f, "port_010", "Clk"), "{f:?}");
        assert!(!f.iter().any(|(r, _)| *r == "library_500"), "{f:?}");
    }

    #[test]
    fn fix_renames_in_one_run() {
        let config = Config::default();
        let text = String::from_utf8(crate::fix::fix(&Parsed::new(SRC.as_bytes().to_vec()), &config).unwrap().output)
            .unwrap();
        assert!(text.contains("library ieee;"), "{text}");
        assert!(text.contains("sig <= (others => clk);"), "{text}");
        let again = crate::rules::check(&Parsed::new(text.clone().into_bytes()), &config);
        let fixable: Vec<_> = again
            .iter()
            .filter(|v| v.fix.is_some())
            .map(|v| v.rule)
            .collect();
        assert!(fixable.is_empty(), "{fixable:?}\n{text}");
    }
}
