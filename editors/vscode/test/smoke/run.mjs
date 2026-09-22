// Run the editing features in a real VS Code, against a real VHDL-LS.
//
//   VHDL_LS=/path/to/vhdl_ls npm run smoke
//
// The editing half of this extension asks a VHDL language server everything it writes, so it can
// only be checked by starting an editor and a server. This builds a small project (two
// libraries, and enough entities to pass the server's 200-symbol cap on a workspace query),
// copies the compiled extension beside a suite, launches VS Code with both, and reports what
// the suite found.
//
// It needs a display, the `code` command, the VHDL-LS extension installed in that VS Code, and a
// `vhdl_ls` binary that can find its `vhdl_libraries`. It is not part of CI for those reasons.
//
//   VHDL_LS   the vhdl_ls executable (required)
//   CODE      the VS Code command (default: code)
//   KEEP=1    keep the scratch directory after a passing run

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const vhdlLs = process.env.VHDL_LS;
// speja's own server. The extension defaults to the one bundled in a packaged VSIX, and a dev
// checkout has none, so until this was passed the suite silently tested VHDL-LS only and
// nothing speja itself provides.
const speja = process.env.SPEJA ?? join(root, "..", "..", "target", "release", "speja");
const code = process.env.CODE ?? "code";

if (!vhdlLs || !existsSync(vhdlLs)) {
  console.error("Set VHDL_LS to a vhdl_ls executable that can find its vhdl_libraries.");
  process.exit(2);
}
if (!existsSync(speja)) {
  console.error(`No speja server at ${speja}. Build one (cargo build --release) or set SPEJA.`);
  process.exit(2);
}
if (!existsSync(join(root, "out", "editing.js"))) {
  console.error("Run `npm run compile` first: the extension under test is out/.");
  process.exit(2);
}

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "speja-smoke-"));
const workspace = join(scratch, "ws");
const extension = join(scratch, "ext");
const userData = join(scratch, "profile");
const results = join(scratch, "results.txt");
for (const directory of [workspace, join(workspace, "other"), join(workspace, "generated"), join(workspace, ".vscode"), extension, userData]) {
  mkdirSync(directory, { recursive: true });
}
const write = (name, text) => writeFileSync(join(workspace, name), text);

// top, fifo, leaf, fsm, usage and clauses, and the forty below.
// `generated/excluded.vhd` is in no library, but the server still indexes it as its own unit.
const ENTITIES = 56;   // layout.vhd, declare.vhd, apply.vhd and generated/excluded.vhd included

// Two libraries. A library name of `work` in vhdl_ls.toml is silently ignored by the server, so
// neither uses it.
// `unresolved` is VHDL-LS's diagnostic, and amber is the honest colour for it: what to do about
// a name with no declaration -- declare it, import it, fix the typo -- is the author's call, and
// the declare actions hang off it. VHDL-LS is the only thing that can set it, from here.
write(
  "vhdl_ls.toml",
  "[libraries]\nmylib.files = ['*.vhd']\nother.files = ['other/*.vhd']\n\n" +
    "[lint]\nunresolved = 'warning'\n",
);
write(".vscode/settings.json", JSON.stringify({
  "vhdlls.languageServer": "user",
  "vhdlls.languageServerUserPath": vhdlLs,
  // Point the extension at the server just built, not at a bundled one it does not have.
  "speja.server.mode": "userPath",
  "speja.server.path": speja,
}, null, 2));

write("fifo.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity fifo is
  generic (
    width : positive := 8
  );
  port (
    clk   : in    std_logic;
    rst   : in    std_logic;
    din   : in    std_logic_vector(width - 1 downto 0);
    dout  : out   std_logic_vector(width - 1 downto 0);
    empty : out   std_logic
  );
end entity fifo;

architecture rtl of fifo is

begin

end architecture rtl;
`);

write("top.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity top is
end entity top;

architecture rtl of top is

  signal clk : std_logic;
  signal rst : std_logic;

begin

  u_fifo : entity work.fifo
    port map (
      clk => clk,
      rst => rst
    );

end architecture rtl;
`);

