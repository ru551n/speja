entity e is
  port (
    clk       : in    std_logic;
    a         : in    std_logic_vector(7 downto 0) := (others => '0');
    long_name : out   std_logic                    := '0';
    b         : inout std_logic                    := '0'
  );
end entity e;
