entity mixer is
  generic (
    g_a : boolean := true;   -- gain enable
    g_b : boolean := true);  -- offset enable
  port (
    clk : in std_logic;      -- clock, wrongly aligned with generic comments
    rst : in std_logic       -- reset
  );
end entity mixer;
