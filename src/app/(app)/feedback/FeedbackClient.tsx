"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { recordFeedback } from "./actions"

export interface Vocab { code: string; label: string }
export interface Touchpoint extends Vocab { kind: "offline" | "online"; branch_id: string | null }
export interface StaffOption { id: string; name: string }

export interface FeedbackRow {
  id: string
  happened_on: string
  touchpoint_code: string
  staff_id: string
  statement: string
  sentiment_code: string
  outcome_code: string | null
  barrier_code: string | null
  product_category_code: string | null
  customer_type_code: string | null
  nationality: string | null
  reason_code: string | null
  recorded_by: string
  categoryCodes: string[]
}

interface VocabSet {
  sentiments: Vocab[]; outcomes: Vocab[]; barriers: Vocab[]; categories: Vocab[]
  reasons: Vocab[]; products: Vocab[]; customerTypes: Vocab[]; nationalities: Vocab[]
}

/** Outcomes that make "why not" a required field — mirrors 067's CHECK. */
const NEEDS_A_REASON = ["did_not_purchase", "considering"]

const label = (v: Vocab[], code: string | null) =>
  code ? (v.find((x) => x.code === code)?.label ?? code) : "—"

export default function FeedbackClient({
  tab, today, me, canManage, touchpoints, staff, entries, vocab,
}: {
  tab: "record" | "dashboard"
  today: string
  me: { id: string; touchpointCode: string }
  canManage: boolean
  touchpoints: Touchpoint[]
  staff: StaffOption[]
  entries: FeedbackRow[]
  vocab: VocabSet
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg text-ink flex-1 min-w-0">Customer feedback</h1>
        <div className="flex items-center gap-1">
          {([["record", "Record"], ["dashboard", "Dashboard"]] as const).map(([k, l]) => (
            <Link key={k} href={k === "record" ? "/feedback" : "/feedback?tab=dashboard"}
                  className={`px-2.5 py-1 rounded-card text-sm transition-colors ${
                    tab === k ? "bg-panel text-ink font-semibold border border-sand"
                              : "text-muted hover:text-ink"}`}>
              {l}
            </Link>
          ))}
        </div>
      </header>

      {tab === "record"
        ? <RecordTab today={today} me={me} touchpoints={touchpoints} staff={staff}
                     entries={entries} vocab={vocab} canManage={canManage} />
        : <DashboardTab entries={entries} touchpoints={touchpoints} vocab={vocab} />}
    </div>
  )
}

// ── record ─────────────────────────────────────────────────────────────────

