architecture rtl of gen_demo is
begin

  g_stage : for i in 0 to 3 generate
  begin
    g_inner : if i = 0 generate
    begin
    end generate g_inner;
  end generate g_stage;

  g_next : if true generate
  begin
  end generate g_next;

end architecture rtl;
