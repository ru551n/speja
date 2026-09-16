-- vsg-rs-test: width=60
architecture rtl of calls is
  constant init : record_type := (
    field_one   => 1,
    field_two   => x"FF",
    field_three => (others => '0'),
    field_four  => true
  );
  constant table : int_array := (
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20
  );
  constant nested : matrix_t := (
    (1, 2, 3),
    (4, 5, 6),
    (7, 8, 9),
    (10, 11, 12),
    (13, 14, 15)
  );
  constant c : natural := compute_something(
    first_parameter,
    second_parameter => 2,
    third_parameter  => open_value
  );
  signal s : std_logic_vector(7 downto 0)
    := std_logic_vector(to_unsigned(initial_value, 8));
begin
  process
  begin
    write_register(
      address => control_register_address,
      data    => enable_bit or reset_bit,
      mask    => (others => '1')
    );
    check_equal(
      outer_function(
        inner_function(
          deeply_nested_function(argument_one, argument_two)
        )
      ),
      expected,
      "msg"
    );
    q <= t_rec'(
      a      => '1',
      b      => '0',
      c      =>
        resize(unsigned(input_vector), output_width),
      others => '-'
    );
    wait;
  end process;
end architecture;
