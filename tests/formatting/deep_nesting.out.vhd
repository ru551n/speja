-- vsg-rs-test: width=60
architecture rtl of deep is

begin

  result <= level_one(
    level_two(
      level_three(
        level_four(
          level_five(argument_alpha, argument_beta),
          argument_gamma
        ),
        argument_delta
      ),
      argument_epsilon
    ),
    argument_zeta
  );
  flag <= ((a and b)
           or (c
               and (d
                    or (e
                        and (f
                            or (g and (h or (i and j))))))))
          xor ((k or l) and (m or n));

end architecture;
