"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"

interface Saved {
  id: string; branch_id: string; entry_date: string
  new_members: number; reviews: number; recorded_at: string
}

/**
 * Key it in, see what was saved, edit it — the shape every daily key-in
 * screen takes now.
 *
 * The list below the form is the "see what was saved" half, and it is the
 * half /daily's money card was missing: a day with a figure recorded
 * looked exactly like a day nobody had touched, and correcting it by
 * typing into the blank form changed nothing.
 */
export default function MembershipClient({ today, branches, saved }: {
  today: string
  branches: { id: string; name: string }[]
  saved: Saved[]
}) {
  const supabase = createClient()
  const router = useRouter()
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "")
  const [date, setDate] = useState(today)
  const [members, setMembers] = useState("")
  const [reviews, setReviews] = useState("")
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const existing = saved.find((s) => s.branch_id === branchId && s.entry_date === date)

  async function save() {
    setBusy(true); setMsg(null)
    // Blank is NOT zero. Zero means nobody joined; blank means this person
    // has not answered, and saving a blank as 0 is inventing an answer.
    if (members.trim() === "" || reviews.trim() === "") {
      setMsg({ tone: "err", text: "Both counts are needed. Enter 0 if there were none — a blank is not a zero." })
      setBusy(false); return
    }
    const payload = {
      branch_id: branchId, entry_date: date,
      new_members: parseInt(members, 10), reviews: parseInt(reviews, 10),
    }
    const { error } = await supabase
      .from("membership_counts")
      .upsert(payload, { onConflict: "branch_id,entry_date" })
    setBusy(false)
    if (error) { setMsg({ tone: "err", text: error.message }); return }
    setMsg({ tone: "ok", text: `Saved for ${date}.` })
    // NOT cleared. Clearing after a save is what made a recorded day look
    // untouched on /daily.
    router.refresh()
  }

  function edit(s: Saved) {
    setBranchId(s.branch_id); setDate(s.entry_date)
    setMembers(String(s.new_members)); setReviews(String(s.reviews))
    setMsg(null)
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Membership &amp; review</h1>

      <div className="card card-pad flex flex-col gap-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <label>
            <span className="text-xs text-muted">Branch</span>
            <select className="input w-full" value={branchId}
                    onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label>
            <span className="text-xs text-muted">Day</span>
            <input type="date" max={today} className="input w-full" value={date}
                   onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            <span className="text-xs text-muted">New members</span>
            <input type="number" min="0" inputMode="numeric" className="input w-full"
                   value={members} onChange={(e) => setMembers(e.target.value)}
                   placeholder={existing ? String(existing.new_members) : "0"} />
          </label>
          <label>
            <span className="text-xs text-muted">Xiaohongshu reviews</span>
            <input type="number" min="0" inputMode="numeric" className="input w-full"
                   value={reviews} onChange={(e) => setReviews(e.target.value)}
                   placeholder={existing ? String(existing.reviews) : "0"} />
          </label>
        </div>

        {existing && (
          <p className="text-[12px] text-muted">
            Already saved for this day: {existing.new_members} new member(s),
            {" "}{existing.reviews} review(s). Saving again replaces it.
          </p>
        )}
        {msg && (
          <p className={msg.tone === "ok" ? "note note-g" : "note note-r"}><span>{msg.text}</span></p>
        )}

        <button onClick={save} disabled={busy} className="btn btn-primary self-start min-h-[44px]">
          {busy ? "Saving…" : existing ? "Update" : "Save"}
        </button>
      </div>

      <div className="card card-pad mt-3">
        <h2 className="text-[15px] font-medium mb-1">What was saved</h2>
        {saved.length === 0 ? (
          <p className="text-center py-6 text-muted text-[13px]">
            Nothing recorded yet. A day with no row has not been asked about —
            which is different from a day with none.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-subtle text-[11px]">
                <th className="py-1.5">Day</th><th className="py-1.5">Branch</th>
                <th className="py-1.5 text-right">New members</th>
                <th className="py-1.5 text-right">Reviews</th>
                <th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.id} className="border-t border-sand">
                  <td className="py-2">{s.entry_date}</td>
                  <td className="py-2 text-muted">
                    {branches.find((b) => b.id === s.branch_id)?.name ?? "—"}
                  </td>
                  <td className="py-2 text-right num-c">{s.new_members}</td>
                  <td className="py-2 text-right num-c">{s.reviews}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => edit(s)}
                            className="text-[12px] text-brown underline min-h-[44px] px-2">
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
