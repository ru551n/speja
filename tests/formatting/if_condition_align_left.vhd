-- speja-test: width=60
-- VSG issue #1218: `if_009` with `align_left: yes` and `align_paren: no` indents continuation lines.
architecture rtl of e is
begin
	process (clk)
	begin
		if over_current_lo_fast = '1' then
			oc_lock <= '1';
		elsif over_current_hi_fast = '0' and lo_mpw_end = '1' and state_locked = '0' and
			(pwm = '1' or force_hi_pulse = '1') then
			oc_lock <= over_current_hi_fast and lo_mpw_end and state_locked and pwm;
		end if;
	end process;
end architecture rtl;
