-- VSG issue #1586: `align_when_keywords` and `align_else_keywords` of concurrent_009 and sequential_401.
architecture rtl of ent is

begin

  tcp_data_err <= buftx_data_err when data_out_sel = "11" else
                  word3_error    when data_out_sel = "10" else
                  '0';
  y            <= a                      when c = "1111111111111111111111111111" and d = '1' else
                  bbbbbbbbbbbbbbbbbbbbbb when c = "10"                                       else
                  '0';
  x            <= a when c else
                  b;

  process
  begin

    z <= a  when c else
         bb when dd = "101" else
         '0';
    v := a when c else
         bb when dd = "101" else
         '0';

  end process;

end architecture rtl;
