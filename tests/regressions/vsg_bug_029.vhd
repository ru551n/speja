architecture rtl of caller is
begin
	process (all)
		procedure helper (a : natural; b : boolean) is
		begin
		end procedure;
	begin
		helper(
			a => 5,
			b => true
		);
	end process;
end architecture;
