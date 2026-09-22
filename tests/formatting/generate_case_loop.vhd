-- speja-test: width=70
architecture rtl of gen is
begin
  gen_lanes : for lane_index in 0 to number_of_lanes_in_the_design - 1 generate
    signal lane_data : std_logic_vector(7 downto 0);
  begin
    lane_data <= input_data(lane_index);
  end generate gen_lanes;
  gen_opt : if enable_optional_feature_one and enable_optional_feature_two generate
    feature <= '1';
  elsif alt: enable_alternative_feature generate
    feature <= '0';
  else generate
    feature <= 'Z';
  end generate;
  gen_case : case implementation_variant generate
    when fast_implementation | small_implementation | balanced_implementation =>
      impl <= 1;
    when others =>
      impl <= 0;
  end generate;
  blk : block (enable = '1') is
  begin
    q <= guarded d;
  end block blk;
  process (clk, rst, enable, data_in_valid, data_in_ready, data_out_valid, data_out_ready) is
  begin
    case current_state_of_the_machine is
      when idle_state | waiting_state | another_waiting_state | yet_another_state =>
        next_state <= busy;
      when others => null;
    end case;
    for element_index in input_array'low to input_array'high - number_of_skipped_elements loop
      null;
    end loop;
  end process;
end architecture;
