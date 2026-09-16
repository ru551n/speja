-- vsg-rs-test: width=40
use extremely_long_library_name.extremely_long_package_name.all;

architecture rtl of unbreakable is

begin

  assert false
    report "this string literal is far longer than forty columns and must never be split";
  the_extremely_long_signal_name_that_cannot_fit <=
    another_extremely_long_signal_name_here;
  x <=
    \extended identifier that is very long and cannot be broken\;

end architecture;
