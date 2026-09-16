//! Timing of the library on generated worst-case inputs.
//!
//! `cargo run --release --example bench`
//!
//! Cold-start and stdin timing of the binary is measured separately (see `docs/performance.md`).

use std::fmt::Write;
use std::hint::black_box;
use std::time::{Duration, Instant};

use vsg_rs::{Config, Parsed};

fn time<T>(runs: u32, mut f: impl FnMut() -> T) -> Duration {
    let mut best = Duration::MAX;
    for _ in 0..runs {
        let start = Instant::now();
        black_box(f());
        best = best.min(start.elapsed());
    }
    best
}

fn small() -> String {
    "library ieee;\nuse ieee.std_logic_1164.all;\n\nentity small is\n  port (clk : in std_logic; d : in std_logic; q : out std_logic);\nend entity small;\n\narchitecture rtl of small is\nbegin\n  process (clk) is\n  begin\n    if rising_edge(clk) then\n      q <= d;\n    end if;\n  end process;\nend architecture rtl;\n".into()
}

fn statements(n: usize) -> String {
    let mut s = String::from("architecture a of e is\nbegin\n");
    for i in 0..n {
        let _ = writeln!(
            s,
            "  s{i} <= a{i} and b{i} when c{i} = '1' else d{i}; -- note {i}"
        );
    }
    s + "end architecture a;\n"
}

fn fold_heavy(n: usize) -> String {
    let mut s = String::from("architecture a of e is\nbegin\n");
    for i in 0..n {
        let terms: Vec<String> = (0..12).map(|k| format!("signal_number_{i}_{k}")).collect();
        let _ = writeln!(s, "  result_{i} <= {};", terms.join(" and "));
        let args: Vec<String> = (0..10).map(|k| format!("argument_{i}_{k}")).collect();
        let _ = writeln!(s, "  call_{i} <= some_function({});", args.join(", "));
    }
    s + "end architecture a;\n"
}

fn deep_nesting(depth: usize) -> String {
    let mut expr = String::from("x");
    for i in 0..depth {
        expr = format!("f{i}({expr}, y{i} and z{i})");
    }
    format!("architecture a of e is\nbegin\n  r <= {expr};\nend architecture a;\n")
}

fn port_map(n: usize) -> String {
    let generics: Vec<String> = (0..n).map(|i| format!("g{i} => {i}")).collect();
    let ports: Vec<String> = (0..n).map(|i| format!("p{i} => sig({i})")).collect();
    format!(
        "architecture a of e is\nbegin\n  u0 : entity work.big generic map ({}) port map ({});\nend architecture a;\n",
        generics.join(", "),
        ports.join(", ")
    )
}

fn boolean_chain(n: usize) -> String {
    let terms: Vec<String> = (0..n).map(|i| format!("(a{i} = b{i})")).collect();
    format!(
        "architecture a of e is\nbegin\n  r <= {};\nend architecture a;\n",
        terms.join(" or ")
    )
}

fn aggregate(n: usize) -> String {
    let items: Vec<String> = (0..n).map(|i| i.to_string()).collect();
    format!(
        "package p is\n  constant table : integer_vector := ({});\nend package p;\n",
        items.join(", ")
    )
}

fn main() {
    let config = Config::default();
    let cases = [
        ("small file", small()),
        ("5k statements", statements(5000)),
        ("fold-heavy (2k lines)", fold_heavy(1000)),
        ("deep nesting (depth 300)", deep_nesting(300)),
        ("1000 generics + ports", port_map(1000)),
        ("2000-term boolean chain", boolean_chain(2000)),
        ("10k-element aggregate", aggregate(10_000)),
        ("20k-line architecture", statements(20_000)),
    ];
    println!(
        "{:26} {:>9} {:>10} {:>10} {:>10} {:>10}",
        "input", "bytes", "parse", "format", "lint", "fix"
    );
    for (name, src) in &cases {
        let bytes = src.as_bytes().to_vec();
        let runs = if bytes.len() > 500_000 { 3 } else { 10 };
        let parse = time(runs, || Parsed::new(bytes.clone()));
        let parsed = Parsed::new(bytes.clone());
        assert!(
            parsed.syntax_errors().is_empty(),
            "{name}: generated input must parse"
        );
        let format = time(runs, || {
            vsg_rs::format_parsed(&parsed, &config.format).unwrap()
        });
        let lint = time(runs, || vsg_rs::rules::check(&parsed, &config));
        let fix = time(runs, || vsg_rs::fix(&parsed, &config).unwrap());
        println!(
            "{name:26} {:>9} {parse:>10.2?} {format:>10.2?} {lint:>10.2?} {fix:>10.2?}",
            bytes.len()
        );
    }
}
