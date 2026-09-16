use vhdl_syntax::syntax::{AstNode, node::SyntaxElement};
fn dump(e: &SyntaxElement, d: usize) {
    match e {
        SyntaxElement::Node(n) => {
            println!("{}{:?}", "  ".repeat(d), n.kind());
            for c in n.children_with_tokens() {
                dump(&c, d + 1);
            }
        }
        SyntaxElement::Token(t) => println!(
            "{}{:?} {:?} lt={:?}",
            "  ".repeat(d),
            t.kind(),
            t.text().to_string(),
            t.leading_trivia()
        ),
    }
}
fn main() {
    let src = std::fs::read(std::env::args().nth(1).unwrap()).unwrap();
    let (f, errs) = vhdl_syntax::parser::parse(src.as_slice());
    dump(&SyntaxElement::Node(f.raw()), 0);
    eprintln!("{errs:?}");
}
