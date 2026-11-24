import { createClient } from "@/lib/supabase/server"
import { can, canAny } from "@/lib/permissions"
import { currentProfile } from "@/lib/records"

/**
 * Kindness Assistant — the KA list, with branch and pay rate.
 *
 * ── PAY RATE IS ASKED FOR, NOT ASSUMED ────────────────────────────────────
 *
 * `payout.view` is admin, manager and people.
 *
 * `pay_rates` is the most sensitive table in the system: readable by
 * admin, manager and people only — never a supervisor, never a KA, and
 * **not even by the person it is about**. There is no self-read exemption
 * on pay and that was overruled deliberately once already.
 *
 * So this screen ASKS for the rate and the database decides whether it
 * arrives. The column is hidden when `pay.view` is absent, and RLS refuses
 * the rows regardless — the hidden column is the courtesy, the policy is
 * the rule. A screen that filtered in JavaScript would be one `console.log`
 * away from leaking.
 *
 * Position is not here yet: the list of positions is coming separately.
 */
export default async function KindnessAssistantPage() {
  const profile = await currentProfile()
  if (!canAny(profile, ["people.manage", "shifts.manage"])) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to the KA list.</p>
        <p className="empty-hint">It is for the people who manage the team and the roster.</p>
      </div>
    )
  }
  // `payout.view` — admin, manager, people. The same capability that opens
  // Commission, because both answer "money about a person". There is no
  // separate pay.view; inventing one here would have been a capability
  // nothing grants and a column nobody ever sees.
  const maySeePay = can(profile, "payout.view")

  const supabase = createClient()
  const { data: people } = await supabase
    .from("profiles")
    .select("id, full_name, nickname, email, branch_id, employment_type, branches(name)")
    .eq("portal_role", "ka")
    .order("full_name")

  // Asked for only when it may be seen. RLS would refuse it anyway; not
  // asking keeps the request honest about what the screen is for.
  const rates = maySeePay
    ? (await supabase.from("pay_rates")
        .select("staff_id, monthly_salary, effective_from")
        .order("effective_from", { ascending: false })).data ?? []
    : []
  const rateFor = new Map<string, number>()
  for (const r of rates as { staff_id: string; monthly_salary: number }[]) {
    if (!rateFor.has(r.staff_id)) rateFor.set(r.staff_id, r.monthly_salary)
  }

  type Row = {
    id: string; full_name: string | null; nickname: string | null; email: string | null
    branch_id: string | null; employment_type: string | null
    branches: { name: string } | null
  }
  const rows = (people ?? []) as unknown as Row[]

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <h1 className="text-[22px] font-medium mb-1">Kindness Assistant</h1>
      <p className="text-[12px] text-muted mb-4">
        {rows.length} KA{rows.length === 1 ? "" : "s"}.
        {" "}People are added and removed in Setting → Team.
      </p>

      <div className="card card-pad">
        {rows.length === 0 ? (
          <p className="text-center py-6 text-muted text-[13px]">No KAs yet.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-subtle text-[11px]">
                <th className="py-1.5">Name</th>
                <th className="py-1.5">Branch</th>
                <th className="py-1.5">Employment</th>
                {maySeePay && <th className="py-1.5 text-right">Pay rate</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-sand">
                  <td className="py-2">
                    {p.nickname || p.full_name || p.email || "—"}
                    {p.nickname && p.full_name && (
                      <span className="text-[11px] text-subtle ml-2">{p.full_name}</span>
                    )}
                  </td>
                  {/* A branchless KA is shown as such, not as a blank. Until
                      branch_id is set they see only themselves in profiles —
                      go-live D26. */}
                  <td className={p.branch_id ? "py-2 text-muted" : "py-2 text-danger-70"}>
                    {p.branches?.name ?? "no branch set"}
                  </td>
                  <td className={p.employment_type ? "py-2 text-muted" : "py-2 text-danger-70"}>
                    {p.employment_type ?? "not set"}
                  </td>
                  {maySeePay && (
                    <td className="py-2 text-right num-c">
                      {rateFor.has(p.id)
                        ? rateFor.get(p.id)!.toLocaleString("en-GB", { minimumFractionDigits: 2 })
                        : <span className="text-subtle">no rate</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
