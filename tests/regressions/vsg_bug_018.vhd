library ieee;
  use ieee.std_logic_1164.all;

entity leaf is
  port (
    a : in    std_logic;
    b : in    std_logic
  );
end entity leaf;

architecture behavioral of leaf is

  component leaf_comp is
    port (
      a : in    std_logic;
      b : in    std_logic
    );
  end component;

begin

  P_leaf : component leaf_comp
    port map (
      a => a,
      b => b
    );

  leaf_S : component leaf_comp
    port map (
      a => a,
      b => b
    );

end architecture behavioral;
