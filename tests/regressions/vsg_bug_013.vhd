architecture a of e is
begin
gen_rows : for row_idx in 0 to 7 generate
  u_row : entity work.row_slice
    port map (
      clk_i  => clk_i,
      data_i => input_data(row_idx),
      data_o => output_data(row_idx)
    );
end generate gen_rows;

end architecture a;