write("other/leaf.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity leaf is
  port (
    a : in  std_logic;
    y : out std_logic
  );
end entity leaf;

architecture rtl of leaf is
begin
  y <= a;
end architecture rtl;
`);

// A state machine over an enumeration type that spans several lines, so the signal has to go
// after all of it and the process after the architecture's own `begin`.
// A tidy file with one over-long line and one unindented signal: what Format Selection and the
// format-this-line action are for. Kept apart from the other fixtures so a formatting test
// cannot be thrown off by someone else's edits.
write("layout.vhd", `library ieee;
  use ieee.std_logic_1164.all;
  use ieee.numeric_std.all;

entity layout is
  port (
    clk   : in    std_logic;
    value : out   unsigned(7 downto 0)
  );
end entity layout;

architecture rtl of layout is

signal count : unsigned(7 downto 0);

begin

  value <= count when count > to_unsigned(3, count'length) and count < to_unsigned(200, count'length) else (others => '0');

end architecture rtl;
`);

write("fsm.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity fsm is
  port (
    clk : in std_logic;
    rst : in std_logic;
    go  : in std_logic
  );
end entity fsm;

architecture rtl of fsm is

  type state_t is (
    idle,
    run,
    finish
  );

begin

end architecture rtl;
`);

// Declarations that do not exist yet: a name used in the architecture, a name used in a process,
// a port map whose actuals are undeclared, and a `case` over a signal nobody has declared. Each
// one is a lightbulb the author should find where they are already typing.
write("declare.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity declare_me is
  port (
    clk : in    std_logic;
    go  : in    std_logic
  );
end entity declare_me;

architecture rtl of declare_me is

  type phase_t is (arm, fire, wait_ack);

  signal phase : phase_t := arm;

begin

  u_fifo : entity work.fifo
    generic map (
      width => 8
    )
    port map (
      clk  => clk,
      rst  => reset_n,
      din  => data_in,
      dout => data_out
    );

  g_lanes : for i in 0 to 3 generate
    signal lane_valid : std_logic;
  begin
    lane_valid <= go;
    lane_out <= lane_valid;
  end generate g_lanes;

  b_guard : block is
  begin
    gate_out <= go;
  end block b_guard;

  p_main : process (clk) is
    procedure bump (n : in integer) is
    begin
      tally := tally + n;
    end procedure bump;
  begin
    if rising_edge(clk) then
      scratch := go;
      held <= go;
      held <= flag_a and flag_b;
      case phase is
        when arm =>
          null;
      end case;
      case sequencer is
        when others =>
          null;
      end case;
    end if;
  end process;

end architecture rtl;
`);

// A second copy of the same shapes, untouched by the checks that only read titles, so the
// actions can be applied to it and the result checked against the server.
write("apply.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity apply_me is
  port (
    clk : in    std_logic;
    go  : in    std_logic
  );
end entity apply_me;

architecture rtl of apply_me is

  signal tally : std_logic_vector(3 downto 0);

begin

  u_fifo : entity work.fifo
    port map (
      clk  => clk,
      rst  => reset_n,
      din  => data_in,
      dout => data_out
    );

  g_lanes : for i in 0 to 3 generate
    signal lane_valid : std_logic;
  begin
    lane_valid <= go;
    lane_out <= lane_valid;
  end generate g_lanes;

  b_guard : block is
  begin
    gate_out <= go;
  end block b_guard;

  p_main : process (clk) is
  begin
    if rising_edge(clk) then
      scratch := go;
      tally <= step;
      case sequencer is
        when others =>
          null;
      end case;
    end if;
  end process;

end architecture rtl;
`);

// `speja: exclude` in the workspace root, and a file inside it. speja should have nothing to say
// about the file however badly it is laid out.
write("speja.yaml", `speja:
  exclude:
    - generated
`);
write("generated/excluded.vhd", `entity excluded is
port (
a : in bit
);
end;
`);

