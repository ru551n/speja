-- speja-test: width=80
LIBRARY ieee; USE ieee.std_logic_1164.ALL; use ieee.numeric_std.all;
entity fifo is generic (width : positive := 8; depth : positive := 16; init_value : std_logic_vector(7 downto 0) := (others => '0'));
port (clk, rst : in std_logic; -- clock and reset
  -- write side
  wr_en : in std_logic; wr_data : in std_logic_vector(width - 1 downto 0);
  rd_data : out std_logic_vector(width - 1 downto 0); count : buffer natural range 0 to depth; bidir : inout std_logic);
end fifo;
