architecture rtl of e is

begin

  o_a         <= i_a;
  o_long_name <= i_b;

  gen_x : if c_x generate
    -- first comment
    o_d           <= i_d;
    o_longer_name <= i_e;

    o_x  <= i_x; -- one
    o_xx <= i_xx when c else
            i_x; -- two
  -- last comment
  elsif c_y generate
    -- vsg_off
    o_d       <= i_d;
    o_longer_name <= i_e;
  -- vsg_on
  else generate
    o_d <= i_d;

    u_e : entity work.e;

    o_longer_name <= i_e;
    o_other       <= i_f;
  end generate gen_x;

  gen_f : for i in 0 to 3 generate
    -- the declaration
    signal s : bit;
  begin
    -- the statement
    s              <= i_s(i);
    o_long_name(i) <= s;

    gen_n : case c generate
      when 0 =>
        -- in the alternative
        a         <= b;
        long_name <= c;
        -- closes the alternative
      end;
      when others =>
        a         <= b;
        long_name <= c;
        -- closes the statement
    end generate gen_n;

  end generate gen_f;

  gen_b : if c generate
  -- before begin
  begin
    a         <= b;
    long_name <= c;
  end generate gen_b;

end architecture rtl;
