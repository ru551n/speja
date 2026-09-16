library ieee;
use ieee.std_logic_1164.all;

entity alpha is
  port (
    Ready : out std_logic
  );
end entity alpha;

architecture rtl of alpha is
begin
  Ready <= '1';
end architecture rtl;

entity beta is
  port (
    dummy : out std_logic
  );
end entity beta;

architecture rtl of beta is
  signal ready : std_logic;   -- unrelated to alpha.Ready, but same spelling
begin
  dummy <= ready;
end architecture rtl;
