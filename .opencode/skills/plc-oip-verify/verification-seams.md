# Verification Seams & `strucpp --test` Reference

Disclosed reference for [`plc-oip-verify`](SKILL.md). Consult for `STruC++` test syntax constraints and post-merge gate behavior.

## `strucpp --test` Syntax Constraints

- **Single-quoted test titles**: Write `TEST 'Start latches conveyor cleanly'` with single quotes (IEC `STRING`). Double-quoted titles parse as `WSTRING` and fail compilation.
- **Top-level `ADVANCE_TIME` only**: Place `ADVANCE_TIME(<nanoseconds>);` directly inside `TEST ... END_TEST` (e.g. `ADVANCE_TIME(2000000000);` for 2 s, `ADVANCE_TIME(500000000);` for 500 ms). Placing `ADVANCE_TIME` inside `FOR` or `IF` blocks is rejected by `STruC++`.
- **Fresh state per test**: Declare and reset the `FUNCTION_BLOCK` instance inside `SETUP ... END_SETUP` so every `TEST` starts cleanly.
- **Supported assertions**: `ASSERT_TRUE(expr);`, `ASSERT_FALSE(expr);`, `ASSERT_EQ(actual, expected);`, `ASSERT_NEQ(actual, expected);`.

## Post-Merge Verification Gate

After all three worker worktrees merge, `npm run cell:verify -- <slug>` executes (1) `I/O Contract` conformance, (2) `STruC++` PLC unit tests (`scenes/<slug>/plc/program.st` against `scenes/<slug>/tests/program.test.st`), and (3) OIP `validate-project --strict`, `check-st`, `check-wiring --strict`, and error-only `check-layout`.
