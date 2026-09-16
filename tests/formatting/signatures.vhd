-- vsg-rs-test: width=60
package signatures is
  alias to_slv is work.conversion_pkg.to_std_logic_vector [unsigned return std_logic_vector];
  alias my_function_alias is work.some_package.some_long_function_name [std_logic_vector, integer, natural, boolean return std_logic_vector];
  alias short is f [integer return bit];
  attribute cost of add [integer, integer return integer] : function is 3;
end package;
