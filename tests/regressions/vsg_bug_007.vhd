architecture rtl of pragma_demo is
begin
  process (all) is
  begin
    if sel = '1' then
-- synthesis translate_off
      report "sim only" severity note;
    end if;
-- synthesis translate_on
  end process;
end architecture rtl;
