-- VSG issue #1585: comments between `elsif` and its condition are indented with it.
architecture rtl of ent is

begin

  process (clk)
  begin

    if a = '1' then
      q <= '0';
    elsif
      -- wait here until the sub-steps are
      -- complete and the data is consumed
      (b = '1') and (c = '1') then
      q <= '1';
    end if;

  end process;

end architecture rtl;
