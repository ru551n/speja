library ieee;
use ieee.std_logic_1164.all;

entity nested is
  port (
    z : out std_logic
  );
end nested;

architecture rtl of nested is
begin
  z <= (m) + n(p(q)(r));
end architecture;
