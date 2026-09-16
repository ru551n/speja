library ieee;
  use ieee.std_logic_1164.all;

entity mux2 is
  port (
    selIn : in    std_logic;
    outA  : out   std_logic
  );
end entity mux2;

architecture rtl of mux2 is
begin

  outa <= selin;                 -- flagged & fixed by architecture_601

  with selin select outa <=      -- NOT flagged
    '0' when '1',
    '1' when '0',
    'X' when others;

end architecture rtl;