function RecordTab({
  today, me, touchpoints, staff, entries, vocab, canManage,
}: {
  today: string
  me: { id: string; touchpointCode: string }
  touchpoints: Touchpoint[]
  staff: StaffOption[]
  entries: FeedbackRow[]
  vocab: VocabSet
  canManage: boolean
}) {
  const [date, setDate] = useState(today)
  const [touchpoint, setTouchpoint] = useState(me.touchpointCode)
  const [staffId, setStaffId] = useState(me.id)
  const [product, setProduct] = useState("")
  const [sentiment, setSentiment] = useState("")
  const [statement, setStatement] = useState("")

  const [detailOpen, setDetailOpen] = useState(false)
  const [customerType, setCustomerType] = useState("")
  const [nationality, setNationality] = useState("")
  const [reason, setReason] = useState("")
  const [categories, setCategories] = useState<string[]>([])
  const [outcome, setOutcome] = useState("")
  const [barrier, setBarrier] = useState("")

  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [pending, start] = useTransition()

  // 067 requires a barrier when the outcome says they did not buy. Opening
  // the detail section automatically is kinder than refusing a save for a
  // field the person cannot see.
  const barrierRequired = NEEDS_A_REASON.includes(outcome)

  const offline = touchpoints.filter((t) => t.kind === "offline")
  const online = touchpoints.filter((t) => t.kind === "online")

  function submit() {
    setMsg(null)
    if (!touchpoint) return setMsg({ tone: "err", text: "Where did this happen?" })
    if (!sentiment) return setMsg({ tone: "err", text: "How did they seem?" })
    if (!statement.trim()) return setMsg({ tone: "err", text: "Write down what they actually said." })
    if (barrierRequired && !barrier) {
      setDetailOpen(true)
      return setMsg({ tone: "err", text: "Say why they didn't buy — that's the field this is for." })
    }

    start(async () => {
      const r = await recordFeedback({
        happenedOn: date, touchpointCode: touchpoint, staffId, statement,
        sentimentCode: sentiment, customerTypeCode: customerType, nationality,
        productCategoryCode: product, reasonCode: reason, outcomeCode: outcome,
        barrierCode: barrier, categoryCodes: categories,
      })
      if (!r.ok) return setMsg({ tone: "err", text: r.error ?? "Did not save." })
      setMsg({ tone: "ok", text: r.error ?? "Saved." })
      // Keep date, touchpoint and staff — the next conversation is usually the
      // same person, same shop, same day. Clear what is about the customer.
      setProduct(""); setSentiment(""); setStatement("")
      setCustomerType(""); setNationality(""); setReason("")
      setCategories([]); setOutcome(""); setBarrier(""); setDetailOpen(false)
    })
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <div className="card card-pad flex flex-col gap-3">
        {msg && (
          <p className={msg.tone === "ok" ? "note note-g" : "note note-r"}><span>{msg.text}</span></p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                   className="input-field" />
          </Field>
          <Field label="Where">
            <select value={touchpoint} onChange={(e) => setTouchpoint(e.target.value)}
                    className="input-field">
              <option value="">— choose —</option>
              <optgroup label="In person">
                {offline.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </optgroup>
              <optgroup label="Online">
                {online.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </optgroup>
            </select>
          </Field>
        </div>

        <Field label="Product they asked about">
          <select value={product} onChange={(e) => setProduct(e.target.value)} className="input-field">
            <option value="">— not known —</option>
            {vocab.products.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
          </select>
        </Field>

        <Field label="How did they seem?">
          <div className="flex gap-2">
            {vocab.sentiments.map((s) => (
              <button key={s.code} type="button" onClick={() => setSentiment(s.code)}
                      className={`flex-1 py-2 rounded-card text-sm border transition-colors ${
                        sentiment === s.code
                          ? s.code === "positive" ? "bg-good-50 border-sage text-good-70"
                            : s.code === "negative" ? "bg-danger-50 border-danger-60 text-danger-70"
                            : "bg-amber-50 border-amber-60 text-amber-70"
                          : "border-sand text-muted hover:bg-panel"}`}>
                {s.label}
              </button>
            ))}
          </div>
        </Field>

        {/* The only field nobody can reconstruct later, so it is the biggest
            thing on the screen and sits above everything optional. */}
        <Field label="What did the customer actually say?">
          <textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={4}
                    placeholder="Their words, not a summary"
                    className="input-field resize-y min-h-[88px]" />
        </Field>

        <button type="button" onClick={() => setDetailOpen((v) => !v)}
                className="text-sm text-muted hover:text-ink text-left">
          {detailOpen ? "− Hide detail" : "+ Add detail"}
          {!detailOpen && barrierRequired && (
            <span className="badge badge-warn ml-2">why they didn&apos;t buy</span>
          )}
        </button>

        {detailOpen && (
          <div className="flex flex-col gap-3 border-t border-sand pt-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Staff">
                <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="input-field">
                  {staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Customer">
                <select value={customerType} onChange={(e) => setCustomerType(e.target.value)} className="input-field">
                  <option value="">— not known —</option>
                  {vocab.customerTypes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Where from">
                <select value={nationality} onChange={(e) => setNationality(e.target.value)} className="input-field">
                  <option value="">— not asked —</option>
                  {vocab.nationalities.map((n) => <option key={n.code} value={n.code}>{n.label}</option>)}
                </select>
              </Field>
              <Field label="Why they came in">
                <select value={reason} onChange={(e) => setReason(e.target.value)} className="input-field">
                  <option value="">— not known —</option>
                  {vocab.reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </Field>
            </div>

            <Field label="What the feedback is about">
              <div className="flex flex-wrap gap-2">
                {vocab.categories.map((c) => {
                  const on = categories.includes(c.code)
                  return (
                    <button key={c.code} type="button"
                            onClick={() => setCategories((p) =>
                              on ? p.filter((x) => x !== c.code) : [...p, c.code])}
                            className={`px-2.5 py-1.5 rounded-card text-sm border transition-colors ${
                              on ? "bg-info-50 border-info-60 text-info-70"
                                 : "border-sand text-muted hover:bg-panel"}`}>
                      {c.label}
                    </button>
                  )
                })}
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Did they buy?">
                <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="input-field">
                  <option value="">— not known —</option>
                  {vocab.outcomes.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                </select>
              </Field>
              <Field label={barrierRequired ? "Why not? (required)" : "Why not?"}>
                <select value={barrier} onChange={(e) => setBarrier(e.target.value)}
                        className={`input-field ${barrierRequired && !barrier ? "border-amber-60" : ""}`}>
                  <option value="">— not known —</option>
                  {vocab.barriers.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
                </select>
              </Field>
            </div>
          </div>
        )}

        <button onClick={submit} disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : "Save"}
        </button>
      </div>

      <RecentList entries={entries} touchpoints={touchpoints} vocab={vocab}
                  staff={staff} canManage={canManage} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function RecentList({
  entries, touchpoints, vocab, staff,
}: {
  entries: FeedbackRow[]; touchpoints: Touchpoint[]; vocab: VocabSet
  staff: StaffOption[]; canManage: boolean
}) {
  const tone = (s: string) =>
    s === "positive" ? "badge badge-good" : s === "negative" ? "badge badge-danger" : "badge badge-warn"

  return (
    <div className="card">
      <div className="card-pad border-b border-sand">
        <h2 className="text-ink">Recent</h2>
        <p className="text-xs text-muted">{entries.length} entr{entries.length === 1 ? "y" : "ies"}</p>
      </div>
      {entries.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing recorded yet.</p>
          <p className="empty-hint">
            One conversation, one entry. The dashboard fills in as these do.
          </p>
        </div>
      ) : (
        <div className="max-h-[32rem] overflow-auto">
          {entries.slice(0, 50).map((e) => (
            <div key={e.id} className="row flex-col items-start gap-1">
              <div className="flex items-center gap-2 w-full">
                <span className={tone(e.sentiment_code)}>
                  {label(vocab.sentiments, e.sentiment_code)}
                </span>
                <span className="text-xs text-muted">{label(touchpoints, e.touchpoint_code)}</span>
                <span className="text-xs text-subtle ml-auto num-c">{e.happened_on}</span>
              </div>
              <p className="text-sm text-ink">{e.statement}</p>
              <p className="text-xs text-subtle">
                {staff.find((s) => s.id === e.staff_id)?.name ?? "—"}
                {e.product_category_code && <> · {label(vocab.products, e.product_category_code)}</>}
                {e.outcome_code && <> · {label(vocab.outcomes, e.outcome_code)}</>}
                {e.barrier_code && <> · {label(vocab.barriers, e.barrier_code)}</>}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── dashboard ──────────────────────────────────────────────────────────────

function DashboardTab({
  entries, touchpoints, vocab,
}: {
  entries: FeedbackRow[]; touchpoints: Touchpoint[]; vocab: VocabSet
}) {
  const kindOf = useMemo(() => {
    const m = new Map(touchpoints.map((t) => [t.code, t.kind]))
    return (code: string) => m.get(code) ?? "offline"
  }, [touchpoints])

  const total = entries.length
  const offline = entries.filter((e) => kindOf(e.touchpoint_code) === "offline").length
  const positive = entries.filter((e) => e.sentiment_code === "positive").length
  const negative = entries.filter((e) => e.sentiment_code === "negative").length

  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0)

  const tally = (pick: (e: FeedbackRow) => string[]) => {
    const m = new Map<string, number>()
    for (const e of entries) for (const k of pick(e)) m.set(k, (m.get(k) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }

  const byCategory = tally((e) => e.categoryCodes)
  const byProduct = tally((e) => (e.product_category_code ? [e.product_category_code] : []))
  const painPoints = tally((e) => (e.sentiment_code === "negative" ? e.categoryCodes : []))
  const loves = tally((e) => (e.sentiment_code === "positive" ? e.categoryCodes : []))
  const barriers = tally((e) => (e.barrier_code ? [e.barrier_code] : []))

  if (total === 0) {
    return (
      <div className="card">
        <div className="empty">
          <p className="empty-title">No feedback recorded yet.</p>
          <p className="empty-hint">
            Every number here comes from the Record tab. Nothing is estimated, so
            an empty dashboard means nothing has been entered — not that nothing
            was said.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total" value={String(total)} />
        <Stat label="In person" value={`${offline}`} hint={`${pct(offline)}%`} />
        <Stat label="Positive" value={`${pct(positive)}%`} hint={`${positive} of ${total}`} />
        <Stat label="Negative" value={`${pct(negative)}%`} hint={`${negative} of ${total}`} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Bars title="What customers talk about" rows={byCategory} vocab={vocab.categories} total={total} />
        <Bars title="Most talked about products" rows={byProduct} vocab={vocab.products} total={total} />
        <Bars title="Top pain points" rows={painPoints} vocab={vocab.categories} total={negative}
              empty="Nothing negative recorded." />
        <Bars title="What customers love" rows={loves} vocab={vocab.categories} total={positive}
              empty="Nothing positive recorded." />
        <Bars title="Why they didn't buy" rows={barriers} vocab={vocab.barriers} total={total}
              empty="No barriers recorded." />
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value text-lg">{value}</div>
      {hint && <div className="text-[11px] text-subtle num-c">{hint}</div>}
    </div>
  )
}

function Bars({
  title, rows, vocab, total, empty,
}: {
  title: string; rows: [string, number][]; vocab: Vocab[]; total: number; empty?: string
}) {
  return (
    <div className="card card-pad">
      <h2 className="text-[15px] font-medium mb-2">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">{empty ?? "Nothing recorded."}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.slice(0, 8).map(([code, n]) => (
            <div key={code} className="flex items-center gap-2">
              <span className="text-[13px] text-ink flex-1 min-w-0 truncate">
                {label(vocab, code)}
              </span>
              <span className="h-1.5 rounded-full bg-sage" style={{
                width: `${total ? Math.max(6, Math.round((n / total) * 96)) : 0}px`,
              }} />
              <span className="text-xs text-muted num-c w-6 text-right">{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
