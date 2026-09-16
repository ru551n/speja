context project_context is library ieee; use ieee.std_logic_1164.all, ieee.numeric_std.all; context work.other_context; end context;
configuration cfg of top is
  for rtl
    for u0 : comp use entity work.impl(rtl) generic map (width => 8) port map (clk => clk); end for;
    for gen_lanes
      for all : lane use configuration work.lane_cfg; end for;
    end for;
  end for;
end configuration cfg;
