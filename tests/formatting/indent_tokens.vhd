library ieee;
use ieee.std_logic_1164.all;
entity e is
port (a : in bit);
end;
architecture r of e is
signal s : bit;
begin
process (a) is
begin
case a is
when others =>
s <= a;
end case;
end process;
end;
