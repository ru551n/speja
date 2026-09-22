//! Print the layout changes the formatter makes, one JSON object per line:
//! `{"file": ..., "line": ..., "key": ..., "rule": ...}`. Used by
//! `scripts/learn_layout_rules.py` to map changes to VSG rules.
//!
//! `cargo run --release --example layout_keys -- FILE...`

use speja::layout::{layout_changes, rule_for};
use speja::{Config, Parsed};

fn main() {
    let config = Config::default();
    for path in std::env::args().skip(1) {
        let Ok(source) = std::fs::read(&path) else {
            continue;
        };
        let before = Parsed::new(source);
        let Ok(formatted) = speja::format_parsed(&before, &config.format) else {
            continue;
        };
        let after = Parsed::new(formatted);
        for change in layout_changes(&before, &after) {
            println!(
                "{}",
                serde_json::json!({
                    "file": path,
                    "line": change.line,
                    "key": change.key,
                    "rule": rule_for(&change),
                })
            );
        }
    }
}
