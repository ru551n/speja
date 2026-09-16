entity Keyword_Case is
  port (
    Clk : in    STD_LOGIC
  );
end entity Keyword_Case;
architecture RTL of Keyword_Case is
begin
  Q <= D when Enable = '1' else
       'Z';
end architecture RTL;
