-- VSG issue #1520: comments closing a body stay with it.
-- demo for pragma/comment alignment using default rules

library ieee;
  use ieee.std_logic_1164.all;
  use ieee.numeric_std.all;

entity pragma is
  port (
    clk   : in    std_logic;
    reset : in    std_logic
  );
end entity pragma;

architecture rtl of pragma is

  -- example from documentation:

  -- synthesis translate_off
  signal wr_en : std_logic;
  signal rd_en : std_logic;
-- synthesis translate_on

begin

  test_process : process (clk) is
  begin

    if rising_edge(clk) then

      case reset is

        when '0' =>

          -- synthesis translate_off
          null;
        -- synthesis translate_on

        when others =>

          -- synthesis translate_off
          null;
      -- synthesis translate_on

      end case;

      if (reset = '0') then
        null;
      -- pragma translate_on
      elsif (reset = 'U') then
        null;
      -- the comment describes the else branch
      else

        -- synthesis translate_off
        null;
      -- synthesis translate_on

      end if;
    end if;

    -- synthesis translate_off
    null;
  -- synthesis translate_on

  end process test_process;

end architecture rtl;
