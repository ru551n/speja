//! VSG 3.35's default configuration (as written by `vsg -oc`) and the rule groups of every
//! rule. Used to print the effective configuration (`-oc`, `-rc`), to count enabled rules and
//! to interpret `indent.tokens`.

use std::sync::OnceLock;

use serde_json::Value;

static TEXT: &str = include_str!("vsg_defaults.json");

/// `{"indent": …, "pragma": …, "rule": {id: {…}}, "groups": {id: [group, …]}}`.
pub fn defaults() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(TEXT).expect("bundled defaults are valid JSON"))
}

/// Every VSG rule id, sorted.
pub fn rule_ids() -> impl Iterator<Item = &'static str> {
    defaults()["rule"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.keys().map(String::as_str))
}

/// The groups a rule belongs to.
pub fn groups(id: &str) -> &'static [&'static str] {
    static GROUPS: OnceLock<std::collections::HashMap<&'static str, Vec<&'static str>>> =
        OnceLock::new();
    GROUPS
        .get_or_init(|| {
            defaults()["groups"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.iter())
                .map(|(k, v)| {
                    let groups = v
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    (k.as_str(), groups)
                })
                .collect()
        })
        .get(id)
        .map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_defaults() {
        assert_eq!(super::rule_ids().count(), 972);
        assert_eq!(super::groups("entity_008"), ["case", "case::name"]);
        assert_eq!(super::defaults()["rule"]["entity_015"]["action"], "add");
    }
}
