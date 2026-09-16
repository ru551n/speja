package p is
type dma_desc_t is record
  addr  : unsigned(31 downto 0);
  len   : unsigned(15 downto 0);
  valid : std_logic;
  -- valid is asserted for exactly one cycle per descriptor
end record dma_desc_t;

end package p;
