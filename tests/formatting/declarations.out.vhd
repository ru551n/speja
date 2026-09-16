-- vsg-rs-test: width=60
package decls is
  type state_t is (
    idle,
    waiting_for_request,
    processing_request,
    sending_response,
    error_recovery
  );
  type word_array_t is array (natural range <>)
    of std_logic_vector(31 downto 0);
  type matrix_t is array (0 to 3, 0 to 3)
    of integer range -128 to 127;
  type packet_t is record
    header          : std_logic_vector(15 downto 0);
    long_field_name : unsigned(7 downto 0);
    payload         : word_array_t(
      0 to max_payload_words - 1
    ); -- payload
  end record packet_t;
  type distance is range 0 to 1e9
    units
      nm;
      um = 1000 nm;
      mm = 1000 um;
    end units distance;
  subtype small_int_t is integer range minimum_allowed_value
      to maximum_allowed_value_for_this_type;
  constant first_constant, second_constant : natural := 42;
  signal status_register_value_with_long_name :
    std_logic_vector(register_width - 1 downto 0) :=
    (others => '0');
  alias control_bits : std_logic_vector(3 downto 0)
    is control_register_value_with_long_name(3 downto 0);
  attribute keep_hierarchy of the_instance_label_name : label
    is "yes_please_keep_this_hierarchy";
  file log_file : text
    open write_mode is "simulation_output_log_file_with_a_long_name.txt";
  function parity (
    data : std_logic_vector
  ) return std_logic;
  impure function read_file (
    file_name     : string;
    line_count    : natural;
    default_value : integer := 0
  ) return integer_vector;
  procedure send (
    signal clk      : in    std_logic;
    constant data   : in    byte_array;
    variable status : out   status_t
  );
  component comp is
  end component comp;
end package decls;

package body decls is
  function parity (
    data : std_logic_vector
  ) return std_logic is
    variable result : std_logic := '0';
  begin
    for i in data'range loop
      result := result xor data(i);
    end loop;
    return result;
  end function parity;
end package body;
