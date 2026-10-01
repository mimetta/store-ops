# Sales export samples

`tests/adapos.test.ts` runs against the **real** AdaPOS exports, not fixtures.
A fixture written from my own reading of the format would encode the very
understanding under test — and did: three details only showed up in the real
files (line-level discounts, returns with a positive discount against a
negative total, and a bill settled by two payments).

The files are **not committed**. They are live bill-level sales data, and this
repository is not where that belongs. `docs/samples/` is gitignored.

To run the tests, put these two here:

| Name | Branch | Expect |
|---|---|---|
| `talatnoi.xlsx` | 00003 Talat Noi | 114 bills, 166 product lines, 114 payments |
| `songwat.xlsx`  | 00002 Song Wat  | 1120 bills, 1660 product lines, 1121 payments |

Both are the AdaPOS report `รายงาน - ยอดขายตามบิล` (sales by bill) for
September 2026. Without them the test prints `SKIPPED` and passes, so a clean
checkout is not blocked — but the parser is then genuinely untested.
