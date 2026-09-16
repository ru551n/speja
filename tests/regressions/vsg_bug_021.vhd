library ieee;
use ieee.std_logic_1164.all;

package rec_pkg is
  type cmd_in_t is record
    valid : std_logic;
  end record cmd_in_t;

  type cmd_out_t is record
    ready : std_logic;
  end record cmd_out_t;
end package rec_pkg;

library ieee;
use ieee.std_logic_1164.all;
library work;
use work.rec_pkg.all;

entity unit is
  port (
    d : in  cmd_in_t;
    q : out cmd_out_t
  );
end entity unit;

architecture rtl of unit is
  type fsm_t is (idle_st, valid, done_st);
  signal fsm : fsm_t;
begin
end architecture rtl;
