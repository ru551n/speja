package p is
function f (
i_a : bit_vector(7 downto 0); -- first
i_bbb : bit_vector(7 downto 0) -- last
) return bit;
procedure q (signal a : in bit_vector(f(1) downto 0) -- only
);
constant c : t_rec := (
a => (others => '0'), -- first
bbb => f(1, 2) -- last
);
constant d : t_list := (1, 2, 3 -- last
);
end package p;

architecture rtl of e is
begin
x <= f(a, g(b) -- last
);
y <= f(a, g(h(b) -- inner
) -- outer
);
end architecture rtl;