// A case statement as it looks while it is being typed: no arms, no `end case`, so the file does
// not parse. This is the moment "insert state machine" is for, and the only moment the action is
// reached through text rather than through anything the server said.
write("halfcase.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity halfcase is
  port (
    clk : in    std_logic
  );
end entity halfcase;

architecture rtl of halfcase is

  signal tick : std_logic;
  signal counter : integer;

begin

  p_typed : process (clk) is
  begin
    case walker is
  end process;

  p_declared : process (clk) is
  begin
    case counter is
      when others =>
        null;
    end case;
  end process;

end architecture rtl;
`);

// An enumeration declared inside a process, not in the architecture. The state machine command
// writes a process, and a process does not go inside a process.
write("innerfsm.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity innerfsm is
  port (
    clk : in    std_logic
  );
end entity innerfsm;

architecture rtl of innerfsm is

begin

  p_inner : process (clk) is
    type t_inner is (idle, run);
  begin
  end process;

end architecture rtl;
`);

// `case mode`, and nothing else: no `is`, no arms, no `end case`. The file does not parse, and
// the question is whether the server will still say what `mode` is.
write("typing.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity typing is
  port (
    clk : in    std_logic
  );
end entity typing;

architecture rtl of typing is

  type t_mode is (boot, idle, active);

  signal mode : t_mode := boot;

begin

  p_mode : process (clk) is
  begin
    case mode
  end process;

end architecture rtl;
`);

// A package of the project's own, and a file that needs a name from it without saying so. The
// use-clause quick fix has only ever been checked against `ieee`, where the library clause is
// already there; here both the `library` and the `use` have to be written.
write("counter_pkg.vhd", `library ieee;
use ieee.std_logic_1164.all;

package counter_pkg is

  constant c_counter_width : positive := 8;

end package counter_pkg;
`);
write("other/needs_pkg.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity needs_pkg is
  port (
    count : out   std_logic_vector(7 downto 0)
  );
end entity needs_pkg;

architecture rtl of needs_pkg is

  signal held : natural;

begin

  held <= c_counter_width;

end architecture rtl;
`);

// The testbed's own files, verbatim, because the actions that work here did not work there.
writeFileSync(join(workspace, "tb_demo.vhd"), '-- Everything that offers to declare something for you. Each name below is deliberately missing.\n--\n--  * `sys_clk`, `sys_rst`, `sample`: actuals of the port map that nothing declares. Put the\n--    cursor in the map and press Ctrl+. for "Declare 3 signals for this port map", which writes\n--    all of them with the port\'s type, the generic\'s value substituted.\n--  * `busy`: assigned with `<=`, so a signal is offered. Inside a process, but a signal still\n--    belongs to the architecture, and that is where it lands.\n--  * `tmp`: assigned with `:=`, so a variable is offered, in the process\'s own declarations.\n--  * `lane_hit`: used inside a generate, which declares signals of its own. Both the generate\n--    and the architecture are offered, nearest first.\n--  * `phase`: a case over an enumeration with one arm written. "Add 2 missing when choices".\nlibrary ieee;\n  use ieee.std_logic_1164.all;\n  use ieee.numeric_std.all;\n\nentity declare_demo is\n  port (\n    clk : in std_logic;\n    go : in std_logic;\n    done : out std_logic\n  );\nend entity declare_demo;\n\narchitecture rtl of declare_demo is\n\n  type t_phase is (arm, fire, recover);\n\n  signal phase : t_phase := arm;\n\nbegin\n\n  u_counter : entity work.counter\n    generic map (\n      width => 8\n    )\n    port map (\n      clk => sys_clk,\n      rst => sys_rst,\n      value => sample\n    );\n\n  g_lanes : for i in 0 to 3 generate\n    signal lane_valid : std_logic;\n  begin\n    lane_valid <= go;\n    lane_hit <= lane_valid;\n  end generate g_lanes;\n\n  p_main : process (clk) is\n  begin\n\n    if rising_edge(clk) then\n      tmp := go;\n      busy <= go;\n\n      case phase is\n        when arm =>\n\n          null;\n      end case;\n\n    end if;\n  end process;\n\n  done <= go;\n\nend architecture rtl;\n');
writeFileSync(join(workspace, "tb_counter_unit.vhd"), "-- Formatted the way speja formats, and free of lint findings. Opening this should show nothing\n-- at all: an empty report means it proved nothing was wrong, not that it stayed quiet.\nlibrary ieee;\n  use ieee.std_logic_1164.all;\n  use ieee.numeric_std.all;\n\nentity counter is\n  generic (\n    width : positive := 8\n  );\n  port (\n    clk   : in    std_logic;\n    rst   : in    std_logic;\n    value : out   unsigned(width - 1 downto 0)\n  );\nend entity counter;\n\narchitecture rtl of counter is\n\n  signal count : unsigned(width - 1 downto 0);\n\nbegin\n\n  tick : process (clk) is\n  begin\n\n    if rising_edge(clk) then\n      if (rst = '1') then\n        count <= (others => '0');\n      else\n        count <= count + 1;\n      end if;\n    end if;\n\n  end process tick;\n\n  value <= count;\n\nend architecture rtl;\n");

