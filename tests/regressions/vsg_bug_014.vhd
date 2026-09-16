entity has_block_comment is
  generic (
    g_width : natural := 8  /* Data path
                                width in bits
                             */
  );
  port (
    clk : in std_logic
  );
end entity has_block_comment;
