architecture rtl of fmt_off is
begin
  a <= b   and   c;
  -- speja: fmt off
  table_driven : process (all) begin
    case  sel  is   -- hand aligned
      when "00"  => y <= a;
      when others=> y <= b;
    end case;
  end process;
  x<=y;
  -- speja: fmt on
  d <= e   or   f;
end architecture rtl;

package p is
  -- vsg_off
  constant   TABLE : integer_vector := (1,  2,
                                        3,  4);
  -- vsg_on
  constant   other : integer := 1;
end package p;
