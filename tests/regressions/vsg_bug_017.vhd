architecture a of e is
begin
u_sync : entity work.sync
  port map (
    clkP => sysClkP
  );

end architecture a;
