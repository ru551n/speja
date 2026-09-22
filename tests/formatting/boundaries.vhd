-- speja-test: width=30
architecture a of b is
begin
  x <= f(a, bb, cc, dd, e);
  x <= f(a, bb, cc, dd, ee);
  x <= f(a, bb, cc, dd, eee);
  xx <= aaaa + bbbb + ccc;
  xx <= aaaa + bbbb + cccc;
  xx <= aaaa + bbbb + ccccc;
  y <= z; -- a trailing comment that goes way past thirty columns
end architecture;
