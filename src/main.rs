//! `vsg-rs`: VSG's command line (see `vsg_cli`).

use std::process::ExitCode;

mod vsg_cli;

fn main() -> ExitCode {
    vsg_cli::main(std::env::args().collect())
}
