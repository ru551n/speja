package p is
  type counter_t is protected
    procedure increment (amount : natural := 1);
    impure function value return natural;
  end protected counter_t;
  package generic_pkg_inst is new work.generic_pkg
    generic map (
      data_width => 8,
      depth      => 16
    );
end package;
package body p is
  type counter_t is protected body
    variable count : natural := 0;
    procedure increment (amount : natural := 1) is
    begin
      count := count + amount;
    end procedure;
    impure function value return natural is
    begin
      return count;
    end function;
  end protected body counter_t;
end package body;
