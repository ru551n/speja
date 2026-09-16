-- vsg-rs-test: width=80
architecture rtl of top is

  component fifo is
    generic (
      width : positive := 8
    );
    port (
      clk  : in    std_logic;
      data : out   std_logic_vector(width - 1 downto 0)
    );
  end component;

begin

  fifo_inst : entity work.fifo(rtl)
    generic map (
      width => data_width,
      depth => 2 ** address_width
    )
    port map (
      clk     => clk,
      rst     => rst,
      wr_en   => wr_en and not full,
      wr_data => wr_data(data_width - 1 downto 0),
      rd_data => open,
      count   => open
    );

  comp_inst : fifo
    generic map (
      8
    )
    port map (
      clk,
      data_out
    );

  positional_inst : component fifo
    port map (
      clk, -- the clock
      -- the data
      data_out
    );

  long_actual_inst : entity work.adder
    port map (
      a => some_function_with_a_long_name(
        first_argument,
        second_argument,
        third_argument
      ),
      b => b
    );

end architecture;
