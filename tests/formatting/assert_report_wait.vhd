-- speja-test: width=70
architecture sim of tb is
begin
  process begin
    assert x = 1;
    assert data_out = expected_data report "Data mismatch at index " & integer'image(index) & " of " & integer'image(total) severity error;
    report "Simulation finished after " & integer'image(cycle_count) & " cycles" severity note;
    report "short";
    wait on clk, rst, enable_signal, data_valid_signal until rising_edge(clk) and enable = '1' for 10 ns;
    wait until rising_edge(clk);
    wait for clock_period * number_of_cycles_to_wait_for_the_reset_to_finish;
    wait;
  end process;
end architecture;
