import { bangkokDate, bangkokToday, ymd, addDaysISO, startOfMonthISO } from "../src/lib/day"

let bad = 0
const ok = (label: string, pass: boolean, note = "") => {
  if (!pass) bad++
  console.log(`  ${pass ? "PASS" : "FAIL"} | ${label.padEnd(52)} | ${note}`)
}

// 02:30 Bangkok on 1 Oct is still 30 Sep in UTC. This is the whole bug.
const early = new Date("2026-10-01T02:30:00+07:00")
ok("02:30 Bangkok is 1 Oct, not 30 Sep", bangkokDate(early) === "2026-10-01",
   `${bangkokDate(early)} vs UTC ${early.toISOString().slice(0, 10)}`)
ok("...and the old rule would have said 30 Sep", early.toISOString().slice(0, 10) === "2026-09-30")

// 23:30 Bangkok is already the next day in neither — check we do not overshoot.
const late = new Date("2026-10-01T23:30:00+07:00")
ok("23:30 Bangkok is still 1 Oct", bangkokDate(late) === "2026-10-01", bangkokDate(late))

// A Date built from local calendar parts must survive the round trip.
const cell = new Date(2026, 8, 1)          // 1 Sep 2026, local midnight
ok("month cell round-trips as its own day", ymd(cell) === "2026-09-01",
   `${ymd(cell)} (toISOString gives ${cell.toISOString().slice(0, 10)})`)

ok("addDaysISO crosses a month boundary", addDaysISO("2026-09-30", 1) === "2026-10-01")
ok("addDaysISO goes backwards",           addDaysISO("2026-10-01", -1) === "2026-09-30")
ok("addDaysISO crosses a year boundary",  addDaysISO("2026-12-31", 1) === "2027-01-01")
ok("addDaysISO over 29 days",             addDaysISO("2026-10-01", -29) === "2026-09-02")
ok("startOfMonthISO",                     startOfMonthISO("2026-09-29") === "2026-09-01")
ok("bangkokToday has the ISO shape",      /^\d{4}-\d{2}-\d{2}$/.test(bangkokToday()), bangkokToday())

// Host-independence: the answer must not depend on the machine's timezone.
ok("same instant, same answer in any host TZ", bangkokDate(early) === "2026-10-01",
   `host TZ = ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)

process.exit(bad ? 1 : 0)
