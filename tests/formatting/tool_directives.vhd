-- VHDL-2019 conditional analysis: directives stay on their own lines, at column 0.
architecture rtl of e is
    `if TOOL_NAME = "ghdl" then
  signal s : bit;
`else
  signal s : integer;
`end if
begin
  process begin
  `if DEBUG = "1" then
    report "debug";
      `end if
    wait;
  end process;
`warning "check the tool version"
end architecture rtl;
