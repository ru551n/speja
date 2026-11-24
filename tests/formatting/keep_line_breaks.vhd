package p is
function f_one (a : bit; b : bit) return bit;
function f_two (a : bit;
                bbb : bit) return bit;
function f_three (
    a : bit
) return bit;
procedure p_one (signal a : in bit; signal b : out bit);
procedure p_two (
signal a : in bit;
signal b : out bit);
type t_one is (idle, run, done);
type t_two is (idle,
run, done);
end package p;

package body p is
procedure p_two (signal a : in bit;
signal b : out bit) is
procedure nested (c : bit; d : bit) is
begin
end procedure nested;
begin
v := a = '1' and b = '1'
and (c = '1' or d = '1');
v := a = '1' and b = '1' and (c = '1'
or d = '1');
v := a and b and c;
v := a +
b;
v := a &
b & c;
v := a & b & c;
if rising_edge(clk) and
enable = '1' then
q(a
and b, c);
end if;
end procedure p_two;
end package body p;