// A use clause that nothing needs, beside one that is needed.
write("clauses.vhd", `library ieee;
use ieee.std_logic_1164.all;
use ieee.math_real.all;

entity clauses is
  port (
    a : in std_logic
  );
end entity clauses;
`);

// A type the file cannot see yet: it needs \`use ieee.numeric_std.all\`.
write("usage.vhd", `library ieee;
use ieee.std_logic_1164.all;

entity usage is
end entity usage;

architecture rtl of usage is

  signal x : unsigned(3 downto 0);

begin

end architecture rtl;
`);

// Forty more, with eight ports each. The server answers a workspace symbol query with at most
// 200 symbols and counts every port and architecture, so a project this size is one a query
// cannot list in full. That is what makes it a test of the picker and the hierarchy.
for (let unit = 0; unit < 40; unit++) {
  const name = `unit${String(unit).padStart(2, "0")}`;
  const ports = Array.from({ length: 8 }, (_, port) => `    p${port} : in std_logic${port < 7 ? ";" : ""}`).join("\n");
  write(`${name}.vhd`, `library ieee;\nuse ieee.std_logic_1164.all;\n\nentity ${name} is\n  port (\n${ports}\n  );\nend entity ${name};\n\narchitecture rtl of ${name} is\nbegin\nend architecture rtl;\n`);
}

// The extension as it would ship, with the suite beside it. The suite has to live inside the
// extension to share its API object, which is what lets it answer the extension's prompts.
for (const item of ["out", "package.json", "language-configuration.json", "syntaxes", "themes"]) {
  cpSync(join(root, item), join(extension, item), { recursive: true });
}
symlinkSync(join(root, "node_modules"), join(extension, "node_modules"));
mkdirSync(join(extension, "test"));
cpSync(join(root, "test", "smoke", "suite.js"), join(extension, "test", "index.js"));

console.log(`Running in ${scratch}`);
spawnSync(
  code,
  [
    "--new-window",
    `--user-data-dir=${userData}`,
    `--extensionDevelopmentPath=${extension}`,
    `--extensionTestsPath=${join(extension, "test", "index.js")}`,
    "--disable-workspace-trust",
    workspace,
  ],
  { stdio: "inherit", env: { ...process.env, VSGRS_EXT: extension, VSGRS_RESULTS: results, VSGRS_ENTITIES: String(ENTITIES) } },
);

// The launcher returns as soon as the editor has started; the suite writes `done` when it ends.
const deadline = Date.now() + 5 * 60 * 1000;
const finished = () => existsSync(results) && /^done$/m.test(readFileSync(results, "utf8"));
while (!finished() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const report = existsSync(results) ? readFileSync(results, "utf8") : "(the suite wrote nothing)\n";
console.log(report);
try {
  // Only the window this run started: its profile directory is unique to it.
  execFileSync("pkill", ["-f", "--", `--user-data-dir=${userData}`]);
} catch {
  // Already gone, or no pkill to ask.
}

const failed = !finished() || /^(FAIL|HARNESS ERROR)/m.test(report);
if (!failed && !process.env.KEEP) rmSync(scratch, { recursive: true, force: true });
else console.log(`Left ${scratch} for inspection.`);
process.exit(failed ? 1 : 0);
