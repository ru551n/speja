-- File header comment

-- second header comment after blank lines
library ieee; -- trailing on library

entity comments is
  port (
    a : in    bit; -- trailing on port
    -- standalone before port
    b : out   bit
    -- comment before closing paren
  );
end entity;

architecture rtl of comments is

begin

  -- before statement

  -- after blank line
  y <= a -- between operand and operator
       and b;
  z <= /* inline block */ a;

  process
  begin

    null;

    -- comment before end
  end process;

  -- final comment in architecture
end architecture;
-- trailing file comment
