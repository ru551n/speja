entity e is
  generic (
    w : natural := 8
  );
  port (
    a : in bit;
    b :  out bit;
    c : inout bit);
end entity  e;

architecture rtl  of e is

  signal s:  bit;

begin

  u1 : entity work.f
    generic map (
      w => w,
      x => 1)
    port map (
      a => a,
      b => s
    );

  b <= (a and s)
    or (a and c)
    or (s and c)
    or (a and s and c)
    or (a and not s and not c)
    or (not a and s and not c)
    or (c and s);

  proc    : process (a) is
  begin

    if(a = '1') then
      c <= end_end;
    end if;

  end process proc;

end architecture rtl;
