-- vsg-rs-test: width=60
architecture rtl of assignments is

begin

  short <= a;
  sum <= operand_one
         + operand_two
         + operand_three
         + operand_four
         + operand_five;
  valid <= input_valid
           and output_ready
           and not fifo_full
           and not fifo_almost_full;
  mixed <= (a and b)
           or (c and d)
           or (enable_signal_one and enable_signal_two);
  delayed <= transport value after 10 ns,
                       other_value after 20 ns,
                       final_value after 30 ns;
  concat <= header_field
            & payload_field
            & checksum_field
            & trailer_field
            & padding;
  compare <= '1'
               when unsigned(counter_value)
                    >= unsigned(threshold_value) else
             '0';
  result <= value_a when condition_a else
            value_b
              when condition_b and other_condition else
            default_value;
  with state select next_state <=
    idle when reset_state | error_state,
    running when start_state,
    done when others;

  process (all) is

    variable v : integer;

  begin

    v := first_variable_term * second_variable_term
         - third_variable_term / fourth_term;
    v := 2 ** (bit_width - 1)
         + abs (negative_value)
         + (-offset_value) mod modulus_value;

  end process;

end architecture;
