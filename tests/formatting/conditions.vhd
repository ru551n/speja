-- speja-test: width=60
architecture rtl of conditions is
begin
  process (clk) begin
    if rising_edge(clk) then
      if request_valid = '1' and request_ready = '1' and (request_id = expected_id or bypass = '1') then
        null;
      elsif timeout_counter = 0 and retry_count < max_retries and not error_flag then
        null;
      else
        null;
      end if;
      while index < length_of_the_buffer and buffer_data(index) /= terminator loop
        index := index + 1;
      end loop;
      exit when done_flag = '1' or error_flag = '1' or abort_request = '1' or timeout = '1';
      next outer when skip_this_element(index) or element_is_invalid(index, buffer_data);
      return result_value_from_computation + correction_term_from_lookup_table(index);
    end if;
  end process;
end architecture;
